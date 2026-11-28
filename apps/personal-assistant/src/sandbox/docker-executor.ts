// Windows Docker Desktop strong-isolation code execution sandbox with 4 hard boundaries:
// read-only evidence mount, network disabled by default, resource/timeout limits, and zero host secret env leakage.

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";
import type { HitlAuditStore } from "../tools/hitl.ts";
import type { WorkspacePaths } from "../workspace.ts";

export interface DockerSandboxConfig {
	image: string;
	cpus: string;
	memory: string;
	pidsLimit: number;
	defaultTimeoutMs: number;
	maxTimeoutMs: number;
	taskWorkDir: string;
	mountKnowledgeRw: boolean;
}

export interface DockerExecRequest {
	command: string;
	timeoutMs?: number;
	allowNetwork?: boolean;
	containerName?: string;
}

export interface DockerExecResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	containerName: string;
	dockerArgs: string[];
}

export interface DockerProcessRunner {
	run(
		dockerBin: string,
		args: string[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{
		exitCode: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}>;
	killContainer(dockerBin: string, containerName: string): void;
}

export interface AttachDockerSandboxOptions {
	sandboxConfig?: Partial<DockerSandboxConfig>;
	runner?: DockerProcessRunner;
	dockerBin?: string;
}

export const DEFAULT_SANDBOX_IMAGE = "pi-assistant-sandbox:latest";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const TIMEOUT_TAIL_CHARS = 2400;

const SAFE_CONTAINER_ENV: ReadonlyArray<[string, string]> = [
	["PYTHONUTF8", "1"],
	["PYTHONDONTWRITEBYTECODE", "1"],
	["PYTHONUNBUFFERED", "1"],
	["LANG", "C.UTF-8"],
	["LC_ALL", "C.UTF-8"],
	["HOME", "/tmp"],
];

const SandboxBashParams = Type.Object({
	command: Type.String({
		description: "在隔离 Docker 沙箱容器内执行的 Shell 命令（/workspace 可写，/evidence 只读，默认断网）",
	}),
	timeout: Type.Optional(
		Type.Number({ description: "命令超时秒数，默认 60 秒，上限 300 秒", minimum: 1, maximum: 300 }),
	),
	allow_network: Type.Optional(
		Type.Boolean({ description: "是否请求临时开放网络（默认 false 断网，设为 true 将强制触发人工两段式确认）" }),
	),
});

/** Normalize a Windows or POSIX host path into a clean Docker Desktop bind-mount path (forward slashes). */
export function toDockerHostPath(hostPath: string): string {
	if (hostPath.includes("\0")) {
		throw new Error("Host path contains illegal null byte.");
	}
	return resolve(hostPath).replace(/\\/g, "/");
}

/** Map a host path inside workspace/evidence/knowledge to its corresponding Linux path inside the container. */
export function mapHostToContainerPath(
	hostPath: string,
	mounts: { taskWorkDir: string; evidenceDir: string; knowledgeDir?: string },
): string | undefined {
	const resolved = resolve(hostPath);
	const pairs: Array<{ host: string; container: string }> = [
		{ host: resolve(mounts.taskWorkDir), container: "/workspace" },
		{ host: resolve(mounts.evidenceDir), container: "/evidence" },
		...(mounts.knowledgeDir ? [{ host: resolve(mounts.knowledgeDir), container: "/knowledge" }] : []),
	];

	for (const pair of pairs) {
		const normTarget = process.platform === "win32" ? resolved.toLowerCase() : resolved;
		const normParent = process.platform === "win32" ? pair.host.toLowerCase() : pair.host;
		const rel = relative(normParent, normTarget);
		if (rel === "") return pair.container;
		if (!rel.startsWith("..") && !isAbsolute(rel)) {
			const cleanRel = relative(pair.host, resolved).replace(/\\/g, "/");
			return `${pair.container}/${cleanRel}`;
		}
	}
	return undefined;
}

/** Map a container path (/workspace/..., /evidence/..., /knowledge/...) back to a host path. */
export function mapContainerToHostPath(
	containerPath: string,
	mounts: { taskWorkDir: string; evidenceDir: string; knowledgeDir?: string },
): string | undefined {
	const normalized = containerPath.replace(/\\/g, "/");
	const pairs: Array<{ prefix: string; host: string }> = [
		{ prefix: "/workspace", host: resolve(mounts.taskWorkDir) },
		{ prefix: "/evidence", host: resolve(mounts.evidenceDir) },
		...(mounts.knowledgeDir ? [{ prefix: "/knowledge", host: resolve(mounts.knowledgeDir) }] : []),
	];

	for (const pair of pairs) {
		if (normalized === pair.prefix) return pair.host;
		if (normalized.startsWith(`${pair.prefix}/`)) {
			const sub = normalized.slice(pair.prefix.length + 1);
			const candidate = resolve(pair.host, sub);
			const rel = relative(pair.host, candidate);
			if (!rel.startsWith("..") && !isAbsolute(rel)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/**
 * Construct hardened `docker run` CLI arguments enforcing all 4 sandbox boundaries:
 * 1. Read-only /evidence mount + isolated writable /workspace (never mounts ~/.ssh or host root);
 * 2. Zero host credential env leakage (only safe UTF-8 env vars);
 * 3. --network=none by default (only bridge when explicitly approved);
 * 4. Strict --cpus, --memory, --pids-limit, --read-only, --cap-drop=ALL, non-root user.
 */
export function buildDockerRunArgs(
	workspace: WorkspacePaths,
	config: DockerSandboxConfig,
	request: DockerExecRequest,
): { args: string[]; containerName: string } {
	const containerName = request.containerName ?? `pa-sandbox-${randomUUID().slice(0, 12)}`;
	const hostTaskDir = toDockerHostPath(config.taskWorkDir);
	const hostEvidenceDir = toDockerHostPath(workspace.evidenceDir);
	const hostRawPdfsDir = toDockerHostPath(workspace.rawPdfsDir);

	const args: string[] = [
		"run",
		"--rm",
		"--init",
		"--name",
		containerName,
		"--network",
		request.allowNetwork ? "bridge" : "none",
		"--cpus",
		config.cpus,
		"--memory",
		config.memory,
		"--pids-limit",
		String(config.pidsLimit),
		"--read-only",
		"--tmpfs",
		"/tmp:rw,noexec,nosuid,size=256m",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"-v",
		`${hostTaskDir}:/workspace:rw`,
		"-v",
		`${hostEvidenceDir}:/evidence:ro`,
	];

	// If user configured an external rawPdfsDir outside evidence/, mount it read-only as well.
	const relRawPdf = relative(resolve(workspace.evidenceDir), resolve(workspace.rawPdfsDir));
	if (relRawPdf.startsWith("..") || isAbsolute(relRawPdf)) {
		args.push("-v", `${hostRawPdfsDir}:/evidence/raw_pdfs:ro`);
	}

	if (config.mountKnowledgeRw) {
		args.push("-v", `${toDockerHostPath(workspace.knowledgeDir)}:/knowledge:rw`);
	}

	for (const [key, value] of SAFE_CONTAINER_ENV) {
		args.push("-e", `${key}=${value}`);
	}

	args.push("-w", "/workspace", config.image, "sh", "-lc", request.command);
	return { args, containerName };
}

/** Windows Docker sandbox executor with deterministic cleanup and structured timeout reporting. */
export class DockerSandboxExecutor {
	private readonly workspace: WorkspacePaths;
	private readonly config: DockerSandboxConfig;
	private readonly dockerBin: string;
	private readonly runner: DockerProcessRunner;

	constructor(
		workspace: WorkspacePaths,
		configOverrides: Partial<DockerSandboxConfig> = {},
		options: { dockerBin?: string; runner?: DockerProcessRunner } = {},
	) {
		this.workspace = workspace;
		this.dockerBin = options.dockerBin ?? "docker";
		this.runner = options.runner ?? defaultDockerProcessRunner;
		this.config = {
			image: configOverrides.image ?? DEFAULT_SANDBOX_IMAGE,
			cpus: configOverrides.cpus ?? "2",
			memory: configOverrides.memory ?? "2g",
			pidsLimit: configOverrides.pidsLimit ?? 128,
			defaultTimeoutMs: configOverrides.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
			maxTimeoutMs: configOverrides.maxTimeoutMs ?? MAX_TIMEOUT_MS,
			taskWorkDir: configOverrides.taskWorkDir ?? resolve(workspace.artifactsDir, "sandbox-workspace"),
			mountKnowledgeRw: configOverrides.mountKnowledgeRw ?? false,
		};
	}

	/** Return resolved sandbox configuration. */
	getConfig(): Readonly<DockerSandboxConfig> {
		return this.config;
	}

	/** Execute a command inside a fresh ephemeral Docker container with hard isolation boundaries. */
	async execute(request: DockerExecRequest, signal?: AbortSignal): Promise<DockerExecResult> {
		if (!existsSync(this.config.taskWorkDir)) {
			mkdirSync(this.config.taskWorkDir, { recursive: true });
		}

		const timeoutMs = Math.min(
			this.config.maxTimeoutMs,
			Math.max(1000, request.timeoutMs ?? this.config.defaultTimeoutMs),
		);
		const { args, containerName } = buildDockerRunArgs(this.workspace, this.config, request);
		const startedAt = performance.now();

		const outcome = await this.runner.run(this.dockerBin, args, timeoutMs, signal);
		const durationMs = Math.round(performance.now() - startedAt);

		if (outcome.timedOut) {
			this.runner.killContainer(this.dockerBin, containerName);
		}

		return {
			ok: !outcome.timedOut && outcome.exitCode === 0,
			exitCode: outcome.exitCode,
			timedOut: outcome.timedOut,
			stdout: outcome.stdout,
			stderr: outcome.stderr,
			durationMs,
			containerName,
			dockerArgs: args,
		};
	}
}

/** Format a DockerSandboxExecutor result with structured timeout diagnostics and truncated tail output. */
export function formatDockerExecResult(result: DockerExecResult): string {
	if (result.timedOut) {
		const combinedTail = [result.stdout, result.stderr]
			.filter((s) => s.trim().length > 0)
			.join("\n--- stderr ---\n")
			.slice(-TIMEOUT_TAIL_CHARS);
		return [
			`[Docker 沙箱超时终止] 容器 ${result.containerName} 执行超过限时并已强制清理（耗时 ${result.durationMs}ms）。`,
			combinedTail.length > 0 ? `截断尾部输出：\n${combinedTail}` : "(超时前无标准输出)",
		].join("\n\n");
	}

	const parts: string[] = [];
	if (result.stdout.trim().length > 0) {
		parts.push(result.stdout.trimEnd());
	}
	if (result.stderr.trim().length > 0) {
		parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
	}
	if (parts.length === 0) {
		parts.push("(无输出)");
	}
	if (result.exitCode !== 0) {
		parts.push(`Command exited with code ${result.exitCode ?? -1}`);
	}
	return parts.join("\n\n");
}

/** Override `bash` tool to route through Windows Docker sandbox when features.dockerSandbox is enabled. */
export function attachDockerSandboxTool(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	hitlStore: HitlAuditStore,
	options: AttachDockerSandboxOptions = {},
): DockerSandboxExecutor {
	const executor = new DockerSandboxExecutor(runtime.workspace, options.sandboxConfig, {
		dockerBin: options.dockerBin,
		runner: options.runner,
	});

	if (!runtime.config.features.dockerSandbox) {
		return executor;
	}

	pi.registerTool({
		name: "bash",
		label: "Docker Sandbox Bash",
		description:
			"在 Windows Docker 隔离沙箱容器内执行命令或 Python 数据处理脚本（/workspace 可写，/evidence 只读，默认 --network=none 断网，零宿主机凭据注入）。",
		promptSnippet: "在 Docker 隔离沙箱内执行命令与 Python 脚本（默认断网、/evidence 只读）",
		parameters: SandboxBashParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			let allowNetwork = false;
			if (params.allow_network) {
				const decision = await hitlStore.promptForApproval(ctx, {
					sessionId: ctx.sessionManager.getSessionId(),
					kind: "security_confirm",
					actionSummary: "Docker 沙箱请求单次放行网络出口（关闭 --network=none）",
					riskLevel: "high",
					commandPreview: params.command,
				});
				if (!decision.approved) {
					return {
						content: [
							{
								type: "text",
								text: `沙箱联网请求已被用户拒绝（audit_id=${decision.auditId}，原因：${decision.reason ?? "未批准"}）。请保持断网模式或调整方案。`,
							},
						],
						details: { blocked: true, auditId: decision.auditId },
					};
				}
				allowNetwork = true;
			}

			const result = await executor.execute(
				{
					command: params.command,
					timeoutMs: params.timeout !== undefined ? params.timeout * 1000 : undefined,
					allowNetwork,
				},
				signal,
			);

			return {
				content: [{ type: "text", text: formatDockerExecResult(result) }],
				details: {
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
					containerName: result.containerName,
					network: allowNetwork ? "bridge" : "none",
				},
			};
		},
	});

	return executor;
}

const defaultDockerProcessRunner: DockerProcessRunner = {
	run(dockerBin, args, timeoutMs, signal) {
		return new Promise((resolvePromise) => {
			// Pass minimal host environment needed to reach Docker daemon without exposing LLM API keys.
			const cleanHostEnv: NodeJS.ProcessEnv = {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				USERPROFILE: process.env.USERPROFILE,
				HOME: process.env.HOME,
				DOCKER_HOST: process.env.DOCKER_HOST,
				DOCKER_CONFIG: process.env.DOCKER_CONFIG,
			};

			const child = spawn(dockerBin, args, {
				env: cleanHostEnv,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			let stdout = "";
			let stderr = "";
			let timedOut = false;
			let settled = false;

			const finish = (exitCode: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolvePromise({ exitCode, stdout, stderr, timedOut });
			};

			const onAbort = () => {
				timedOut = true;
				child.kill("SIGKILL");
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});
			child.on("error", (err) => {
				stderr += `\nDocker spawn error: ${err.message}`;
				finish(-1);
			});
			child.on("close", (code) => {
				finish(code);
			});
		});
	},
	killContainer(dockerBin, containerName) {
		try {
			execFileSync(dockerBin, ["rm", "-f", containerName], {
				stdio: "ignore",
				timeout: 5000,
			});
		} catch {
			// Container may have already exited.
		}
	},
};
