// Personal Assistant Extension bundle aggregating milestone modules onto pi's ExtensionAPI.

import type {
	ExtensionAPI,
	ExtensionFactory,
	InlineExtension,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { attachSessionAsyncModule, type SessionAsyncController } from "./async/session-async.ts";
import { attachDoctorCommand, type RunDoctorOptions } from "./commands/doctor.ts";
import { attachEvolveModule } from "./commands/evolve.ts";
import { attachFeedbackCommand, type FeedbackStore } from "./commands/feedback.ts";
import { attachPromoteSkillCommand } from "./commands/promote-skill.ts";
import { type AssistantConfig, loadAssistantConfig, type MainModelConfig } from "./config.ts";
import {
	type AttachCompactionOptions,
	attachCompactionModule,
	type CompactionCircuitBreaker,
	type PinStore,
} from "./context/compaction.ts";
import { attachStatusBarModule, type ToolStatsTracker } from "./context/status-bar.ts";
import { attachSystemPromptModule } from "./context/system-prompt.ts";
import { attachTodoModule, type TodoStore } from "./context/todo.ts";
import type { EvolveStateStore } from "./evolve/signal-detector.ts";
import { attachMemoryEventModule, type EventStore } from "./memory/event-store.ts";
import { ProfileStore } from "./memory/profile-store.ts";
import { type AttachTraceOptions, attachTraceModule, type TraceStore } from "./observability/trace-store.ts";
import { type AttachedRagModule, type AttachRagOptions, attachRagModule } from "./rag/tools.ts";
import { type AttachedResilience, attachResilienceModule, type ResilienceOptions } from "./runtime/resilience.ts";
import {
	type AttachDockerSandboxOptions,
	attachDockerSandboxTool,
	type DockerSandboxExecutor,
} from "./sandbox/docker-executor.ts";
import { attachPathGuard, type PathBoundaryPolicy } from "./security/path-guard.ts";
import { attachRollbackGuard, type RollbackBackupStore, type RollbackGuardOptions } from "./security/rollback-guard.ts";
import {
	type AttachSidecarOptions,
	attachSidecarSecurityGuard,
	type SidecarCircuitBreaker,
} from "./security/sidecar.ts";
import { attachHitlTools, type HitlAuditStore } from "./tools/hitl.ts";
import { attachHtmlReportTool } from "./tools/html-report.ts";
import { type AttachMcpProxyOptions, attachMcpProxyTools, type LazyMcpProxy } from "./tools/mcp-proxy.ts";
import {
	type AttachMonitorShellOptions,
	attachMonitorShellTool,
	type BackgroundShellMonitor,
} from "./tools/monitor-shell.ts";
import { attachVisualTool, type VisualToolOptions } from "./tools/visual.ts";
import { attachWebTools, type WebToolsOptions } from "./tools/web.ts";
import { initWorkspace, type WorkspacePaths } from "./workspace.ts";

export interface AssistantRuntime {
	config: AssistantConfig;
	workspace: WorkspacePaths;
}

export interface AssistantExtensionOptions {
	compaction?: AttachCompactionOptions;
	rag?: AttachRagOptions;
	web?: WebToolsOptions;
	visual?: VisualToolOptions;
	mcp?: AttachMcpProxyOptions;
	authorizedTaskDirs?: string[];
	rollback?: Omit<RollbackGuardOptions, "policy">;
	sidecar?: AttachSidecarOptions;
	dockerSandbox?: AttachDockerSandboxOptions;
	resilience?: ResilienceOptions;
	doctor?: RunDoctorOptions;
	monitorShell?: AttachMonitorShellOptions;
	trace?: AttachTraceOptions;
}

export interface AttachedAssistantModules {
	todoStore: TodoStore;
	toolStats: ToolStatsTracker;
	pinStore: PinStore;
	compactionBreaker: CompactionCircuitBreaker;
	profileStore: ProfileStore;
	eventStore: EventStore;
	rag: AttachedRagModule;
	hitlStore: HitlAuditStore;
	mcpProxy: LazyMcpProxy;
	pathPolicy: PathBoundaryPolicy;
	backupStore: RollbackBackupStore;
	sidecarBreaker: SidecarCircuitBreaker;
	dockerExecutor: DockerSandboxExecutor;
	resilience: AttachedResilience;
	sessionAsync: SessionAsyncController;
	shellMonitor: BackgroundShellMonitor;
	traceStore: TraceStore;
	feedbackStore: FeedbackStore;
	evolveStateStore: EvolveStateStore;
}

type ChatProviderModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;

const BUILTIN_DEEPSEEK_MODEL_IDS = new Set(["deepseek-v4-pro", "deepseek-flash"]);

const DEEPSEEK_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens" as const,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek" as const,
	supportsStrictMode: true,
};

const DEEPSEEK_BASE_MODELS: readonly ChatProviderModelConfig[] = [
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: { ...DEEPSEEK_COMPAT, supportsMidConvoSystemMessages: true },
	},
	{
		id: "deepseek-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
		compat: DEEPSEEK_COMPAT,
	},
	{
		id: "deepseek-reasoner",
		name: "DeepSeek Reasoner",
		api: "openai-completions",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 64000,
		compat: DEEPSEEK_COMPAT,
	},
	{
		id: "deepseek-chat",
		name: "DeepSeek Chat",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: DEEPSEEK_COMPAT,
	},
];

/** Register DeepSeek model compatibility when custom model IDs or custom baseUrl are configured. */
export function registerDeepSeekCompatIfNeeded(pi: ExtensionAPI, main: MainModelConfig): boolean {
	if (main.provider !== "deepseek") {
		return false;
	}
	const needsCustomModel = !BUILTIN_DEEPSEEK_MODEL_IDS.has(main.model);
	const needsCustomBaseUrl = main.baseUrl !== undefined;
	if (!needsCustomModel && !needsCustomBaseUrl) {
		return false;
	}

	const models: ChatProviderModelConfig[] = DEEPSEEK_BASE_MODELS.map((model) => ({ ...model }));
	if (!models.some((model) => model.id === main.model)) {
		models.push({
			id: main.model,
			name: main.model,
			api: "openai-completions",
			reasoning: main.thinking !== "off",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32768,
			compat: DEEPSEEK_COMPAT,
		});
	}

	pi.registerProvider("deepseek", {
		name: "DeepSeek",
		baseUrl: main.baseUrl ?? "https://api.deepseek.com",
		apiKey: `$${main.apiKeyEnv}`,
		api: "openai-completions",
		models,
	});
	return true;
}

/** Create the inline extension wired with the resolved assistant runtime. */
export function createPersonalAssistantExtension(
	runtime: AssistantRuntime,
	options?: AssistantExtensionOptions,
): InlineExtension {
	return {
		name: "personal-assistant",
		factory: (pi: ExtensionAPI) => {
			attachAssistantExtension(pi, runtime, options);
		},
	};
}

/** Attach all enabled milestone modules onto pi's ExtensionAPI. */
export function attachAssistantExtension(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options?: AssistantExtensionOptions,
): AttachedAssistantModules {
	// M1: DeepSeek compatibility, status footer, and /assistant-status command.
	registerDeepSeekCompatIfNeeded(pi, runtime.config.models.main);

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const enabledCount = Object.values(runtime.config.features).filter(Boolean).length;
		ctx.ui.setStatus(
			"personal-assistant",
			`assistant | ${runtime.config.models.main.provider}/${runtime.config.models.main.model} | flags ${enabledCount}/5`,
		);
	});

	pi.registerCommand("assistant-status", {
		description: "显示个人助理工作区路径、模型配置、可选外部后端与特性开关状态",
		handler: async (_args, ctx) => {
			const lines = formatAssistantStatus(runtime);
			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				console.log(lines.join("\n"));
			}
		},
	});

	// M5 resilience (initialized early so shutdown death-spiral guard feeds into M3 EventStore).
	const resilience = attachResilienceModule(pi, options?.resilience);

	// M2: Static prefix + <user_profile>, TODO tool + TUI widget, <agent_status>, and L1/L2/L3 compaction.
	attachSystemPromptModule(pi, runtime);
	const todoStore = attachTodoModule(pi, runtime);
	const toolStats = attachStatusBarModule(pi, runtime, todoStore);
	const { pinStore, circuitBreaker } = attachCompactionModule(pi, runtime, todoStore, options?.compaction);

	// M3: Dual-layer memory (YAML Profile + ADD-only JSONL Events) and local Ollama Hybrid RAG.
	const profileStore = new ProfileStore(runtime.workspace.profileDir, runtime.workspace.knowledgeDir);
	const rag = attachRagModule(pi, runtime, options?.rag);
	const eventStore = attachMemoryEventModule(pi, runtime, {
		getTodos: () => todoStore.getItems(),
		isAbnormalShutdown: () => resilience.abnormalExit.isAbnormal(),
	});

	// M4: External web/visual/HITL/lazy MCP tools and 4-layer execution security guards.
	attachWebTools(pi, runtime, options?.web);
	attachVisualTool(pi, runtime, options?.visual);
	const hitlStore = attachHitlTools(pi, runtime);
	const mcpProxy = attachMcpProxyTools(pi, runtime, options?.mcp);
	const pathPolicy = attachPathGuard(pi, runtime, options?.authorizedTaskDirs);
	const backupStore = attachRollbackGuard(pi, runtime, { ...options?.rollback, policy: pathPolicy });
	const sidecarBreaker = attachSidecarSecurityGuard(pi, runtime, hitlStore, options?.sidecar);

	// M5: Windows Docker sandbox, HTML report tool, /doctor, and /promote-skill.
	const dockerExecutor = attachDockerSandboxTool(pi, runtime, hitlStore, options?.dockerSandbox);
	attachHtmlReportTool(pi);
	attachDoctorCommand(pi, runtime, options?.doctor);
	attachPromoteSkillCommand(pi, runtime, hitlStore);

	// M6: Phase 1 in-session async interrupt/queue primitives and monitor_shell background container monitor.
	const sessionAsync = attachSessionAsyncModule(pi);
	const shellMonitor = attachMonitorShellTool(pi, runtime, dockerExecutor, hitlStore, options?.monitorShell);

	// M7: Local observability Trace ledger, /trace, and /feedback failure reflux.
	const traceStore = attachTraceModule(pi, runtime, options?.trace);
	const feedbackStore = attachFeedbackCommand(pi, runtime);

	// M9: Manual /evolve offline continuous evolution loop & zero-LLM signal reminders.
	const evolveStateStore = attachEvolveModule(pi, runtime, {
		feedbackStore,
		hitlStore,
		traceStore,
	});

	return {
		todoStore,
		toolStats,
		pinStore,
		compactionBreaker: circuitBreaker,
		profileStore,
		eventStore,
		rag,
		hitlStore,
		mcpProxy,
		pathPolicy,
		backupStore,
		sidecarBreaker,
		dockerExecutor,
		resilience,
		sessionAsync,
		shellMonitor,
		traceStore,
		feedbackStore,
		evolveStateStore,
	};
}

/** Format a concise diagnostic summary of current runtime configuration. */
export function formatAssistantStatus(runtime: AssistantRuntime): string[] {
	const { config, workspace } = runtime;
	const { features, models, ollama, search } = config;
	return [
		`Workspace: ${workspace.root}`,
		`  evidence/sessions: ${workspace.sessionsDir}`,
		`  knowledge/notes:   ${workspace.notesDir}`,
		`  index:             ${workspace.indexDir}`,
		`Main Model: ${models.main.provider}/${models.main.model} (thinking=${models.main.thinking})`,
		`Optional Backends: vision=${models.vision?.model ?? "未配置"}, judge=${models.judge?.model ?? "未配置"}, search=${search?.provider ?? "未配置"}`,
		`Ollama: ${ollama.baseUrl} (embed=${ollama.embedModel}, rerank=${ollama.rerankModel}, sidecar=${ollama.sidecarModel})`,
		`Feature Flags: statusBar=${features.statusBar}, l2MicroCompact=${features.l2MicroCompact}, reranker=${features.reranker}, sidecar=${features.sidecar}, dockerSandbox=${features.dockerSandbox}`,
	];
}

const defaultExtensionFactory: ExtensionFactory = (pi) => {
	const config = loadAssistantConfig();
	const { paths } = initWorkspace(config.workspace);
	attachAssistantExtension(pi, { config, workspace: paths });
};

export default defaultExtensionFactory;
