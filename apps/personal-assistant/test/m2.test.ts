// Milestone 2 unit tests: CJK token estimator, KV-cache-safe static prefix, TODO widget,
// deterministic <agent_status>, L1 spill + frozen preview, L2 micro-compaction, L3 fidelity + 2-failure breaker,
// lossless search_session_history, and built-in skills validation.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	BeforeAgentStartEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ProjectedSessionEntry,
	SessionBeforeCompactEvent,
	SessionEntry,
	ToolDefinition,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadAssistantConfig } from "../src/config.ts";
import {
	attachCompactionModule,
	CompactionCircuitBreaker,
	extractSourceIndex,
	type FidelityCompactionDetails,
	planL2MicroCompactEdits,
	readRawSessionEntries,
	searchSessionEntries,
	spillLargeToolOutput,
} from "../src/context/compaction.ts";
import { attachStatusBarModule, isAgentStatusMessage } from "../src/context/status-bar.ts";
import {
	attachSystemPromptModule,
	compileStaticUserProfile,
	computePromptPrefixHash,
} from "../src/context/system-prompt.ts";
import { attachTodoModule, TodoStore } from "../src/context/todo.ts";
import { computeUsageRatio, estimateConversationTokens, estimateTextTokens } from "../src/context/token-estimator.ts";
import type { AssistantRuntime } from "../src/extension.ts";
import { initWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createTestRuntime(overrides?: Record<string, string>): AssistantRuntime {
	const root = createTempDir("pa-m2-");
	const config = loadAssistantConfig({
		cwd: root,
		env: {
			PI_ASSISTANT_WORKSPACE: join(root, "ws"),
			...overrides,
		},
	});
	const { paths } = initWorkspace(config.workspace);
	return { config, workspace: paths };
}

interface FakeHarness {
	pi: ExtensionAPI;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown>;
	runCommand(name: string, args: string, ctx: unknown): Promise<void>;
	getTool(name: string): ToolDefinition;
	appendedEntries: Array<{ customType: string; data: unknown }>;
}

function createExtensionHarness(): FakeHarness {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const tools = new Map<string, ToolDefinition>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands.set(name, options.handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType: string, data?: unknown) {
			appendedEntries.push({ customType, data });
		},
		getActiveTools() {
			return [...tools.keys(), "read", "write", "edit", "bash"];
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		appendedEntries,
		async emit(event: string, payload: unknown, ctx: unknown) {
			let lastResult: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const res = await handler(payload, ctx);
				if (res !== undefined) lastResult = res;
			}
			return lastResult;
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			const handler = commands.get(name);
			if (!handler) throw new Error(`Command not registered: ${name}`);
			await handler(args, ctx);
		},
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Tool not registered: ${name}`);
			return tool;
		},
	};
}

function createMockContext(options: {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	entries?: SessionEntry[];
	contextWindow?: number;
	onCompact?: () => void;
}) {
	const widgets = new Map<string, string[] | undefined>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const entries = options.entries ?? [];
	let compactCalls = 0;

	const model = {
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 3, cacheRead: 0.04, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 10000,
		maxTokens: 4096,
	} as unknown as Model<Api>;

	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		mode: "tui",
		model,
		thinkingLevel: "high",
		ui: {
			setWidget(key: string, content: string[] | undefined) {
				widgets.set(key, content);
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-m2-test",
			getSessionFile: () => options.sessionFile,
			getEntries: () => entries,
			getBranch: () => entries,
		},
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key", headers: {} }),
		},
		compact() {
			compactCalls += 1;
			options.onCompact?.();
		},
		getSystemPrompt: () => "STATIC_SYSTEM_PROMPT_CONTENT",
	} as unknown as ExtensionContext & ExtensionCommandContext & ExtensionToolContext;

	return {
		ctx,
		widgets,
		notifications,
		getCompactCalls: () => compactCalls,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M2 CJK token estimator", () => {
	it("weights Chinese characters higher than ASCII chars/4 heuristic", () => {
		const zh = "个人智能体助理上下文工程测试".repeat(10); // 140 CJK chars
		const en = "a".repeat(140); // 140 ASCII chars
		const zhTokens = estimateTextTokens(zh);
		const enTokens = estimateTextTokens(en);

		expect(zhTokens).toBeGreaterThanOrEqual(160);
		expect(enTokens).toBe(35);
		expect(zhTokens).toBeGreaterThan(enTokens * 4);
	});

	it("anchors conversation estimate on last valid assistant usage and adds trailing CJK tokens", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "第一轮提问", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "第一轮回复" }],
				api: "openai-completions",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				usage: {
					input: 3000,
					output: 500,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 3500,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{ role: "user", content: "补充一段很长的中文需求说明".repeat(20), timestamp: 3 },
		];

		const est = estimateConversationTokens(messages);
		expect(est.lastUsageIndex).toBe(1);
		expect(est.usageTokens).toBe(3500);
		expect(est.trailingTokens).toBeGreaterThan(250);
		expect(est.tokens).toBe(est.usageTokens + est.trailingTokens);
		expect(computeUsageRatio(est.tokens, 5000)).toBeGreaterThan(0.72);
	});
});

describe("M2 KV-Cache static prefix and <user_profile>", () => {
	it("compiles only confirmed active YAML profile cards and keeps static prefix 100% invariant within a session", async () => {
		const runtime = createTestRuntime();
		writeFileSync(
			join(runtime.workspace.profileDir, "csv.yaml"),
			[
				"id: pref-csv-export",
				"category: workflow.data_processing",
				"key: csv_export_encoding",
				'value: "导出中文 CSV 默认使用 UTF-8-BOM"',
				'scope: "仅限 CSV 导出"',
				"status: active",
				"confidence: confirmed",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(runtime.workspace.profileDir, "draft.yaml"),
			[
				"id: pref-inferred",
				"category: general",
				"key: tone",
				'value: "未确认推断"',
				'scope: "全局"',
				"status: active",
				"confidence: inferred",
			].join("\n"),
			"utf8",
		);

		const compiled = compileStaticUserProfile(runtime.workspace.profileDir);
		expect(compiled).toContain("UTF-8-BOM");
		expect(compiled).not.toContain("未确认推断");

		const harness = createExtensionHarness();
		attachSystemPromptModule(harness.pi, runtime);
		const { ctx } = createMockContext({ cwd: runtime.workspace.root });

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);

		const turn1Event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "第一轮",
			systemPrompt: "",
			systemPromptOptions: { sections: {} as Record<string, string> },
		} as unknown as BeforeAgentStartEvent;
		await harness.emit("before_agent_start", turn1Event, ctx);
		const hash1 = computePromptPrefixHash(
			`${turn1Event.systemPromptOptions.customPrompt ?? ""}\n${turn1Event.systemPromptOptions.sections.user_profile ?? ""}`,
			["read", "write", "todo"],
		);

		// Mutate disk profile mid-session; KV Cache static prefix must remain byte-identical in the active session!
		writeFileSync(
			join(runtime.workspace.profileDir, "new-card.yaml"),
			[
				"id: pref-new",
				"category: notes",
				"key: format",
				'value: "中途新增卡片"',
				'scope: "仅笔记"',
				"status: active",
				"confidence: confirmed",
			].join("\n"),
			"utf8",
		);

		const turn2Event = {
			type: "before_agent_start",
			messageType: "user",
			prompt: "第二轮",
			systemPrompt: "",
			systemPromptOptions: { sections: {} as Record<string, string> },
		} as unknown as BeforeAgentStartEvent;
		await harness.emit("before_agent_start", turn2Event, ctx);
		const hash2 = computePromptPrefixHash(
			`${turn2Event.systemPromptOptions.customPrompt ?? ""}\n${turn2Event.systemPromptOptions.sections.user_profile ?? ""}`,
			["read", "write", "todo"],
		);

		expect(hash1).toBe(hash2);
		expect(turn2Event.systemPromptOptions.sections.user_profile).not.toContain("中途新增卡片");

		// /snapshot-prompt writes a deterministic file.
		const snapshotOut = join(runtime.workspace.root, "prompt-snap.md");
		await harness.runCommand("snapshot-prompt", snapshotOut, ctx);
		expect(existsSync(snapshotOut)).toBe(true);
		const snapText = readFileSync(snapshotOut, "utf8");
		expect(snapText).toContain("Prefix SHA-256:");
		expect(snapText).toContain("STATIC_SYSTEM_PROMPT_CONTENT");
	});
});

describe("M2 TODO tool, TUI widget, and deterministic <agent_status>", () => {
	it("updates TUI widget in real time and persists externalized todos across reloads", async () => {
		const runtime = createTestRuntime();
		const harness = createExtensionHarness();
		const store = attachTodoModule(harness.pi, runtime);
		const { ctx, widgets } = createMockContext({ cwd: runtime.workspace.root, sessionId: "sess-todo" });

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		const todoTool = harness.getTool("todo");

		await todoTool.execute(
			"tc-1",
			{
				action: "rewrite",
				items: [
					{ id: "t1", title: "清洗财务 CSV", status: "in_progress" },
					{ id: "t2", title: "生成交互式 HTML 报告", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(widgets.get("assistant-todos")).toEqual([
			"TODO (0/2)",
			"  [>] [t1] 清洗财务 CSV",
			"  [ ] [t2] 生成交互式 HTML 报告",
		]);

		await todoTool.execute(
			"tc-2",
			{ action: "update_status", id: "t1", status: "completed" },
			undefined,
			undefined,
			ctx,
		);
		expect(widgets.get("assistant-todos")).toEqual([
			"TODO (1/2)",
			"  [x] [t1] 清洗财务 CSV",
			"  [ ] [t2] 生成交互式 HTML 报告",
		]);

		// Reload in a fresh TodoStore instance to verify disk persistence.
		const reloaded = new TodoStore(runtime.workspace.artifactsDir);
		reloaded.loadSession("sess-todo");
		expect(reloaded.getItems().map((i) => `${i.id}:${i.status}`)).toEqual(["t1:completed", "t2:pending"]);
		expect(store.getStateFilePath()).toContain("todos.json");
	});

	it("appends deterministic <agent_status> only at context tail with consecutive failure alerts and respects ablation flag", async () => {
		const runtime = createTestRuntime();
		const harness = createExtensionHarness();
		const todoStore = new TodoStore(runtime.workspace.artifactsDir, "sess-status");
		todoStore.rewrite([{ id: "t1", title: "核对报表", status: "in_progress" }]);

		let nowMs = new Date("2026-11-28T15:30:00+08:00").getTime();
		attachStatusBarModule(harness.pi, runtime, todoStore, () => new Date(nowMs));
		const { ctx } = createMockContext({ cwd: runtime.workspace.root, sessionId: "sess-status" });

		await harness.emit("before_agent_start", { type: "before_agent_start", messageType: "user" }, ctx);
		nowMs += 45_000;

		// Simulate 2 consecutive failures of bash tool.
		await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "b1",
				toolName: "bash",
				input: {},
				content: [{ type: "text", text: "ModuleNotFoundError: pandas" }],
				isError: true,
			},
			ctx,
		);
		await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "b2",
				toolName: "bash",
				input: {},
				content: [{ type: "text", text: "ModuleNotFoundError: pandas" }],
				isError: true,
			},
			ctx,
		);

		const userMsg: AgentMessage = { role: "user", content: "请继续分析", timestamp: nowMs };
		const ctxResult = (await harness.emit(
			"context",
			{ type: "context", messages: [userMsg] } satisfies ContextEvent,
			ctx,
		)) as { messages: AgentMessage[] };

		expect(ctxResult.messages).toHaveLength(2);
		expect(ctxResult.messages[0]).toEqual(userMsg);
		expect(isAgentStatusMessage(ctxResult.messages[1])).toBe(true);
		const statusText =
			ctxResult.messages[1].role === "user" && Array.isArray(ctxResult.messages[1].content)
				? ctxResult.messages[1].content[0].type === "text"
					? ctxResult.messages[1].content[0].text
					: ""
				: "";
		expect(statusText).toContain("since_last_user_input: 45s");
		expect(statusText).toContain("bash:2(fail=2)");
		expect(statusText).toContain("[告警] 工具 bash 已连续失败 2 次");
		expect(statusText).toContain("核对报表");
		expect(statusText).toContain("knowledge_git: branch=");

		// Verify ablation flag statusBar=false disables injection completely.
		const disabledRuntime = createTestRuntime({ PI_ASSISTANT_FLAG_STATUS_BAR: "0" });
		const disabledHarness = createExtensionHarness();
		attachStatusBarModule(disabledHarness.pi, disabledRuntime, todoStore);
		const disabledResult = await disabledHarness.emit(
			"context",
			{ type: "context", messages: [userMsg] } satisfies ContextEvent,
			ctx,
		);
		expect(disabledResult).toBeUndefined();
	});
});

describe("M2 three-layer compaction (L1 spill, L2 micro-compact, L3 fidelity + circuit breaker) and history search", () => {
	it("L1 spills oversized tool output to disk and freezes preview identically on reuse", () => {
		const runtime = createTestRuntime();
		const small = spillLargeToolOutput({
			artifactsDir: runtime.workspace.artifactsDir,
			sessionId: "sess-l1",
			toolCallId: "tc-small",
			toolName: "read",
			fullText: "short output",
		});
		expect(small).toBeUndefined();

		const bigLines = Array.from(
			{ length: 260 },
			(_, idx) => `第 ${idx + 1} 行数据记录：金额 ${(idx + 1) * 10}.00 元`,
		);
		const bigText = bigLines.join("\n");

		const first = spillLargeToolOutput({
			artifactsDir: runtime.workspace.artifactsDir,
			sessionId: "sess-l1",
			toolCallId: "tc-big",
			toolName: "read",
			fullText: bigText,
		});
		expect(first).toBeDefined();
		expect(first?.reusedFrozen).toBe(false);
		expect(existsSync(first!.artifactPath)).toBe(true);
		expect(readFileSync(first!.artifactPath, "utf8")).toBe(bigText);
		expect(first!.previewText).toContain("HEAD (25 lines)");
		expect(first!.previewText).toContain("TAIL (15 lines)");
		expect(first!.previewText).toContain("第 1 行数据记录");
		expect(first!.previewText).toContain("第 260 行数据记录");

		const second = spillLargeToolOutput({
			artifactsDir: runtime.workspace.artifactsDir,
			sessionId: "sess-l1",
			toolCallId: "tc-big",
			toolName: "read",
			fullText: bigText,
		});
		expect(second?.reusedFrozen).toBe(true);
		expect(second?.previewText).toBe(first?.previewText);
	});

	it("L2 folds stale read-only tool outputs via context_edit without LLM calls while protecting recent turns and pins", () => {
		const runtime = createTestRuntime();
		const entries: ProjectedSessionEntry[] = [];
		const largePayload = "旧轮次只读检索内容详情。".repeat(220);

		for (let turn = 1; turn <= 6; turn++) {
			const userId = `u-${turn}`;
			entries.push({
				sourceEntry: {
					type: "message",
					id: userId,
					parentId: null,
					timestamp: `2026-11-28T10:0${turn}:00Z`,
					message: { role: "user", content: `第 ${turn} 轮问题`, timestamp: turn * 1000 },
				},
				messages: [{ role: "user", content: `第 ${turn} 轮问题`, timestamp: turn * 1000 }],
			});
			const toolEntryId = `tr-${turn}`;
			const toolMsg: AgentMessage = {
				role: "toolResult",
				toolCallId: `call-${turn}`,
				toolName: "read",
				content: [{ type: "text", text: largePayload }],
				isError: false,
				timestamp: turn * 1000 + 100,
			};
			entries.push({
				sourceEntry: {
					type: "message",
					id: toolEntryId,
					parentId: userId,
					timestamp: `2026-11-28T10:0${turn}:01Z`,
					message: toolMsg,
				},
				messages: [toolMsg],
			});
		}

		// Pin turn 1's tool result; only turn 2's tool result should be folded (turns 3-6 are recent 4 turns).
		const plan = planL2MicroCompactEdits({
			contextEntries: entries,
			artifactsDir: runtime.workspace.artifactsDir,
			sessionId: "sess-l2",
			pinnedEntryIds: new Set(["tr-1"]),
			keepRecentTurns: 4,
		});

		expect(plan.edits).toHaveLength(1);
		expect(plan.edits[0].targetId).toBe("tr-2");
		expect(plan.savedTokens).toBeGreaterThan(1000);
		const replacementText =
			plan.edits[0].replacement && Array.isArray(plan.edits[0].replacement.content)
				? plan.edits[0].replacement.content[0].type === "text"
					? plan.edits[0].replacement.content[0].text
					: ""
				: "";
		expect(replacementText).toContain("[L2 已折叠只读工具输出");
		expect(replacementText).toContain("call-2.txt");
	});

	it("L3 preserves pinned verbatim anchors, TODOs, and SourceIndex outside LLM rewriting and triggers 2-failure circuit breaker", async () => {
		const runtime = createTestRuntime();
		const harness = createExtensionHarness();
		const todoStore = new TodoStore(runtime.workspace.artifactsDir, "sess-l3");
		todoStore.rewrite([{ id: "t1", title: "完成季度财报核对", status: "in_progress" }]);

		let capturedInstructions = "";
		let shouldFail = false;

		const { pinStore, circuitBreaker } = attachCompactionModule(harness.pi, runtime, todoStore, {
			summarizer: async (req) => {
				capturedInstructions = req.customInstructions;
				if (shouldFail) {
					throw new Error("simulated provider timeout");
				}
				// Intentionally minimal summary that omits paths & constraints to verify code-mounted fidelity!
				return { text: "## Goal\n完成季度财报整理\n\n## Next Steps\n输出 HTML 报告" };
			},
		});

		const sessionEntries: SessionEntry[] = [
			{
				type: "message",
				id: "e-user-1",
				parentId: null,
				timestamp: "2026-11-28T11:00:00Z",
				message: { role: "user", content: "硬约束：金额必须精确到小数点后两位，严禁修改 raw_pdfs/", timestamp: 1 },
			},
			{
				type: "message",
				id: "e-ast-1",
				parentId: "e-user-1",
				timestamp: "2026-11-28T11:00:05Z",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "knowledge/notes/q4.md" } },
						{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "knowledge/notes/summary.md" } },
						{ type: "toolCall", id: "c3", name: "fetch_url", arguments: { url: "https://example.com/finance" } },
						{
							type: "toolCall",
							id: "c4",
							name: "analyze_visual",
							arguments: { file_path: "evidence/raw_pdfs/q4-report.pdf", page: 14 },
						},
						{ type: "toolCall", id: "c5", name: "bash", arguments: { command: "python bad.py" } },
					],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "e-err-1",
				parentId: "e-ast-1",
				timestamp: "2026-11-28T11:00:06Z",
				message: {
					role: "toolResult",
					toolCallId: "c5",
					toolName: "bash",
					content: [{ type: "text", text: "Command exited with code 2: SyntaxError in bad.py" }],
					isError: true,
					timestamp: 3,
				},
			},
		];

		const { ctx, notifications } = createMockContext({
			cwd: runtime.workspace.root,
			sessionId: "sess-l3",
			entries: sessionEntries,
		});

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await harness.runCommand("pin", "e-user-1", ctx);
		await harness.runCommand("pin", "输出 CSV 必须用 UTF-8-BOM", ctx);
		expect(pinStore.getAll()).toHaveLength(2);

		const compactEvent = {
			type: "session_before_compact",
			branchEntries: sessionEntries,
			reason: "threshold",
			willRetry: false,
			signal: new AbortController().signal,
			preparation: {
				firstKeptEntryId: "e-err-1",
				messagesToSummarize: sessionEntries.filter((e) => e.type === "message").map((e) => e.message),
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 7500,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2048, keepRecentTokens: 1000 },
			},
		} as unknown as SessionBeforeCompactEvent;

		const compactResult = (await harness.emit("session_before_compact", compactEvent, ctx)) as {
			compaction: { summary: string; details: FidelityCompactionDetails };
		};

		expect(capturedInstructions).toContain("完成季度财报核对");
		expect(capturedInstructions).toContain("Failed Attempts");
		expect(compactResult.compaction.summary).toContain("严禁修改 raw_pdfs/");
		expect(compactResult.compaction.summary).toContain("输出 CSV 必须用 UTF-8-BOM");
		expect(compactResult.compaction.summary).toContain("knowledge/notes/q4.md");
		expect(compactResult.compaction.summary).toContain("knowledge/notes/summary.md");
		expect(compactResult.compaction.summary).toContain("https://example.com/finance");
		expect(compactResult.compaction.summary).toContain("evidence/raw_pdfs/q4-report.pdf#p14");
		expect(compactResult.compaction.summary).toContain("python bad.py");
		expect(compactResult.compaction.summary).toContain("search_session_history");
		expect(compactResult.compaction.details.degraded).toBe(false);

		// Now test 2-failure circuit breaker.
		shouldFail = true;
		await expect(harness.emit("session_before_compact", compactEvent, ctx)).rejects.toThrow(
			"simulated provider timeout",
		);
		expect(circuitBreaker.getConsecutiveFailures()).toBe(1);
		expect(circuitBreaker.isTripped()).toBe(false);

		// 2nd consecutive failure trips breaker and returns degraded deterministic checkpoint.
		const degradedResult = (await harness.emit("session_before_compact", compactEvent, ctx)) as {
			compaction: { summary: string; details: FidelityCompactionDetails };
		};
		expect(circuitBreaker.isTripped()).toBe(true);
		expect(degradedResult.compaction.details.degraded).toBe(true);
		expect(degradedResult.compaction.summary).toContain("熔断降级压缩检查点");
		expect(degradedResult.compaction.summary).toContain("严禁修改 raw_pdfs/");
		expect(degradedResult.compaction.summary).toContain("evidence/raw_pdfs/q4-report.pdf#p14");
		expect(notifications.some((n) => n.type === "warning")).toBe(true);

		// Also verify standalone CompactionCircuitBreaker and extractSourceIndex helpers.
		const standaloneBreaker = new CompactionCircuitBreaker(2);
		expect(standaloneBreaker.recordFailure("e1")).toBe(false);
		expect(standaloneBreaker.recordFailure("e2")).toBe(true);
		const srcIdx = extractSourceIndex(sessionEntries, []);
		expect(srcIdx.pdfPages).toContain("evidence/raw_pdfs/q4-report.pdf#p14");
		expect(srcIdx.failedCommands[0]?.exitCode).toBe(2);
	});

	it("search_session_history recalls lossless archived Chinese turns from raw JSONL", async () => {
		const runtime = createTestRuntime();
		const sessionFile = join(runtime.workspace.sessionsDir, "2026-11-28-test.jsonl");
		const jsonlLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "sess-hist",
				timestamp: "2026-11-28T09:00:00Z",
				cwd: runtime.workspace.root,
			}),
			JSON.stringify({
				type: "message",
				id: "m-1",
				parentId: null,
				timestamp: "2026-11-28T09:01:00Z",
				message: {
					role: "user",
					content: "客户编号 CUST-9981 的增值税发票税率为 6%，必须在附注中单列。",
					timestamp: 1,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "m-2",
				parentId: "m-1",
				timestamp: "2026-11-28T09:02:00Z",
				message: { role: "user", content: "另外帮我看下今天的天气。", timestamp: 2 },
			}),
		];
		mkdirSync(runtime.workspace.sessionsDir, { recursive: true });
		writeFileSync(sessionFile, `${jsonlLines.join("\n")}\n`, "utf8");

		const rawEntries = readRawSessionEntries(sessionFile, []);
		const hits = searchSessionEntries(rawEntries, "CUST-9981 增值税", 5);
		expect(hits).toHaveLength(1);
		expect(hits[0].entryId).toBe("m-1");
		expect(hits[0].snippet).toContain("6%");

		const harness = createExtensionHarness();
		const todoStore = new TodoStore(runtime.workspace.artifactsDir, "sess-hist");
		attachCompactionModule(harness.pi, runtime, todoStore);
		const { ctx } = createMockContext({
			cwd: runtime.workspace.root,
			sessionId: "sess-hist",
			sessionFile,
		});

		const searchTool = harness.getTool("search_session_history");
		const res = await searchTool.execute("tc-search", { query: "CUST-9981 税率" }, undefined, undefined, ctx);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("m-1");
		expect(text).toContain("6%");
	});

	it("proactively triggers L3 compaction at 70%-75% window in turn_end and runs L1 spill hook on tool_result", async () => {
		const runtime = createTestRuntime();
		const harness = createExtensionHarness();
		const todoStore = new TodoStore(runtime.workspace.artifactsDir, "sess-hooks");
		attachCompactionModule(harness.pi, runtime, todoStore);

		const { ctx, getCompactCalls } = createMockContext({
			cwd: runtime.workspace.root,
			sessionId: "sess-hooks",
			contextWindow: 1000,
		});

		// Trigger L1 spill via tool_result hook.
		const huge = "超长输出行\n".repeat(250);
		const toolRes = (await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc-huge-1",
				toolName: "bash",
				input: {},
				content: [{ type: "text", text: huge }],
				isError: false,
			} as unknown as ToolResultEvent,
			ctx,
		)) as { content: Array<{ type: string; text: string }> };

		expect(toolRes.content[0].text).toContain("[L1 输出已落盘冻结");

		// Trigger proactive L3 compaction at >72% window (800 / 1000).
		const turnEndEvent = {
			type: "turn_end",
			turnIndex: 1,
			entries: [],
			continue: false,
			outcome: "completed",
			context: {
				contextEntries: [],
				contextMessages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: "openai-completions",
						provider: "deepseek",
						model: "deepseek-v4-pro",
						usage: {
							input: 750,
							output: 50,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 800,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 1,
					},
				],
				llmMessages: [],
				pendingMessages: [],
				canContinue: true,
			},
		} as unknown as TurnEndEvent;

		await harness.emit("turn_end", turnEndEvent, ctx);
		expect(getCompactCalls()).toBe(1);
	});
});

describe("M2 built-in Agent Skills", () => {
	it("provides valid note-organization and local-data-processing SKILL.md files matching Agent Skills spec", () => {
		const skillsDir = fileURLToPath(new URL("../skills", import.meta.url));
		const dirs = readdirSync(skillsDir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name)
			.sort();

		expect(dirs).toEqual(["local-data-processing", "note-organization"]);

		for (const dirName of dirs) {
			const skillFile = join(skillsDir, dirName, "SKILL.md");
			expect(existsSync(skillFile)).toBe(true);
			const content = readFileSync(skillFile, "utf8");
			const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			expect(match).not.toBeNull();

			const frontmatter = parseYaml(match![1]) as { name?: string; description?: string };
			expect(frontmatter.name).toBe(dirName);
			expect(frontmatter.name).toMatch(/^[a-z0-9-]+$/);
			expect(typeof frontmatter.description).toBe("string");
			expect((frontmatter.description ?? "").length).toBeGreaterThan(20);
			expect((frontmatter.description ?? "").length).toBeLessThanOrEqual(1024);
		}
	});
});
