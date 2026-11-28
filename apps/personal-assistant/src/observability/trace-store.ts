// Local observability ledger (evidence/traces/YYYY-MM.jsonl): token/cache hit rate, TTFT,
// estimated cost, tool & RAG metrics, Sidecar blocks, Skill/experience activation tracking, and budget guardrails.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantRuntime } from "../extension.ts";

export interface TraceToolCallStat {
	name: string;
	ok: boolean;
}

export interface TraceRagQueryStat {
	tool: "search_knowledge" | "search_memory";
	query: string;
	hitCount: number;
	mode?: string;
}

export interface TraceTurnRecord {
	id: string;
	timestamp: string;
	sessionId: string;
	turnIndex: number;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheHitRate: number;
	ttftMs?: number;
	durationMs: number;
	estimatedCostUsd: number;
	toolCalls: TraceToolCallStat[];
	ragQueries: TraceRagQueryStat[];
	sidecarBlocks: number;
	activatedArtifacts: string[];
}

export interface TraceSummary {
	turns: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheHitRate: number;
	avgTtftMs: number | null;
	totalDurationMs: number;
	estimatedCostUsd: number;
	totalToolCalls: number;
	toolSuccessRate: number;
	ragQueryCount: number;
	sidecarBlocks: number;
	artifactActivationCounts: Record<string, number>;
}

export interface TraceBudgetConfig {
	maxTurnsPerTask: number;
	costWarnThresholdUsd: number;
}

export interface AttachTraceOptions {
	budget?: Partial<TraceBudgetConfig>;
}

const DEFAULT_BUDGET: TraceBudgetConfig = {
	maxTurnsPerTask: 25,
	costWarnThresholdUsd: 1.0,
};

/** Compute Prompt Cache hit rate safely as cacheRead / (input + cacheRead). */
export function computeCacheHitRate(inputTokens: number, cacheReadTokens: number): number {
	const denom = inputTokens + cacheReadTokens;
	if (denom <= 0) return 0;
	return Math.round((cacheReadTokens / denom) * 10_000) / 10_000;
}

/** Detect whether a read/tool path activates a Skill SKILL.md or knowledge/experience/*.md document. */
export function detectActivatedArtifact(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName !== "read") return undefined;
	const rawPath = typeof input.path === "string" ? input.path : undefined;
	if (!rawPath) return undefined;
	const normalized = rawPath.replace(/\\/g, "/");
	if (/(?:^|\/)skills\/[^/]+\/SKILL\.md$/i.test(normalized)) {
		return normalized;
	}
	if (/(?:^|\/)knowledge\/experience\/[^/]+\.md$/i.test(normalized)) {
		return normalized;
	}
	return undefined;
}

/** Append-only monthly JSONL Trace ledger stored under evidence/traces/YYYY-MM.jsonl. */
export class TraceStore {
	private readonly tracesDir: string;
	private seq = 0;

	constructor(tracesDir: string) {
		this.tracesDir = tracesDir;
	}

	/** Append a completed turn trace record to its monthly JSONL file. */
	append(record: Omit<TraceTurnRecord, "id"> & { id?: string }): TraceTurnRecord {
		mkdirSync(this.tracesDir, { recursive: true });
		this.seq += 1;
		const full: TraceTurnRecord = {
			...record,
			id: record.id ?? `tr-${Date.now()}-${this.seq}`,
		};
		const month = full.timestamp.slice(0, 7) || new Date().toISOString().slice(0, 7);
		appendFileSync(join(this.tracesDir, `${month}.jsonl`), `${JSON.stringify(full)}\n`, "utf8");
		return full;
	}

	/** Load all recorded trace turns chronologically across all monthly files. */
	loadAll(): TraceTurnRecord[] {
		if (!existsSync(this.tracesDir)) return [];
		const files = readdirSync(this.tracesDir)
			.filter((f) => f.endsWith(".jsonl"))
			.sort((a, b) => a.localeCompare(b));
		const out: TraceTurnRecord[] = [];
		for (const file of files) {
			const lines = readFileSync(join(this.tracesDir, file), "utf8").split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					out.push(JSON.parse(trimmed) as TraceTurnRecord);
				} catch {
					// Ignore malformed trace line.
				}
			}
		}
		return out;
	}

	/** Aggregate metrics across all turns or a single sessionId. */
	summarize(sessionId?: string): TraceSummary {
		const records = sessionId ? this.loadAll().filter((r) => r.sessionId === sessionId) : this.loadAll();
		return summarizeTraceRecords(records);
	}
}

/** Pure aggregation helper computing cache hit rate, cost, tool reliability, and artifact activations. */
export function summarizeTraceRecords(records: readonly TraceTurnRecord[]): TraceSummary {
	let inputTokens = 0;
	let outputTokens = 0;
	let reasoningTokens = 0;
	let cacheReadTokens = 0;
	let totalDurationMs = 0;
	let estimatedCostUsd = 0;
	let totalToolCalls = 0;
	let okToolCalls = 0;
	let ragQueryCount = 0;
	let sidecarBlocks = 0;
	const ttfts: number[] = [];
	const artifactActivationCounts: Record<string, number> = {};

	for (const rec of records) {
		inputTokens += rec.inputTokens;
		outputTokens += rec.outputTokens;
		reasoningTokens += rec.reasoningTokens;
		cacheReadTokens += rec.cacheReadTokens;
		totalDurationMs += rec.durationMs;
		estimatedCostUsd += rec.estimatedCostUsd;
		if (typeof rec.ttftMs === "number") ttfts.push(rec.ttftMs);
		for (const tc of rec.toolCalls) {
			totalToolCalls += 1;
			if (tc.ok) okToolCalls += 1;
		}
		ragQueryCount += rec.ragQueries.length;
		sidecarBlocks += rec.sidecarBlocks;
		for (const art of rec.activatedArtifacts) {
			artifactActivationCounts[art] = (artifactActivationCounts[art] ?? 0) + 1;
		}
	}

	const avgTtftMs = ttfts.length > 0 ? Math.round(ttfts.reduce((sum, v) => sum + v, 0) / ttfts.length) : null;

	return {
		turns: records.length,
		inputTokens,
		outputTokens,
		reasoningTokens,
		cacheReadTokens,
		cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
		avgTtftMs,
		totalDurationMs,
		estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
		totalToolCalls,
		toolSuccessRate: totalToolCalls > 0 ? Math.round((okToolCalls / totalToolCalls) * 10_000) / 10_000 : 1,
		ragQueryCount,
		sidecarBlocks,
		artifactActivationCounts,
	};
}

/** Format a concise Trace summary for /trace command output. */
export function formatTraceSummary(summary: TraceSummary, scopeLabel: string): string {
	const cachePct = `${(summary.cacheHitRate * 100).toFixed(1)}%`;
	const toolPct = `${(summary.toolSuccessRate * 100).toFixed(1)}%`;
	const lines = [
		`Trace 统计 (${scopeLabel})`,
		`- 轮次: ${summary.turns} | 总耗时: ${summary.totalDurationMs}ms | 平均 TTFT: ${summary.avgTtftMs !== null ? `${summary.avgTtftMs}ms` : "N/A"}`,
		`- Token: input=${summary.inputTokens}, cacheRead=${summary.cacheReadTokens} (Prompt Cache 命中率 ${cachePct}), output=${summary.outputTokens}, reasoning=${summary.reasoningTokens}`,
		`- 估算费用: $${summary.estimatedCostUsd.toFixed(4)}`,
		`- 工具调用: ${summary.totalToolCalls} 次 (成功率 ${toolPct}) | RAG 检索: ${summary.ragQueryCount} 次 | Sidecar 拦截: ${summary.sidecarBlocks} 次`,
	];

	const activated = Object.entries(summary.artifactActivationCounts);
	if (activated.length > 0) {
		lines.push(`- 产物激活统计: ${activated.map(([path, cnt]) => `${path}(${cnt})`).join(", ")}`);
	}
	return lines.join("\n");
}

/** Attach local Trace recording, budget guardrails, TUI footer stats, and /trace command onto pi. */
export function attachTraceModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options: AttachTraceOptions = {},
): TraceStore {
	const store = new TraceStore(runtime.workspace.tracesDir);
	const budget: TraceBudgetConfig = {
		maxTurnsPerTask: options.budget?.maxTurnsPerTask ?? DEFAULT_BUDGET.maxTurnsPerTask,
		costWarnThresholdUsd: options.budget?.costWarnThresholdUsd ?? DEFAULT_BUDGET.costWarnThresholdUsd,
	};

	let requestStartedAt = 0;
	let firstStreamTokenAt: number | undefined;
	let turnToolCalls: TraceToolCallStat[] = [];
	let turnRagQueries: TraceRagQueryStat[] = [];
	let turnSidecarBlocks = 0;
	let turnActivatedArtifacts: string[] = [];
	let taskTurnCount = 0;
	let sessionCostUsd = 0;
	let costWarned = false;

	const resetTurnBuffers = () => {
		requestStartedAt = 0;
		firstStreamTokenAt = undefined;
		turnToolCalls = [];
		turnRagQueries = [];
		turnSidecarBlocks = 0;
		turnActivatedArtifacts = [];
	};

	pi.on("session_start", () => {
		resetTurnBuffers();
		taskTurnCount = 0;
		sessionCostUsd = 0;
		costWarned = false;
	});

	pi.on("agent_start", () => {
		taskTurnCount = 0;
	});

	pi.on("before_provider_request", () => {
		requestStartedAt = performance.now();
		firstStreamTokenAt = undefined;
	});

	pi.on("provider_stream_event", () => {
		if (requestStartedAt > 0 && firstStreamTokenAt === undefined) {
			firstStreamTokenAt = performance.now();
		}
	});

	pi.on("tool_result", (event) => {
		turnToolCalls.push({ name: event.toolName, ok: !event.isError });

		const artifact = detectActivatedArtifact(event.toolName, event.input);
		if (artifact && !turnActivatedArtifacts.includes(artifact)) {
			turnActivatedArtifacts.push(artifact);
		}

		if (event.toolName === "search_knowledge" || event.toolName === "search_memory") {
			const query = typeof event.input.query === "string" ? event.input.query : "";
			const details =
				typeof event.details === "object" && event.details !== null
					? (event.details as { hits?: unknown[]; mode?: string })
					: undefined;
			turnRagQueries.push({
				tool: event.toolName,
				query,
				hitCount: Array.isArray(details?.hits) ? details.hits.length : 0,
				mode: details?.mode,
			});
		}

		if (event.isError) {
			const text = event.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join(" ");
			if (text.includes("Sidecar") || text.includes("层 3/4")) {
				turnSidecarBlocks += 1;
			}
		}
	});

	pi.on("turn_end", (event, ctx) => {
		taskTurnCount += 1;
		const assistant = event.message.role === "assistant" ? (event.message as AssistantMessage) : undefined;
		const usage: Usage | undefined = assistant?.usage;

		const inputTokens = usage?.input ?? 0;
		const outputTokens = usage?.output ?? 0;
		const cacheReadTokens = usage?.cacheRead ?? 0;
		const reasoningTokens = estimateReasoningTokens(assistant);
		const estimatedCostUsd = usage?.cost?.total ?? 0;
		const durationMs = requestStartedAt > 0 ? Math.round(performance.now() - requestStartedAt) : 0;
		const ttftMs =
			requestStartedAt > 0 && firstStreamTokenAt !== undefined
				? Math.round(firstStreamTokenAt - requestStartedAt)
				: undefined;

		const sessionId = ctx.sessionManager.getSessionId();
		store.append({
			timestamp: new Date().toISOString(),
			sessionId,
			turnIndex: event.turnIndex,
			provider: assistant?.provider ?? runtime.config.models.main.provider,
			model: assistant?.model ?? runtime.config.models.main.model,
			inputTokens,
			outputTokens,
			reasoningTokens,
			cacheReadTokens,
			cacheHitRate: computeCacheHitRate(inputTokens, cacheReadTokens),
			ttftMs,
			durationMs,
			estimatedCostUsd,
			toolCalls: turnToolCalls,
			ragQueries: turnRagQueries,
			sidecarBlocks: turnSidecarBlocks,
			activatedArtifacts: turnActivatedArtifacts,
		});

		sessionCostUsd += estimatedCostUsd;
		const summary = store.summarize(sessionId);

		if (ctx.hasUI) {
			ctx.ui.setStatus(
				"assistant-trace",
				`cache ${(summary.cacheHitRate * 100).toFixed(0)}% | $${summary.estimatedCostUsd.toFixed(4)} | turns ${summary.turns}`,
			);
			if (taskTurnCount >= budget.maxTurnsPerTask) {
				ctx.ui.notify(
					`[预算护栏提醒] 当前任务已执行 ${taskTurnCount} 轮（阈值 ${budget.maxTurnsPerTask}），请注意检查是否陷入无效循环。`,
					"warning",
				);
			}
			if (!costWarned && sessionCostUsd >= budget.costWarnThresholdUsd) {
				costWarned = true;
				ctx.ui.notify(
					`[费用护栏提醒] 本会话累计估算费用已达 $${sessionCostUsd.toFixed(4)}（提醒阈值 $${budget.costWarnThresholdUsd.toFixed(2)}）。`,
					"warning",
				);
			}
		}

		resetTurnBuffers();
	});

	pi.registerCommand("trace", {
		description: "查看当前会话（或加 all 查看全部）的 Token、Prompt Cache 命中率、费用与产物激活统计",
		handler: async (args, ctx) => {
			const showAll = args.trim().toLowerCase() === "all";
			const sessionId = ctx.sessionManager.getSessionId();
			const summary = showAll ? store.summarize() : store.summarize(sessionId);
			const text = formatTraceSummary(summary, showAll ? "全局累计" : `会话 ${sessionId}`);
			if (ctx.hasUI) {
				ctx.ui.notify(text, "info");
			} else {
				console.log(text);
			}
		},
	});

	return store;
}

function estimateReasoningTokens(assistant: AssistantMessage | undefined): number {
	if (!assistant) return 0;
	let chars = 0;
	for (const block of assistant.content) {
		if (block.type === "thinking") {
			chars += block.thinking.length;
		}
	}
	return chars > 0 ? Math.ceil(chars * 0.6) : 0;
}
