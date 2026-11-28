// Deterministic /doctor and CLI doctor diagnostics checking DeepSeek API, optional cloud APIs,
// local Ollama + 3 models, Docker engine + sandbox image, knowledge Git state, and RAG index integrity.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readKnowledgeGitSummary } from "../context/status-bar.ts";
import type { AssistantRuntime } from "../extension.ts";
import { HybridIndexStore } from "../rag/index-store.ts";
import { OllamaClient, type RagModelClient } from "../rag/ollama-client.ts";
import { DEFAULT_SANDBOX_IMAGE } from "../sandbox/docker-executor.ts";

export type DoctorStatus = "ok" | "warn" | "fail" | "unconfigured";

export interface DoctorCheckItem {
	id: string;
	name: string;
	status: DoctorStatus;
	detail: string;
	fixHint?: string;
}

export interface DoctorReport {
	generatedAt: string;
	overallOk: boolean;
	items: DoctorCheckItem[];
}

export interface RunDoctorOptions {
	env?: NodeJS.ProcessEnv;
	fetchFn?: typeof fetch;
	checkDeepSeekLive?: boolean;
	ollamaClient?: RagModelClient;
	dockerProbe?: () => { daemonRunning: boolean; imageExists: boolean; error?: string };
	sandboxImage?: string;
}

/** Run the deterministic environment health checklist across all assistant subsystems. */
export async function runDoctorChecks(
	runtime: AssistantRuntime,
	options: RunDoctorOptions = {},
): Promise<DoctorReport> {
	const env = options.env ?? process.env;
	const { config, workspace } = runtime;
	const items: DoctorCheckItem[] = [];

	// 1. DeepSeek Main Model API
	const mainKeyEnv = config.models.main.apiKeyEnv;
	const mainKey = env[mainKeyEnv]?.trim();
	if (!mainKey) {
		items.push({
			id: "deepseek",
			name: `主模型 API (${config.models.main.provider}/${config.models.main.model})`,
			status: "fail",
			detail: `环境变量 ${mainKeyEnv} 未设置`,
			fixHint: `在终端或系统环境变量中配置 ${mainKeyEnv}`,
		});
	} else if (options.checkDeepSeekLive) {
		const live = await probeOpenAiCompatibleEndpoint(
			config.models.main.baseUrl ?? "https://api.deepseek.com",
			mainKey,
			options.fetchFn ?? fetch,
		);
		items.push({
			id: "deepseek",
			name: `主模型 API (${config.models.main.provider}/${config.models.main.model})`,
			status: live.ok ? "ok" : "fail",
			detail: live.ok ? `已连通 (${live.detail})` : `连通测试失败：${live.detail}`,
			fixHint: live.ok ? undefined : "请检查网络代理、baseUrl 或 API Key 有效性",
		});
	} else {
		items.push({
			id: "deepseek",
			name: `主模型 API (${config.models.main.provider}/${config.models.main.model})`,
			status: "ok",
			detail: `已检测到 ${mainKeyEnv}（thinking=${config.models.main.thinking}）`,
		});
	}

	// 2. Optional Cloud Providers (vision, judge, search — explicitly allowed to stay unconfigured)
	items.push(
		checkOptionalProvider("vision", "云端视觉 API (analyze_visual)", config.models.vision, env),
		checkOptionalProvider("judge", "异源评估 Judge 模型", config.models.judge, env),
		checkOptionalSearch(config.search, env),
	);

	// 3. Local Ollama + 3 Models (bge-m3, reranker, sidecar)
	const ollama = options.ollamaClient ?? new OllamaClient(config.ollama, { fetchFn: options.fetchFn });
	const ollamaHealth = await ollama.healthCheck();
	if (!ollamaHealth.reachable) {
		items.push({
			id: "ollama",
			name: `本地 Ollama (${config.ollama.baseUrl})`,
			status: "fail",
			detail: `无法连接 Ollama 服务：${ollamaHealth.error ?? "connection refused"}`,
			fixHint: "请启动本机 Ollama 服务（ollama serve），并拉取 bge-m3 / reranker / sidecar 模型",
		});
	} else if (ollamaHealth.missingModels.length > 0) {
		items.push({
			id: "ollama",
			name: `本地 Ollama (${config.ollama.baseUrl})`,
			status: "warn",
			detail: `服务在线，但缺少模型：${ollamaHealth.missingModels.join(", ")}`,
			fixHint: ollamaHealth.missingModels.map((m) => `ollama pull ${m}`).join(" && "),
		});
	} else {
		items.push({
			id: "ollama",
			name: `本地 Ollama (${config.ollama.baseUrl})`,
			status: "ok",
			detail: `服务在线，所需 3 个模型均就绪 (${config.ollama.embedModel}, ${config.ollama.rerankModel}, ${config.ollama.sidecarModel})`,
		});
	}

	// 4. Windows Docker Engine & Sandbox Image
	const sandboxImage = options.sandboxImage ?? DEFAULT_SANDBOX_IMAGE;
	const dockerStatus = options.dockerProbe ? options.dockerProbe() : probeLocalDocker(sandboxImage);
	if (!dockerStatus.daemonRunning) {
		items.push({
			id: "docker",
			name: `Docker 沙箱引擎 (${sandboxImage})`,
			status: config.features.dockerSandbox ? "fail" : "warn",
			detail: `Docker 守护进程不可用：${dockerStatus.error ?? "daemon not running"}`,
			fixHint:
				"请启动 Windows Docker Desktop，或构建沙箱镜像：docker build -t pi-assistant-sandbox:latest apps/personal-assistant/docker/sandbox",
		});
	} else if (!dockerStatus.imageExists) {
		items.push({
			id: "docker",
			name: `Docker 沙箱引擎 (${sandboxImage})`,
			status: "warn",
			detail: `Docker 运行中，但未找到预构建沙箱镜像 ${sandboxImage}`,
			fixHint: `docker build -t ${sandboxImage} apps/personal-assistant/docker/sandbox`,
		});
	} else {
		items.push({
			id: "docker",
			name: `Docker 沙箱引擎 (${sandboxImage})`,
			status: "ok",
			detail: `Docker 引擎在线且沙箱镜像 ${sandboxImage} 已就绪`,
		});
	}

	// 5. Knowledge Git Repository
	const gitSummary = readKnowledgeGitSummary(workspace.knowledgeDir);
	if (!gitSummary) {
		items.push({
			id: "knowledge_git",
			name: "知识库 Git 状态 (knowledge/)",
			status: "fail",
			detail: `${workspace.knowledgeDir} 尚未初始化为 Git 仓库`,
			fixHint: "运行 pi-assistant --init 自动初始化三层工作区与 knowledge/ Git 仓库",
		});
	} else {
		items.push({
			id: "knowledge_git",
			name: "知识库 Git 状态 (knowledge/)",
			status: gitSummary.dirtyCount > 0 ? "warn" : "ok",
			detail: `分支=${gitSummary.branch}，未提交变更=${gitSummary.dirtyCount}`,
			fixHint: gitSummary.dirtyCount > 0 ? "可在确认变更后在 knowledge/ 目录提交快照" : undefined,
		});
	}

	// 6. Local Hybrid RAG Index Integrity
	const hasFts = existsSync(workspace.ftsDbPath);
	const hasVec = existsSync(workspace.vectorsDbPath);
	const hasManifest = existsSync(workspace.manifestPath);
	if (!hasFts || !hasVec || !hasManifest) {
		items.push({
			id: "rag_index",
			name: "本地混合 RAG 索引 (index/)",
			status: "warn",
			detail: `索引尚未完整生成（fts=${hasFts}, vectors=${hasVec}, manifest=${hasManifest}）`,
			fixHint: "在会话中运行 /reindex 构建本地混合检索索引",
		});
	} else {
		const store = new HybridIndexStore(workspace);
		try {
			const count = store.countChunks();
			items.push({
				id: "rag_index",
				name: "本地混合 RAG 索引 (index/)",
				status: "ok",
				detail: `SQLite FTS5 + 向量库完整，当前共 ${count} 个索引块`,
			});
		} catch (error) {
			items.push({
				id: "rag_index",
				name: "本地混合 RAG 索引 (index/)",
				status: "fail",
				detail: `索引文件损坏：${error instanceof Error ? error.message : String(error)}`,
				fixHint: "运行 /reindex --full 清空 index/ 并全量重建",
			});
		} finally {
			store.close();
		}
	}

	const overallOk = !items.some((i) => i.status === "fail");
	return {
		generatedAt: new Date().toISOString(),
		overallOk,
		items,
	};
}

/** Render a concise plain-text table for terminal CLI and TUI notifications. */
export function formatDoctorReport(report: DoctorReport): string {
	const header = `Personal Assistant Doctor (${report.overallOk ? "PASS" : "ISSUES FOUND"})`;
	const lines = [header, ""];
	for (const item of report.items) {
		const badge =
			item.status === "ok"
				? "[OK]"
				: item.status === "warn"
					? "[WARN]"
					: item.status === "unconfigured"
						? "[OPT]"
						: "[FAIL]";
		lines.push(`${badge} ${item.name}: ${item.detail}`);
		if (item.fixHint) {
			lines.push(`      建议: ${item.fixHint}`);
		}
	}
	return lines.join("\n");
}

/** Register the /doctor slash command onto pi's ExtensionAPI. */
export function attachDoctorCommand(pi: ExtensionAPI, runtime: AssistantRuntime, options: RunDoctorOptions = {}): void {
	pi.registerCommand("doctor", {
		description:
			"确定性自检 DeepSeek/可选视觉与Judge/本地 Ollama/Docker 沙箱/知识库 Git 与 RAG 索引状态（加 --live 测 API 连通）",
		handler: async (args, ctx) => {
			const checkDeepSeekLive = args.includes("--live");
			const report = await runDoctorChecks(runtime, { ...options, checkDeepSeekLive });
			const formatted = formatDoctorReport(report);
			if (ctx.hasUI) {
				ctx.ui.notify(formatted, report.overallOk ? "info" : "warning");
			} else {
				console.log(formatted);
			}
		},
	});
}

function checkOptionalProvider(
	id: string,
	name: string,
	cfg: { provider?: string; baseUrl?: string; apiKeyEnv?: string; model?: string } | undefined,
	env: NodeJS.ProcessEnv,
): DoctorCheckItem {
	if (!cfg || (!cfg.baseUrl && !cfg.model)) {
		return {
			id,
			name,
			status: "unconfigured",
			detail: "未配置（可选，按需在 assistant.config.json 中填写）",
		};
	}
	if (cfg.apiKeyEnv && !env[cfg.apiKeyEnv]?.trim()) {
		return {
			id,
			name,
			status: "warn",
			detail: `已配置模型 ${cfg.model ?? "(未填)"}，但缺少环境变量 ${cfg.apiKeyEnv}`,
			fixHint: `设置环境变量 ${cfg.apiKeyEnv}`,
		};
	}
	return {
		id,
		name,
		status: "ok",
		detail: `已配置 ${cfg.provider ?? "custom"}/${cfg.model ?? "(default)"}`,
	};
}

function checkOptionalSearch(
	cfg: { provider?: string; baseUrl?: string; apiKeyEnv?: string } | undefined,
	env: NodeJS.ProcessEnv,
): DoctorCheckItem {
	if (!cfg || !cfg.baseUrl) {
		return {
			id: "search",
			name: "联网搜索后端 (web_search)",
			status: "unconfigured",
			detail: "未配置（可选，按需在 assistant.config.json 中填写 search）",
		};
	}
	if (cfg.apiKeyEnv && !env[cfg.apiKeyEnv]?.trim()) {
		return {
			id: "search",
			name: "联网搜索后端 (web_search)",
			status: "warn",
			detail: `已配置 ${cfg.provider ?? "custom"} (${cfg.baseUrl})，但缺少环境变量 ${cfg.apiKeyEnv}`,
			fixHint: `设置环境变量 ${cfg.apiKeyEnv}`,
		};
	}
	return {
		id: "search",
		name: "联网搜索后端 (web_search)",
		status: "ok",
		detail: `已配置 ${cfg.provider ?? "custom"} (${cfg.baseUrl})`,
	};
}

async function probeOpenAiCompatibleEndpoint(
	baseUrl: string,
	apiKey: string,
	fetchFn: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	try {
		const res = await fetchFn(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(8000),
		});
		return res.ok ? { ok: true, detail: `HTTP ${res.status}` } : { ok: false, detail: `HTTP ${res.status}` };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
}

function probeLocalDocker(imageName: string): { daemonRunning: boolean; imageExists: boolean; error?: string } {
	try {
		execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		return {
			daemonRunning: false,
			imageExists: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		const out = execFileSync("docker", ["images", "-q", imageName], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		return { daemonRunning: true, imageExists: out.length > 0 };
	} catch {
		return { daemonRunning: true, imageExists: false };
	}
}

export function isWorkspaceInitialized(workspaceRoot: string): boolean {
	return (
		existsSync(join(workspaceRoot, "evidence")) &&
		existsSync(join(workspaceRoot, "knowledge")) &&
		existsSync(join(workspaceRoot, "index"))
	);
}
