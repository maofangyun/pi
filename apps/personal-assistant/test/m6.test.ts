// Milestone 6 unit tests: cancel-interrupt unfinished placeholders + M8 hasInterruptPlaceholder contract,
// protocol-valid tool_call/tool_result pairing repair, queued mid-execution [未处理事件 i/N] batching,
// and monitor_shell event-driven background container monitoring.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ContextEvent,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	InputEvent,
	ToolDefinition,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachSessionAsyncModule,
	ensureValidToolCallPairing,
	formatQueuedEventsBatch,
	INTERRUPT_METADATA_ENTRY_TYPE,
	INTERRUPT_PLACEHOLDER_TEXT,
	PendingEventQueue,
} from "../src/async/session-async.ts";
import { loadAssistantConfig } from "../src/config.ts";
import type { AssistantRuntime } from "../src/extension.ts";
import { DockerSandboxExecutor } from "../src/sandbox/docker-executor.ts";
import { HitlAuditStore } from "../src/tools/hitl.ts";
import {
	attachMonitorShellTool,
	type BackgroundJobSpawner,
	type MonitorWakeupEvent,
} from "../src/tools/monitor-shell.ts";
import { initWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createTestRuntime(): AssistantRuntime {
	const root = createTempDir("pa-m6-");
	const config = loadAssistantConfig({
		cwd: root,
		env: { PI_ASSISTANT_WORKSPACE: join(root, "ws") },
	});
	const { paths } = initWorkspace(config.workspace);
	return { config, workspace: paths };
}

function createHarness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const tools = new Map<string, ToolDefinition>();
	const appendedEntries: Array<{ customType: string; data: unknown }> = [];
	const sentMessages: Array<{ message: unknown; options: unknown }> = [];

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
		sendMessage(message: unknown, options?: unknown) {
			sentMessages.push({ message, options });
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		appendedEntries,
		sentMessages,
		async emit(event: string, payload: unknown, ctx: unknown) {
			let last: unknown;
			for (const h of handlers.get(event) ?? []) {
				const res = await h(payload, ctx);
				if (res !== undefined) last = res;
			}
			return last;
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			const fn = commands.get(name);
			if (!fn) throw new Error(`Missing command: ${name}`);
			await fn(args, ctx);
		},
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing tool: ${name}`);
			return tool;
		},
	};
}

function createMockCtx(options: {
	cwd: string;
	idle?: boolean;
	aborted?: boolean;
	selectAnswer?: string;
	onAbort?: () => void;
}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const controller = new AbortController();
	if (options.aborted) controller.abort();

	const ctx = {
		cwd: options.cwd,
		hasUI: true,
		signal: options.aborted ? controller.signal : undefined,
		isIdle: () => options.idle ?? false,
		abort() {
			options.onAbort?.();
		},
		ui: {
			async select() {
				return options.selectAnswer;
			},
			async input() {
				return "";
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		sessionManager: {
			getSessionId: () => "sess-m6",
		},
	} as unknown as ExtensionContext & ExtensionToolContext & ExtensionCommandContext;

	return { ctx, notifications };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M6 Session async queue & cancel-interrupt placeholders", () => {
	it("queues mid-execution user supplements and flushes them as numbered [未处理事件 i/N] batch at turn_end safe point", async () => {
		const queue = new PendingEventQueue();
		queue.enqueue("第一条约束", "user", new Date("2026-11-28T17:10:00+08:00").getTime());
		queue.enqueue("第二条约束", "user", new Date("2026-11-28T17:10:05+08:00").getTime());
		const formatted = formatQueuedEventsBatch(queue.drain());
		expect(formatted).toContain("[未处理事件 1/2]");
		expect(formatted).toContain("[未处理事件 2/2]");

		const harness = createHarness();
		attachSessionAsyncModule(harness.pi);
		const { ctx } = createMockCtx({ cwd: process.cwd(), idle: false });

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
			ctx,
		);

		// Slash commands pass through without queueing.
		const slashRes = await harness.emit(
			"input",
			{ type: "input", text: "/cancel", source: "interactive" } satisfies InputEvent,
			ctx,
		);
		expect(slashRes).toEqual({ action: "continue" });

		// Two user supplements arrive during tool execution -> queued & handled.
		const in1 = await harness.emit(
			"input",
			{ type: "input", text: "请按部门额外分组统计", source: "interactive" } satisfies InputEvent,
			ctx,
		);
		const in2 = await harness.emit(
			"input",
			{ type: "input", text: "所有金额保留两位小数", source: "interactive" } satisfies InputEvent,
			ctx,
		);
		expect(in1).toEqual({ action: "handled" });
		expect(in2).toEqual({ action: "handled" });

		// Safe point: turn_end flushes both numbered events and requests continuation.
		const turnRes = (await harness.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				entries: [],
				continue: false,
				outcome: "completed",
			} as unknown as TurnEndEvent,
			ctx,
		)) as { entries: CustomMessageEntryDraft[]; continue: boolean };

		expect(turnRes.continue).toBe(true);
		expect(turnRes.entries).toHaveLength(1);
		expect(String(turnRes.entries[0].content)).toContain("[未处理事件 1/2]");
		expect(String(turnRes.entries[0].content)).toContain("请按部门额外分组统计");
		expect(String(turnRes.entries[0].content)).toContain("[未处理事件 2/2]");
		expect(String(turnRes.entries[0].content)).toContain("所有金额保留两位小数");
	});

	it("cancels in-flight tools cleanly, repairs dangling toolCall with explicit unfinished placeholder, and records M8 metadata", async () => {
		const harness = createHarness();
		const controller = attachSessionAsyncModule(harness.pi);
		let containerKilled = false;
		let abortedCalled = false;

		const { ctx } = createMockCtx({
			cwd: process.cwd(),
			idle: false,
			onAbort: () => {
				abortedCalled = true;
			},
		});

		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit(
			"tool_execution_start",
			{ type: "tool_execution_start", toolCallId: "tc-long-1", toolName: "bash", args: { command: "sleep 30" } },
			ctx,
		);
		controller.registerInFlightCancel("tc-long-1", () => {
			containerKilled = true;
		});

		// Trigger emergency /cancel.
		await harness.runCommand("cancel", "", ctx);
		expect(containerKilled).toBe(true);
		expect(abortedCalled).toBe(true);

		const interruptEntries = harness.appendedEntries.filter((e) => e.customType === INTERRUPT_METADATA_ENTRY_TYPE);
		expect(interruptEntries).toHaveLength(1);
		expect((interruptEntries[0].data as { hasInterruptPlaceholder?: boolean }).hasInterruptPlaceholder).toBe(true);

		// Verify context hook repairs dangling assistant toolCall before next user turn (prevents DeepSeek 400).
		const brokenTranscript: AgentMessage[] = [
			{ role: "user", content: "运行 30 秒脚本", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-long-1", name: "bash", arguments: { command: "sleep 30" } }],
				api: "openai-completions",
				provider: "deepseek",
				model: "deepseek-v4-pro",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "aborted",
				timestamp: 2,
			},
			{ role: "user", content: "换个更快的方法", timestamp: 3 },
		];

		const pureRepair = ensureValidToolCallPairing(brokenTranscript);
		expect(pureRepair.repairedToolCallIds).toEqual(["tc-long-1"]);
		expect(pureRepair.hasInterruptPlaceholder).toBe(true);
		expect(pureRepair.messages).toHaveLength(4);
		expect(pureRepair.messages[2].role).toBe("toolResult");
		if (pureRepair.messages[2].role === "toolResult") {
			expect(pureRepair.messages[2].toolCallId).toBe("tc-long-1");
			expect(pureRepair.messages[2].isError).toBe(true);
			expect(pureRepair.messages[2].content[0].type === "text" ? pureRepair.messages[2].content[0].text : "").toBe(
				INTERRUPT_PLACEHOLDER_TEXT,
			);
		}

		const ctxRepair = (await harness.emit(
			"context",
			{ type: "context", messages: brokenTranscript } satisfies ContextEvent,
			ctx,
		)) as { messages: AgentMessage[] };
		expect(ctxRepair.messages).toHaveLength(4);

		// Verify aborted tool_result hook normalizes content to unfinished placeholder.
		const { ctx: abortedCtx } = createMockCtx({ cwd: process.cwd(), aborted: true });
		const trRes = (await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "tc-aborted-2",
				toolName: "bash",
				input: {},
				content: [{ type: "text", text: "partial garbage" }],
				isError: false,
			} as unknown as ToolResultEvent,
			abortedCtx,
		)) as {
			content: Array<{ type: string; text: string }>;
			isError: boolean;
			details: { hasInterruptPlaceholder: boolean };
		};

		expect(trRes.isError).toBe(true);
		expect(trRes.content[0].text).toBe(INTERRUPT_PLACEHOLDER_TEXT);
		expect(trRes.details.hasInterruptPlaceholder).toBe(true);
	});
});

describe("M6 monitor_shell background container monitor", () => {
	it("runs background container jobs with event-driven pattern/exit wakeups and clean cancellation", async () => {
		const runtime = createTestRuntime();
		const harness = createHarness();
		const hitl = new HitlAuditStore(runtime.workspace.feedbackDir);
		const dockerExecutor = new DockerSandboxExecutor(runtime.workspace);

		let capturedCallbacks:
			| {
					onChunk: (chunk: string) => void;
					onExit: (code: number | null, timedOut: boolean) => void;
					cancelled: boolean;
					args: string[];
			  }
			| undefined;

		const mockSpawner: BackgroundJobSpawner = {
			spawn(params) {
				const state = {
					onChunk: params.onChunk,
					onExit: params.onExit,
					cancelled: false,
					args: params.args,
				};
				capturedCallbacks = state;
				return {
					cancel() {
						state.cancelled = true;
					},
				};
			},
		};

		const wakeups: MonitorWakeupEvent[] = [];
		const monitor = attachMonitorShellTool(harness.pi, runtime, dockerExecutor, hitl, {
			spawner: mockSpawner,
			onWakeup: (evt) => wakeups.push(evt),
		});

		const tool = harness.getTool("monitor_shell");
		const { ctx } = createMockCtx({ cwd: runtime.workspace.root, selectAnswer: "拒绝 (Reject)" });

		// 1. allow_network=true requires HITL confirmation.
		const netBlocked = await tool.execute(
			"m-net",
			{ action: "start", command: "python sync.py", allow_network: true },
			undefined,
			undefined,
			ctx,
		);
		expect(netBlocked.content[0].type === "text" ? netBlocked.content[0].text : "").toContain("已被用户拒绝");

		// 2. Start default offline background job with watch_patterns.
		const startRes = await tool.execute(
			"m-start",
			{
				action: "start",
				command: "python long_etl.py",
				watch_patterns: ["CHECKPOINT_READY", "FATAL_ERROR"],
			},
			undefined,
			undefined,
			ctx,
		);
		const jobId = (startRes.details as { jobId: string }).jobId;
		expect(capturedCallbacks?.args.join(" ")).toContain("--network none");
		expect(capturedCallbacks?.args.join(" ")).toContain(":/evidence:ro");

		// Normal non-matching output does NOT wake the agent (zero polling/spam).
		capturedCallbacks?.onChunk("processing batch 1...\nprocessing batch 2...\n");
		expect(wakeups).toHaveLength(0);

		// Matching watch_pattern wakes the agent ONCE (deduplicated).
		capturedCallbacks?.onChunk("stage 2: CHECKPOINT_READY rows=5000\n");
		capturedCallbacks?.onChunk("stage 3: CHECKPOINT_READY rows=6000\n");
		expect(wakeups).toHaveLength(1);
		expect(wakeups[0].kind).toBe("pattern_matched");
		expect(wakeups[0].pattern).toBe("CHECKPOINT_READY");
		expect(harness.sentMessages).toHaveLength(1);

		// Status query returns non-blocking tail & matched patterns.
		const statusRes = await tool.execute("m-status", { action: "status", job_id: jobId }, undefined, undefined, ctx);
		expect(statusRes.content[0].type === "text" ? statusRes.content[0].text : "").toContain("CHECKPOINT_READY");

		// Completion triggers final wakeup.
		capturedCallbacks?.onExit(0, false);
		expect(wakeups).toHaveLength(2);
		expect(wakeups[1].kind).toBe("completed");
		expect(monitor.getStatus(jobId)?.status).toBe("completed");

		// 3. Start a second job and cancel it -> cleans up container & emits no further wakeup.
		const start2 = await tool.execute(
			"m-start-2",
			{ action: "start", command: "sleep 600" },
			undefined,
			undefined,
			ctx,
		);
		const jobId2 = (start2.details as { jobId: string }).jobId;
		const cancelRes = await tool.execute("m-cancel", { action: "cancel", job_id: jobId2 }, undefined, undefined, ctx);
		expect(cancelRes.content[0].type === "text" ? cancelRes.content[0].text : "").toContain("已取消后台任务");
		expect(capturedCallbacks?.cancelled).toBe(true);
		expect(monitor.getStatus(jobId2)?.status).toBe("cancelled");
	});
});
