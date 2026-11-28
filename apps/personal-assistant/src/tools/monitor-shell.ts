// monitor_shell background container task monitor: runs long-running Docker sandbox commands asynchronously
// and wakes the agent ONLY on completion, error/timeout, or matched watch_patterns (zero token-burning polling).

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";
import {
	buildDockerRunArgs,
	type DockerSandboxConfig,
	type DockerSandboxExecutor,
} from "../sandbox/docker-executor.ts";
import type { HitlAuditStore } from "./hitl.ts";

export type MonitorJobStatus = "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface MonitorJobState {
	jobId: string;
	containerName: string;
	command: string;
	status: MonitorJobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	watchPatterns: string[];
	matchedPatterns: string[];
	outputTail: string[];
}

export interface MonitorWakeupEvent {
	kind: "completed" | "failed" | "timed_out" | "pattern_matched";
	jobId: string;
	containerName: string;
	pattern?: string;
	exitCode?: number | null;
	tail: string;
}

export interface BackgroundJobHandle {
	cancel(): void;
}

export interface BackgroundJobSpawner {
	spawn(params: {
		dockerBin: string;
		args: string[];
		containerName: string;
		timeoutMs: number;
		onChunk: (chunk: string) => void;
		onExit: (exitCode: number | null, timedOut: boolean) => void;
	}): BackgroundJobHandle;
}

export interface AttachMonitorShellOptions {
	spawner?: BackgroundJobSpawner;
	dockerBin?: string;
	onWakeup?: (event: MonitorWakeupEvent) => void;
}

const MAX_TAIL_LINES = 40;
const DEFAULT_MONITOR_TIMEOUT_SEC = 300;
const MAX_MONITOR_TIMEOUT_SEC = 1800;

const MonitorShellParams = Type.Object({
	action: Type.Union([Type.Literal("start"), Type.Literal("status"), Type.Literal("cancel"), Type.Literal("list")]),
	command: Type.Optional(Type.String({ description: "action=start 时在 Docker 沙箱后台执行的命令" })),
	job_id: Type.Optional(Type.String({ description: "action=status 或 cancel 时的目标任务 ID" })),
	watch_patterns: Type.Optional(
		Type.Array(Type.String(), { description: "命中后立即唤醒模型的关键输出关键词/正则表达式列表" }),
	),
	timeout: Type.Optional(Type.Number({ description: "最大运行秒数，默认 300，上限 1800", minimum: 5, maximum: 1800 })),
	allow_network: Type.Optional(Type.Boolean({ description: "是否申请放行网络（默认 false 断网，true 需人工确认）" })),
});

/** Manages asynchronous Docker sandbox background jobs with event-driven agent wakeups. */
export class BackgroundShellMonitor {
	private readonly runtime: AssistantRuntime;
	private readonly sandboxConfig: Readonly<DockerSandboxConfig>;
	private readonly dockerBin: string;
	private readonly spawner: BackgroundJobSpawner;
	private readonly onWakeup: (event: MonitorWakeupEvent) => void;
	private readonly jobs = new Map<string, MonitorJobState>();
	private readonly handles = new Map<string, BackgroundJobHandle>();

	constructor(
		runtime: AssistantRuntime,
		sandboxConfig: Readonly<DockerSandboxConfig>,
		options: { dockerBin?: string; spawner?: BackgroundJobSpawner; onWakeup: (event: MonitorWakeupEvent) => void },
	) {
		this.runtime = runtime;
		this.sandboxConfig = sandboxConfig;
		this.dockerBin = options.dockerBin ?? "docker";
		this.spawner = options.spawner ?? defaultBackgroundJobSpawner;
		this.onWakeup = options.onWakeup;
	}

	/** Start a background container job and return immediately without blocking. */
	start(params: {
		command: string;
		watchPatterns?: string[];
		timeoutSec?: number;
		allowNetwork?: boolean;
	}): MonitorJobState {
		if (!existsSync(this.sandboxConfig.taskWorkDir)) {
			mkdirSync(this.sandboxConfig.taskWorkDir, { recursive: true });
		}

		const jobId = `job-${randomUUID().slice(0, 8)}`;
		const containerName = `pa-bg-${jobId}`;
		const { args } = buildDockerRunArgs(this.runtime.workspace, this.sandboxConfig, {
			command: params.command,
			allowNetwork: params.allowNetwork ?? false,
			containerName,
		});

		const watchPatterns = (params.watchPatterns ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
		const compiledPatterns = watchPatterns.map((raw) => ({
			raw,
			regex: safeCompileRegex(raw),
		}));

		const state: MonitorJobState = {
			jobId,
			containerName,
			command: params.command,
			status: "running",
			startedAt: Date.now(),
			watchPatterns,
			matchedPatterns: [],
			outputTail: [],
		};
		this.jobs.set(jobId, state);

		const timeoutMs =
			Math.min(MAX_MONITOR_TIMEOUT_SEC, Math.max(5, params.timeoutSec ?? DEFAULT_MONITOR_TIMEOUT_SEC)) * 1000;

		const handle = this.spawner.spawn({
			dockerBin: this.dockerBin,
			args,
			containerName,
			timeoutMs,
			onChunk: (chunk) => {
				if (state.status !== "running") return;
				const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
				if (lines.length > 0) {
					state.outputTail.push(...lines);
					if (state.outputTail.length > MAX_TAIL_LINES) {
						state.outputTail.splice(0, state.outputTail.length - MAX_TAIL_LINES);
					}
				}
				for (const item of compiledPatterns) {
					if (state.matchedPatterns.includes(item.raw)) continue;
					if (item.regex.test(chunk)) {
						state.matchedPatterns.push(item.raw);
						this.onWakeup({
							kind: "pattern_matched",
							jobId,
							containerName,
							pattern: item.raw,
							tail: state.outputTail.slice(-15).join("\n"),
						});
					}
				}
			},
			onExit: (exitCode, timedOut) => {
				this.handles.delete(jobId);
				if (state.status === "cancelled") return;
				state.endedAt = Date.now();
				state.exitCode = exitCode;
				if (timedOut) {
					state.status = "timed_out";
				} else if (exitCode === 0) {
					state.status = "completed";
				} else {
					state.status = "failed";
				}
				this.onWakeup({
					kind: state.status,
					jobId,
					containerName,
					exitCode,
					tail: state.outputTail.slice(-20).join("\n"),
				});
			},
		});

		this.handles.set(jobId, handle);
		return { ...state, outputTail: [...state.outputTail], matchedPatterns: [...state.matchedPatterns] };
	}

	/** Inspect current status and recent output tail of a background job. */
	getStatus(jobId: string): MonitorJobState | undefined {
		const state = this.jobs.get(jobId);
		if (!state) return undefined;
		return {
			...state,
			watchPatterns: [...state.watchPatterns],
			matchedPatterns: [...state.matchedPatterns],
			outputTail: [...state.outputTail],
		};
	}

	/** List all tracked background jobs in this session. */
	listJobs(): MonitorJobState[] {
		return [...this.jobs.values()].map((state) => ({
			...state,
			watchPatterns: [...state.watchPatterns],
			matchedPatterns: [...state.matchedPatterns],
			outputTail: [...state.outputTail],
		}));
	}

	/** Cancel a running background job and forcefully remove its container. */
	cancel(jobId: string): { ok: boolean; message: string } {
		const state = this.jobs.get(jobId);
		if (!state) {
			return { ok: false, message: `未找到后台任务 ${jobId}。` };
		}
		if (state.status !== "running") {
			return { ok: true, message: `任务 ${jobId} 当前状态已是 ${state.status}，无需重复取消。` };
		}
		state.status = "cancelled";
		state.endedAt = Date.now();
		const handle = this.handles.get(jobId);
		this.handles.delete(jobId);
		handle?.cancel();
		return {
			ok: true,
			message: `已取消后台任务 ${jobId}（容器 ${state.containerName} 已清理）[后台任务已被取消，未完成]。`,
		};
	}

	/** Cancel all currently running background jobs (called on emergency cancel or session shutdown). */
	cancelAll(): number {
		let count = 0;
		for (const state of this.jobs.values()) {
			if (state.status === "running") {
				this.cancel(state.jobId);
				count += 1;
			}
		}
		return count;
	}
}

/** Register the monitor_shell tool onto pi's ExtensionAPI with event-driven wakeup delivery. */
export function attachMonitorShellTool(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	dockerExecutor: DockerSandboxExecutor,
	hitlStore: HitlAuditStore,
	options: AttachMonitorShellOptions = {},
): BackgroundShellMonitor {
	const monitor = new BackgroundShellMonitor(runtime, dockerExecutor.getConfig(), {
		dockerBin: options.dockerBin,
		spawner: options.spawner,
		onWakeup: (event) => {
			options.onWakeup?.(event);
			const summary = formatWakeupMessage(event);
			pi.sendMessage(
				{
					customType: "monitor-shell-event",
					content: summary,
					display: true,
					details: event,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	pi.registerTool({
		name: "monitor_shell",
		label: "Monitor Shell",
		description:
			"异步启动并监控长耗时 Docker 沙箱后台命令（start/status/cancel/list）；仅在任务完成、报错/超时或命中 watch_patterns 关键词时主动唤醒模型，避免轮询消耗 token。",
		promptSnippet: "异步监控长耗时容器命令（完成/报错/命中关键词时事件唤醒，禁止轮询）",
		parameters: MonitorShellParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				const jobs = monitor.listJobs();
				const text =
					jobs.length === 0
						? "当前会话无后台监控任务。"
						: jobs
								.map(
									(j) =>
										`- [${j.jobId}] status=${j.status} container=${j.containerName} cmd="${j.command.slice(0, 80)}"`,
								)
								.join("\n");
				return { content: [{ type: "text", text }], details: { jobs } };
			}

			if (params.action === "status") {
				if (!params.job_id) {
					return { content: [{ type: "text", text: "错误：action=status 必须提供 job_id。" }], details: {} };
				}
				const st = monitor.getStatus(params.job_id);
				if (!st) {
					return { content: [{ type: "text", text: `未找到后台任务 ${params.job_id}。` }], details: {} };
				}
				const elapsedSec = Math.round(((st.endedAt ?? Date.now()) - st.startedAt) / 1000);
				const text = [
					`任务 ${st.jobId} | status=${st.status} | elapsed=${elapsedSec}s | exitCode=${st.exitCode ?? "N/A"}`,
					st.matchedPatterns.length > 0 ? `已命中关键词: ${st.matchedPatterns.join(", ")}` : "",
					st.outputTail.length > 0 ? `最近输出：\n${st.outputTail.slice(-15).join("\n")}` : "(暂无输出)",
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text }], details: st };
			}

			if (params.action === "cancel") {
				if (!params.job_id) {
					return { content: [{ type: "text", text: "错误：action=cancel 必须提供 job_id。" }], details: {} };
				}
				const res = monitor.cancel(params.job_id);
				return { content: [{ type: "text", text: res.message }], details: res };
			}

			// action === "start"
			if (!params.command || params.command.trim().length === 0) {
				return { content: [{ type: "text", text: "错误：action=start 必须提供 command。" }], details: {} };
			}

			let allowNetwork = false;
			if (params.allow_network) {
				const decision = await hitlStore.promptForApproval(ctx, {
					sessionId: ctx.sessionManager.getSessionId(),
					kind: "security_confirm",
					actionSummary: "后台 monitor_shell 容器请求放行网络出口",
					riskLevel: "high",
					commandPreview: params.command,
				});
				if (!decision.approved) {
					return {
						content: [{ type: "text", text: `后台任务联网请求已被用户拒绝（audit_id=${decision.auditId}）。` }],
						details: { blocked: true, auditId: decision.auditId },
					};
				}
				allowNetwork = true;
			}

			const started = monitor.start({
				command: params.command,
				watchPatterns: params.watch_patterns,
				timeoutSec: params.timeout,
				allowNetwork,
			});

			return {
				content: [
					{
						type: "text",
						text: `已启动后台沙箱任务 ${started.jobId}（容器=${started.containerName}，network=${allowNetwork ? "bridge" : "none"}）。无需轮询，任务在完成、报错或命中 watch_patterns 时会自动唤醒。`,
					},
				],
				details: started,
			};
		},
	});

	pi.on("session_shutdown", () => {
		monitor.cancelAll();
	});

	return monitor;
}

function formatWakeupMessage(event: MonitorWakeupEvent): string {
	const header =
		event.kind === "pattern_matched"
			? `[monitor_shell 关键词唤醒] 任务 ${event.jobId} 命中模式 "${event.pattern}"`
			: `[monitor_shell 任务结束] 任务 ${event.jobId} 状态=${event.kind} (exitCode=${event.exitCode ?? "N/A"})`;
	return event.tail.trim().length > 0 ? `${header}\n最近输出：\n${event.tail}` : header;
}

function safeCompileRegex(pattern: string): RegExp {
	try {
		return new RegExp(pattern, "i");
	} catch {
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	}
}

const defaultBackgroundJobSpawner: BackgroundJobSpawner = {
	spawn({ dockerBin, args, containerName, timeoutMs, onChunk, onExit }) {
		const cleanEnv: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			USERPROFILE: process.env.USERPROFILE,
			HOME: process.env.HOME,
			DOCKER_HOST: process.env.DOCKER_HOST,
			DOCKER_CONFIG: process.env.DOCKER_CONFIG,
		};

		const child = spawn(dockerBin, args, {
			env: cleanEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let finished = false;
		let timedOut = false;

		const killContainer = () => {
			try {
				execFileSync(dockerBin, ["rm", "-f", containerName], { stdio: "ignore", timeout: 5000 });
			} catch {
				// Best-effort cleanup.
			}
		};

		const done = (code: number | null) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (timedOut) killContainer();
			onExit(code, timedOut);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			killContainer();
			done(null);
		}, timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => onChunk(chunk));
		child.stderr?.on("data", (chunk: string) => onChunk(chunk));
		child.on("error", (err) => {
			onChunk(`Docker spawn error: ${err.message}`);
			done(-1);
		});
		child.on("close", (code) => done(code));

		return {
			cancel() {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				child.kill("SIGKILL");
				killContainer();
			},
		};
	},
};
