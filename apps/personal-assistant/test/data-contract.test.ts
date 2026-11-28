// Milestone 8 data-contract tests:
// 1. Physical isolation between golden evaluation sets (evals/golden/) and daily evidence/sessions/feedback/traces;
// 2. Mandatory hasInterruptPlaceholder: true metadata contract on interrupted trajectories (M6 -> M8);
// 3. Zero model-training / fine-tuning / RL dependencies introduced into @earendil-works/pi-personal-assistant.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	attachSessionAsyncModule,
	createInterruptToolResult,
	ensureValidToolCallPairing,
	INTERRUPT_METADATA_ENTRY_TYPE,
	INTERRUPT_PLACEHOLDER_TEXT,
} from "../src/async/session-async.ts";
import { FeedbackStore } from "../src/commands/feedback.ts";
import { loadAssistantConfig } from "../src/config.ts";
import { TraceStore } from "../src/observability/trace-store.ts";
import { HitlAuditStore } from "../src/tools/hitl.ts";
import { initWorkspace } from "../src/workspace.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GOLDEN_DIR = resolve(APP_ROOT, "evals", "golden");
const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function pathsOverlap(a: string, b: string): boolean {
	const normA = process.platform === "win32" ? resolve(a).toLowerCase() : resolve(a);
	const normB = process.platform === "win32" ? resolve(b).toLowerCase() : resolve(b);
	const relAB = relative(normA, normB);
	const relBA = relative(normB, normA);
	const bInsideA = relAB === "" || (!relAB.startsWith("..") && !isAbsolute(relAB));
	const aInsideB = relBA === "" || (!relBA.startsWith("..") && !isAbsolute(relBA));
	return bInsideA || aInsideB;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M8 Post-training boundary & data contracts", () => {
	it("enforces physical directory isolation between evals/golden/ and daily evidence/sessions/feedback/traces", () => {
		expect(existsSync(GOLDEN_DIR)).toBe(true);
		const goldenBefore = readdirSync(GOLDEN_DIR).sort();

		const root = createTempDir("pa-m8-contract-");
		const config = loadAssistantConfig({
			cwd: root,
			env: { PI_ASSISTANT_WORKSPACE: join(root, "ws") },
		});
		const { paths } = initWorkspace(config.workspace);

		// Verify none of the daily runtime evidence directories overlap with evals/golden/.
		for (const runtimeDir of [
			paths.evidenceDir,
			paths.sessionsDir,
			paths.feedbackDir,
			paths.tracesDir,
			paths.artifactsDir,
		]) {
			expect(pathsOverlap(GOLDEN_DIR, runtimeDir)).toBe(false);
		}

		// Write daily feedback, HITL audit, and trace entries; verify evals/golden/ stays 100% untouched.
		const feedbackStore = new FeedbackStore(paths.feedbackDir);
		feedbackStore.save({
			sessionId: "sess-m8",
			description: "测试反馈不得混入黄金评估集",
			runtime: { config, workspace: paths },
			entries: [],
		});

		const hitlStore = new HitlAuditStore(paths.feedbackDir);
		hitlStore.record({
			sessionId: "sess-m8",
			kind: "approval",
			actionSummary: "测试审批记录",
			approved: false,
			reason: "测试",
		});

		const traceStore = new TraceStore(paths.tracesDir);
		traceStore.append({
			timestamp: "2026-11-28T17:15:00Z",
			sessionId: "sess-m8",
			turnIndex: 1,
			provider: "deepseek",
			model: "deepseek-v4-pro",
			inputTokens: 100,
			outputTokens: 50,
			reasoningTokens: 20,
			cacheReadTokens: 80,
			cacheHitRate: 0.4444,
			durationMs: 300,
			estimatedCostUsd: 0.001,
			toolCalls: [],
			ragQueries: [],
			sidecarBlocks: 0,
			activatedArtifacts: [],
		});

		const goldenAfter = readdirSync(GOLDEN_DIR).sort();
		expect(goldenAfter).toEqual(goldenBefore);
	});

	it("guarantees all interrupted placeholder trajectories carry hasInterruptPlaceholder: true metadata", async () => {
		// 1. Direct synthetic toolResult helper.
		const synthetic = createInterruptToolResult("tc-int-1", "bash");
		expect(synthetic.details?.hasInterruptPlaceholder).toBe(true);
		expect(synthetic.content[0].type === "text" ? synthetic.content[0].text : "").toBe(INTERRUPT_PLACEHOLDER_TEXT);

		// 2. Transcript pairing repair.
		const danglingMessages: AgentMessage[] = [
			{ role: "user", content: "执行长脚本", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tc-int-2", name: "bash", arguments: { command: "sleep 60" } }],
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
			{ role: "user", content: "继续", timestamp: 3 },
		];
		const repaired = ensureValidToolCallPairing(danglingMessages);
		expect(repaired.hasInterruptPlaceholder).toBe(true);
		const repairedToolMsg = repaired.messages[2];
		expect(repairedToolMsg.role).toBe("toolResult");
		if (repairedToolMsg.role === "toolResult") {
			expect((repairedToolMsg.details as { hasInterruptPlaceholder?: boolean })?.hasInterruptPlaceholder).toBe(true);
		}

		// 3. Extension runtime /cancel & aborted tool_result hooks emit hasInterruptPlaceholder: true entries.
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
		const appended: Array<{ customType: string; data: unknown }> = [];

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
			appendEntry(customType: string, data?: unknown) {
				appended.push({ customType, data });
			},
		} as unknown as ExtensionAPI;

		attachSessionAsyncModule(pi);
		const abortCtrl = new AbortController();
		abortCtrl.abort();
		const ctx = {
			hasUI: false,
			signal: abortCtrl.signal,
			isIdle: () => false,
			abort() {},
			ui: { notify() {} },
		} as unknown as ExtensionContext & ExtensionCommandContext;

		for (const h of handlers.get("tool_execution_start") ?? []) {
			await h({ type: "tool_execution_start", toolCallId: "tc-int-3", toolName: "bash", args: {} }, ctx);
		}
		await commands.get("cancel")?.("", ctx);

		let abortedResult: unknown;
		for (const h of handlers.get("tool_result") ?? []) {
			abortedResult = await h(
				{
					type: "tool_result",
					toolCallId: "tc-int-4",
					toolName: "bash",
					input: {},
					content: [{ type: "text", text: "incomplete" }],
					isError: false,
				} as unknown as ToolResultEvent,
				ctx,
			);
		}

		expect(
			(abortedResult as { details?: { hasInterruptPlaceholder?: boolean } })?.details?.hasInterruptPlaceholder,
		).toBe(true);

		const interruptEntries = appended.filter((e) => e.customType === INTERRUPT_METADATA_ENTRY_TYPE);
		expect(interruptEntries.length).toBeGreaterThanOrEqual(2);
		for (const entry of interruptEntries) {
			expect((entry.data as { hasInterruptPlaceholder?: boolean }).hasInterruptPlaceholder).toBe(true);
		}
	});

	it("confirms zero model-training, fine-tuning, or RL dependencies in package.json", () => {
		const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		};

		const allDeps = [
			...Object.keys(manifest.dependencies ?? {}),
			...Object.keys(manifest.devDependencies ?? {}),
			...Object.keys(manifest.optionalDependencies ?? {}),
		].map((name) => name.toLowerCase());

		const forbiddenTrainingDeps = [
			"torch",
			"pytorch",
			"tensorflow",
			"@tensorflow/tfjs",
			"transformers",
			"peft",
			"trl",
			"deepspeed",
			"axolotl",
			"unsloth",
			"lora",
			"bitsandbytes",
			"vllm",
		];

		for (const forbidden of forbiddenTrainingDeps) {
			expect(allDeps.some((dep) => dep === forbidden || dep.includes(forbidden))).toBe(false);
		}
	});
});
