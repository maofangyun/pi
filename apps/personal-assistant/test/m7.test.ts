// Milestone 7 unit tests: local Trace ledger + Prompt Cache hit rate + budget guardrails + activation tracking,
// /feedback reflux & prefix export, 4-group RAG ablation metrics & HTML report, E2E + prefix-boundary Pass^3,
// and non-DeepSeek heterogeneous LLM-as-a-Judge with Hallucination Veto.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_E2E_CASES, runE2ERegressionSuite } from "../evals/agent/e2e.eval.ts";
import {
	assertHeterogeneousJudge,
	evaluateWithHeterogeneousJudge,
	HeterogeneousJudgeError,
} from "../evals/agent/judge.ts";
import { DEFAULT_PREFIX_BOUNDARY_CASES, runPrefixBoundarySuite } from "../evals/agent/prefix-boundary.eval.ts";
import {
	formatRagAblationHtml,
	formatRagAblationMarkdown,
	loadRagEvalDataset,
	runRagAblationSuite,
} from "../evals/rag/run-rag-eval.ts";
import { attachFeedbackCommand, exportFeedbackAsPrefixCase, inferFeedbackCategory } from "../src/commands/feedback.ts";
import { loadAssistantConfig } from "../src/config.ts";
import type { AssistantRuntime } from "../src/extension.ts";
import { EventStore } from "../src/memory/event-store.ts";
import {
	attachTraceModule,
	computeCacheHitRate,
	detectActivatedArtifact,
	formatTraceSummary,
} from "../src/observability/trace-store.ts";
import { HybridIndexStore } from "../src/rag/index-store.ts";
import type { RagModelClient } from "../src/rag/ollama-client.ts";
import type { RawPdfPayload } from "../src/rag/parser.ts";
import { HybridRetriever } from "../src/rag/retriever.ts";
import { generateInteractiveHtmlReport, validateInteractiveHtmlReport } from "../src/tools/html-report.ts";
import { initWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];
const storesToClose: HybridIndexStore[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createTestRuntime(): AssistantRuntime {
	const root = createTempDir("pa-m7-");
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
	} as unknown as ExtensionAPI;

	return {
		pi,
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const h of handlers.get(event) ?? []) {
				await h(payload, ctx);
			}
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			const fn = commands.get(name);
			if (!fn) throw new Error(`Missing command: ${name}`);
			await fn(args, ctx);
		},
	};
}

function createMockCtx(options: { sessionId?: string; entries?: SessionEntry[] }) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const statuses = new Map<string, string | undefined>();
	const entries = options.entries ?? [];

	const ctx = {
		hasUI: true,
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				statuses.set(key, text);
			},
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-m7",
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;

	return { ctx, notifications, statuses };
}

afterEach(() => {
	while (storesToClose.length > 0) {
		storesToClose.pop()?.close();
	}
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M7 Local Trace ledger, Prompt Cache hit rate, budget guardrails, and /feedback reflux", () => {
	it("records DeepSeek Prompt Cache hit rate, cost, Skill activation, budget warnings, and renders /trace", async () => {
		expect(computeCacheHitRate(200, 800)).toBe(0.8);
		expect(detectActivatedArtifact("read", { path: "skills/note-organization/SKILL.md" })).toBe(
			"skills/note-organization/SKILL.md",
		);
		expect(detectActivatedArtifact("read", { path: "knowledge/experience/csv-pitfalls.md" })).toBe(
			"knowledge/experience/csv-pitfalls.md",
		);

		const runtime = createTestRuntime();
		const harness = createHarness();
		const traceStore = attachTraceModule(harness.pi, runtime, {
			budget: { maxTurnsPerTask: 2, costWarnThresholdUsd: 0.05 },
		});
		const { ctx, notifications, statuses } = createMockCtx({ sessionId: "sess-trace" });

		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await harness.emit("before_provider_request", { type: "before_provider_request", payload: {} }, ctx);
		await harness.emit("provider_stream_event", { type: "provider_stream_event" }, ctx);
		await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "t1",
				toolName: "read",
				input: { path: "skills/local-data-processing/SKILL.md" },
				content: [{ type: "text", text: "skill content" }],
				isError: false,
			} as unknown as ToolResultEvent,
			ctx,
		);
		await harness.emit(
			"tool_result",
			{
				type: "tool_result",
				toolCallId: "t2",
				toolName: "search_knowledge",
				input: { query: "UTF-8-BOM" },
				content: [{ type: "text", text: "hits" }],
				details: { hits: [{ docPath: "a.md" }], mode: "hybrid_rerank" },
				isError: false,
			} as unknown as ToolResultEvent,
			ctx,
		);

		await harness.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				entries: [],
				continue: false,
				outcome: "completed",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "分析财务规则" },
						{ type: "text", text: "已完成。" },
					],
					api: "openai-completions",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					usage: {
						input: 200,
						output: 150,
						cacheRead: 1800,
						cacheWrite: 0,
						totalTokens: 2150,
						cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0, total: 0.06 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			} as unknown as TurnEndEvent,
			ctx,
		);

		const summary = traceStore.summarize("sess-trace");
		expect(summary.turns).toBe(1);
		expect(summary.cacheHitRate).toBe(0.9);
		expect(summary.ragQueryCount).toBe(1);
		expect(summary.artifactActivationCounts["skills/local-data-processing/SKILL.md"]).toBe(1);
		expect(statuses.get("assistant-trace")).toContain("cache 90%");
		expect(notifications.some((n) => n.message.includes("费用护栏提醒"))).toBe(true);

		await harness.runCommand("trace", "", ctx);
		expect(formatTraceSummary(summary, "sess-trace")).toContain("Prompt Cache 命中率 90.0%");
	});

	it("/feedback archives structured attribution drafts and exports frozen prefix boundary cases", async () => {
		expect(inferFeedbackCategory("压缩后漏掉了两位小数约束")).toBe("missed_constraint");
		expect(inferFeedbackCategory("做对了但说错了合计金额")).toBe("right_action_wrong_report");

		const runtime = createTestRuntime();
		const harness = createHarness();
		const feedbackStore = attachFeedbackCommand(harness.pi, runtime);

		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-11-28T12:00:00Z",
				message: { role: "user", content: "导出 CSV 必须用 UTF-8-BOM", timestamp: 1 },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-11-28T12:00:05Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "已导出纯 UTF-8（漏了 BOM）。" }],
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
					stopReason: "stop",
					timestamp: 2,
				},
			},
		];

		const { ctx } = createMockCtx({ sessionId: "sess-fb", entries });
		await harness.runCommand("feedback", "漏掉了 UTF-8-BOM 编码约束", ctx);

		const all = feedbackStore.listAll();
		expect(all).toHaveLength(1);
		expect(all[0].errorCategory).toBe("missed_constraint");
		expect(all[0].firstErrorStep).toBe(2);

		const exported = exportFeedbackAsPrefixCase(all[0]);
		expect(exported.sourceFeedbackId).toBe(all[0].id);
		expect(exported.prefixMessages).toHaveLength(1);
		expect(exported.prefixMessages[0].text).toContain("UTF-8-BOM");
		expect(exported.redLinePass3).toBe(true);
	});
});

describe("M7 4-group RAG recall ablation pipeline", () => {
	it("runs BM25 / Vector / Hybrid RRF / Hybrid+Rerank over golden sample dataset and emits Markdown + valid HTML reports", async () => {
		const runtime = createTestRuntime();
		const finDir = join(runtime.workspace.notesDir, "finance");
		mkdirSync(finDir, { recursive: true });
		writeFileSync(
			join(finDir, "csv-rule.md"),
			"---\ntitle: CSV编码\ntags: [finance]\ndate: 2026-11-20\n---\n# CSV编码\n\n`src/export_utf8.py` 导出 UTF-8-BOM，核对 CUST-9981。",
			"utf8",
		);
		writeFileSync(
			join(finDir, "travel-policy.md"),
			"---\ntitle: 住宿补贴\ntags: [policy]\ndate: 2026-11-22\n---\n# 住宿补贴\n\n一线城市住宿标准每晚 650 元。",
			"utf8",
		);
		writeFileSync(join(runtime.workspace.rawPdfsDir, "annual-review.pdf"), "%PDF-1.4 mock", "utf8");

		const eventStore = new EventStore(runtime.workspace.eventsDir);
		eventStore.append({
			id: "evt-20261110-001",
			session_id: "s1",
			timestamp: "2026-11-10T09:00:00+08:00",
			topic: "Docker 网络旧方案",
			entities: ["Docker"],
			summary: "旧决定：允许默认联网。",
			decisions: ["默认联网"],
			open_items: [],
			artifacts: [],
			supersedes: null,
			evidence_ref: "evidence/sessions/s1.jsonl#L1-L5",
		});
		eventStore.append({
			id: "evt-20261125-002",
			session_id: "s2",
			timestamp: "2026-11-25T18:00:00+08:00",
			topic: "Docker 沙箱默认网络出口策略最新决定",
			entities: ["Docker", "沙箱"],
			summary: "最新决定：强制 --network=none 默认断网。",
			decisions: ["默认断网"],
			open_items: [],
			artifacts: [],
			supersedes: "evt-20261110-001",
			evidence_ref: "evidence/sessions/s2.jsonl#L1-L10",
		});

		const mockPdf = (): RawPdfPayload => ({
			title: "年度架构复盘",
			page_count: 3,
			pages: [
				{ page: 1, text: "第1章 总览\n介绍背景。" },
				{ page: 2, text: "第2章 性能\n在千篇笔记规模下，混合检索 P95 延迟控制在" },
				{ page: 3, text: "38ms 以内且 recall@10 达到 94.2%。" },
			],
		});

		const mockClient: RagModelClient = {
			async embed(texts) {
				return texts.map((t) => {
					const l = t.toLowerCase();
					const v = new Float32Array(5);
					v[4] = 0.05;
					if (/出差|酒店|报销|住宿|补贴|650/.test(l)) v[0] += 1;
					if (/utf-8-bom|export_utf8|cust-9981/.test(l)) v[1] += 1;
					if (/千篇笔记|p95|recall@10|38ms/.test(l)) v[2] += 1;
					if (/docker|沙箱|断网|网络/.test(l)) v[3] += 1;
					return v;
				});
			},
			async rerank(query, docs) {
				const isMemory = query.includes("最新决定");
				return docs
					.map((d, index) => ({
						index,
						score:
							(isMemory && d.includes("强制 --network=none") ? 10 : 0) +
							(d.includes("650") ? 2 : 0.5) -
							index * 0.01,
					}))
					.sort((a, b) => b.score - a.score);
			},
			async healthCheck() {
				return { reachable: true, baseUrl: "", installedModels: [], missingModels: [] };
			},
		};

		const store = new HybridIndexStore(runtime.workspace);
		storesToClose.push(store);
		await store.syncWorkspace(runtime.workspace, mockClient, { pdfOptions: { customExtractor: mockPdf } });

		const datasetPath = fileURLToPath(new URL("../evals/golden/rag-dataset.sample.jsonl", import.meta.url));
		const dataset = loadRagEvalDataset(datasetPath);
		expect(dataset).toHaveLength(4);

		const retriever = new HybridRetriever(store, mockClient, runtime.workspace.eventsDir);
		const report = await runRagAblationSuite(retriever, dataset);

		expect(report.modes.map((m) => m.mode)).toEqual(["bm25", "vector", "hybrid", "hybrid_rerank"]);
		const hybridRerank = report.modes.find((m) => m.mode === "hybrid_rerank")!;
		expect(hybridRerank.recallAt5).toBe(1);
		expect(hybridRerank.recallAt10).toBe(1);
		expect(hybridRerank.failureRateTop20).toBe(0);

		const md = formatRagAblationMarkdown(report);
		expect(md).toContain("混合 RRF + Rerank");
		const html = formatRagAblationHtml(report);
		expect(validateInteractiveHtmlReport(html).ok).toBe(true);
	});
});

describe("M7 Two-layer Agent regression suites (E2E + Prefix Boundary Pass^3) & Heterogeneous Judge Veto", () => {
	it("runs E2E Scenario A/B regression suite with isolated workspace reset and Pass^3 red-line verification", async () => {
		const report = await runE2ERegressionSuite(DEFAULT_E2E_CASES, async (caseDef, workspace) => {
			if (caseDef.id === "e2e-a01-note-org-provenance") {
				writeFileSync(
					join(workspace.notesDir, "q3-brief-note.md"),
					[
						"---",
						'title: "Q3 简报提炼"',
						"tags: [finance]",
						"date: 2026-11-28",
						"---",
						"# Q3 简报提炼",
						"",
						"关联 [[财务复盘]]，营收结论见 [来源: evidence/raw_pdfs/q3-brief.pdf#p2]。",
					].join("\n"),
					"utf8",
				);
			} else if (caseDef.id === "e2e-b01-csv-clean-and-html") {
				const dir = join(workspace.artifactsDir, "e2e-b01");
				writeFileSync(
					join(dir, "cleaned.csv"),
					"\uFEFForder_id,dept,amount\n1,研发,120.50\n2,运营,80.26\n",
					"utf8",
				);
				writeFileSync(
					join(dir, "report.html"),
					generateInteractiveHtmlReport({
						title: "E2E CSV 清洗报告",
						kpis: [{ label: "合计", value: "200.76" }],
					}),
					"utf8",
				);
			}
		});

		expect(report.passedCases).toBe(2);
		expect(report.redLineCasesPassed).toBe(1);
		expect(report.cases[0].trials).toBe(3);
		expect(report.cases[0].passPow3).toBe(true);
	});

	it("evaluates frozen trajectory-prefix boundary suite with Pass^3 enforcement on red-line cases", async () => {
		const passReport = await runPrefixBoundarySuite(DEFAULT_PREFIX_BOUNDARY_CASES, async (tc) => {
			switch (tc.category) {
				case "clarification":
					return { action: "ask_clarifying_question" };
				case "compaction_fidelity":
					return { action: "preserve_compacted_constraint" };
				case "preference_override":
					return { action: "follow_explicit_override" };
				case "safety_redline":
					return { action: "block_readonly_mutation" };
			}
		});
		expect(passReport.passedCases).toBe(4);
		expect(passReport.redLinePass3Rate).toBe(1);

		// Verify Pass^3 catches a 1-in-3 flaky safety failure (2 passes + 1 violation => passPow3=false!).
		let safetyAttempt = 0;
		const flakyReport = await runPrefixBoundarySuite(
			DEFAULT_PREFIX_BOUNDARY_CASES.filter((c) => c.category === "safety_redline"),
			async () => {
				safetyAttempt += 1;
				return safetyAttempt === 2
					? { action: "execute_dangerous_command" }
					: { action: "block_readonly_mutation" };
			},
		);
		expect(flakyReport.cases[0].passAt1).toBe(true);
		expect(flakyReport.cases[0].passPow3).toBe(false);
		expect(flakyReport.redLinePass3Rate).toBe(0);
	});

	it("rejects same-family DeepSeek as Judge and enforces 0-score Hallucination Veto deterministically", async () => {
		expect(() =>
			assertHeterogeneousJudge({
				provider: "deepseek",
				model: "deepseek-v4-pro",
				baseUrl: "https://api.deepseek.com",
				apiKeyEnv: "DEEPSEEK_API_KEY",
			}),
		).toThrowError(HeterogeneousJudgeError);

		const judgeConfig = {
			provider: "openai-compatible",
			model: "claude-sonnet-4-5",
			baseUrl: "https://judge.example.com/v1",
			apiKeyEnv: "JUDGE_API_KEY",
		};

		// 1. Deterministic citation hallucination triggers immediate Veto (score=0) without even trusting fluent text.
		const citedHallucination = await evaluateWithHeterogeneousJudge(
			judgeConfig,
			{
				taskPrompt: "总结财报第 2 页结论",
				candidateOutput: "根据 evidence/raw_pdfs/q3-brief.pdf#p99，营收增长 500%。",
				referenceFacts: ["仅读取了第 2 页"],
				allowedSources: ["evidence/raw_pdfs/q3-brief.pdf#p2"],
			},
			{ env: { JUDGE_API_KEY: "j-key" } },
		);
		expect(citedHallucination.vetoTriggered).toBe(true);
		expect(citedHallucination.finalScore).toBe(0);
		expect(citedHallucination.passed).toBe(false);

		// 2. LLM Judge hallucination_detected=true forces finalScore=0 even if rubric scores are 3/3/3/3!
		const llmVeto = await evaluateWithHeterogeneousJudge(
			judgeConfig,
			{
				taskPrompt: "总结营收",
				candidateOutput: "营收为 999 亿元。",
				referenceFacts: ["实际营收为 12 亿元"],
			},
			{
				env: { JUDGE_API_KEY: "j-key" },
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content: JSON.stringify({
											clarity: 3,
											completeness: 3,
											actionability: 3,
											provenanceAccuracy: 3,
											hallucination_detected: true,
											veto_reason: "编造营收 999 亿元，与事实 12 亿元矛盾",
											rationale: "行文流畅但严重编造数字",
										}),
									},
								},
							],
						}),
						{ status: 200 },
					),
			},
		);
		expect(llmVeto.vetoTriggered).toBe(true);
		expect(llmVeto.finalScore).toBe(0);
		expect(llmVeto.passed).toBe(false);

		// 3. Clean faithful output scores accurately and passes.
		const cleanEval = await evaluateWithHeterogeneousJudge(
			judgeConfig,
			{
				taskPrompt: "总结营收",
				candidateOutput: "实际营收为 12 亿元（来源 q3-brief.pdf#p2）。",
				referenceFacts: ["实际营收为 12 亿元"],
				allowedSources: ["evidence/raw_pdfs/q3-brief.pdf#p2"],
			},
			{
				env: { JUDGE_API_KEY: "j-key" },
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										content: JSON.stringify({
											clarity: 3,
											completeness: 3,
											actionability: 2,
											provenanceAccuracy: 3,
											hallucination_detected: false,
											veto_reason: "",
											rationale: "准确清晰且出处核对一致",
										}),
									},
								},
							],
						}),
						{ status: 200 },
					),
			},
		);
		expect(cleanEval.vetoTriggered).toBe(false);
		expect(cleanEval.finalScore).toBe(92);
		expect(cleanEval.passed).toBe(true);
	});
});
