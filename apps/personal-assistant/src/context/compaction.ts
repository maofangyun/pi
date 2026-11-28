// Three-layer progressive compaction (L1 spill + L2 zero-LLM context_edit + L3 fidelity compaction)
// with SourceIndex, Pin anchors, 2-failure circuit breaker, and lossless search_session_history tool.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	ContextEditEntryDraft,
	ExtensionAPI,
	ProjectedSessionEntry,
	SessionBeforeCompactEvent,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";
import type { TodoItem, TodoStore } from "./todo.ts";
import {
	computeUsageRatio,
	estimateConversationTokens,
	estimateTextTokens,
	L2_COMPACT_THRESHOLD_RATIO,
	L3_COMPACT_THRESHOLD_RATIO,
} from "./token-estimator.ts";

export interface L1SpillResult {
	artifactPath: string;
	previewText: string;
	bytes: number;
	lineCount: number;
	reusedFrozen: boolean;
}

export interface FailedCommandRecord {
	tool: string;
	summary: string;
	exitCode?: number;
}

export interface SourceIndex {
	readFiles: string[];
	modifiedFiles: string[];
	urls: string[];
	pdfPages: string[];
	artifacts: string[];
	failedCommands: FailedCommandRecord[];
}

export interface PinnedAnchor {
	id: string;
	entryId?: string;
	text: string;
	pinnedAt: string;
}

export interface FidelityCompactionDetails {
	version: 1;
	degraded: boolean;
	degradedReason?: string;
	sourceIndex: SourceIndex;
	pinnedAnchors: PinnedAnchor[];
	todos: TodoItem[];
}

export interface SessionHistoryHit {
	entryId: string;
	role: string;
	timestamp: string;
	snippet: string;
	matchedTerms: string[];
	score: number;
}

export interface L3SummaryRequest {
	messages: AgentMessage[];
	model: Model<Api>;
	reserveTokens: number;
	apiKey: string | undefined;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	customInstructions: string;
	previousSummary?: string;
	thinkingLevel?: ThinkingLevel;
	sessionId?: string;
}

export type L3SummarizerFn = (request: L3SummaryRequest) => Promise<{ text: string; usage?: Usage }>;

export interface AttachCompactionOptions {
	summarizer?: L3SummarizerFn;
}

/** L1 artifact spill thresholds (> 8KB or > 200 lines). */
export const L1_MAX_BYTES = 8 * 1024;
export const L1_MAX_LINES = 200;
const L1_HEAD_LINES = 25;
const L1_TAIL_LINES = 15;

/** L2 zero-LLM batch folding constants. */
export const L2_KEEP_RECENT_TURNS = 4;
export const L2_FOLD_MIN_CHARS = 1200;
const L2_FOLDED_PREFIX = "[L2 已折叠只读工具输出";

const READ_ONLY_FOLDABLE_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"web_search",
	"fetch_url",
	"search_knowledge",
	"search_memory",
	"browse_knowledge_index",
	"search_session_history",
]);

const PIN_ENTRY_TYPE = "assistant-pin-state";
const MAX_CONSECUTIVE_COMPACTION_FAILURES = 2;

const SearchSessionHistoryParams = Type.Object({
	query: Type.String({ description: "要在原始会话 JSONL 历史中检索的关键词或短语（支持中英文多词空格分隔）" }),
	limit: Type.Optional(Type.Number({ description: "最多返回条数，默认 8，上限 20", minimum: 1, maximum: 20 })),
});

/**
 * L1 write-time spill: persist full oversized tool output to evidence/artifacts/<session>/<toolCallId>.txt
 * and freeze a deterministic head+tail preview so KV Cache prefix stays stable.
 */
export function spillLargeToolOutput(params: {
	artifactsDir: string;
	sessionId: string;
	toolCallId: string;
	toolName: string;
	fullText: string;
	maxBytes?: number;
	maxLines?: number;
}): L1SpillResult | undefined {
	const maxBytes = params.maxBytes ?? L1_MAX_BYTES;
	const maxLines = params.maxLines ?? L1_MAX_LINES;
	const bytes = Buffer.byteLength(params.fullText, "utf8");
	const lines = params.fullText.split(/\r?\n/);

	if (bytes <= maxBytes && lines.length <= maxLines) {
		return undefined;
	}

	const sessionDir = join(params.artifactsDir, sanitizeSegment(params.sessionId));
	mkdirSync(sessionDir, { recursive: true });

	const safeId = sanitizeSegment(params.toolCallId);
	const artifactPath = join(sessionDir, `${safeId}.txt`);
	const previewCachePath = join(sessionDir, `${safeId}.preview.txt`);

	if (existsSync(artifactPath) && existsSync(previewCachePath)) {
		return {
			artifactPath,
			previewText: readFileSync(previewCachePath, "utf8"),
			bytes,
			lineCount: lines.length,
			reusedFrozen: true,
		};
	}

	if (!existsSync(artifactPath)) {
		writeFileSync(artifactPath, params.fullText, "utf8");
	}

	const previewText = buildFrozenL1Preview(params.toolName, artifactPath, lines, bytes);
	writeFileSync(previewCachePath, previewText, "utf8");

	return {
		artifactPath,
		previewText,
		bytes,
		lineCount: lines.length,
		reusedFrozen: false,
	};
}

/**
 * L2 zero-LLM batch folding: emit context_edit drafts that replace stale read-only large tool results
 * older than the most recent N turns with a single-line artifact pointer.
 */
export function planL2MicroCompactEdits(params: {
	contextEntries: readonly ProjectedSessionEntry[];
	artifactsDir: string;
	sessionId: string;
	pinnedEntryIds: ReadonlySet<string>;
	keepRecentTurns?: number;
	minChars?: number;
}): { edits: ContextEditEntryDraft[]; savedTokens: number } {
	const keepRecentTurns = params.keepRecentTurns ?? L2_KEEP_RECENT_TURNS;
	const minChars = params.minChars ?? L2_FOLD_MIN_CHARS;

	const turnBoundaryIndices: number[] = [];
	for (let i = 0; i < params.contextEntries.length; i++) {
		const entry = params.contextEntries[i];
		if (entry.messages.some((msg) => msg.role === "user")) {
			turnBoundaryIndices.push(i);
		}
	}

	if (turnBoundaryIndices.length <= keepRecentTurns) {
		return { edits: [], savedTokens: 0 };
	}

	const cutoffIndex = turnBoundaryIndices[turnBoundaryIndices.length - keepRecentTurns];
	const edits: ContextEditEntryDraft[] = [];
	let savedTokens = 0;

	for (let i = 0; i < cutoffIndex; i++) {
		const projected = params.contextEntries[i];
		const entryId = projected.sourceEntry.id;
		if (params.pinnedEntryIds.has(entryId)) continue;
		if (projected.sourceEntry.type !== "message") continue;
		if (projected.messages.length !== 1) continue;

		const msg = projected.messages[0];
		if (msg.role !== "toolResult") continue;
		if (msg.isError) continue;
		if (!READ_ONLY_FOLDABLE_TOOLS.has(msg.toolName)) continue;

		const fullText = extractTextContent(msg.content);
		if (fullText.length < minChars) continue;
		if (fullText.startsWith(L2_FOLDED_PREFIX)) continue;

		const artifactPath =
			extractArtifactPathFromText(fullText) ??
			persistRawArtifact(params.artifactsDir, params.sessionId, msg.toolCallId, fullText);
		const lineCount = fullText.split(/\r?\n/).length;
		const bytes = Buffer.byteLength(fullText, "utf8");
		const placeholder = `${L2_FOLDED_PREFIX} | tool=${msg.toolName} | lines=${lineCount} | bytes=${bytes} | 完整内容见: ${artifactPath.replace(/\\/g, "/")}]`;

		const beforeTokens = estimateTextTokens(fullText);
		const afterTokens = estimateTextTokens(placeholder);
		if (beforeTokens <= afterTokens) continue;

		savedTokens += beforeTokens - afterTokens;
		edits.push({
			type: "context_edit",
			targetId: entryId,
			replacement: {
				content: [{ type: "text", text: placeholder }],
			},
		});
	}

	return { edits, savedTokens };
}

/** Persistent session-scoped store for uncompressible /pin anchors. */
export class PinStore {
	private readonly artifactsDir: string;
	private sessionId: string;
	private anchors: PinnedAnchor[] = [];

	constructor(artifactsDir: string, sessionId = "default") {
		this.artifactsDir = artifactsDir;
		this.sessionId = sanitizeSegment(sessionId);
	}

	/** Switch active session and reload persisted pinned anchors. */
	loadSession(sessionId: string): PinnedAnchor[] {
		this.sessionId = sanitizeSegment(sessionId);
		const filePath = this.getStateFilePath();
		if (!existsSync(filePath)) {
			this.anchors = [];
			return this.getAll();
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
			this.anchors = Array.isArray(parsed) ? parsed.filter(isValidPinnedAnchor) : [];
		} catch {
			this.anchors = [];
		}
		return this.getAll();
	}

	/** Pin a verbatim anchor (either referencing a session entryId or a standalone hard constraint). */
	add(text: string, entryId?: string, now = new Date()): PinnedAnchor {
		const trimmed = text.trim();
		if (entryId) {
			const existing = this.anchors.find((anchor) => anchor.entryId === entryId);
			if (existing) return { ...existing };
		}
		const anchor: PinnedAnchor = {
			id: `pin-${this.anchors.length + 1}`,
			entryId,
			text: trimmed,
			pinnedAt: now.toISOString(),
		};
		this.anchors.push(anchor);
		this.persist();
		return { ...anchor };
	}

	/** Remove a pinned anchor by pin ID. */
	remove(id: string): boolean {
		const index = this.anchors.findIndex((anchor) => anchor.id === id);
		if (index === -1) return false;
		this.anchors.splice(index, 1);
		this.persist();
		return true;
	}

	/** Return a copy of all pinned anchors. */
	getAll(): PinnedAnchor[] {
		return this.anchors.map((anchor) => ({ ...anchor }));
	}

	/** Return a set of pinned session entry IDs (excluded from L2 folding). */
	getPinnedEntryIds(): Set<string> {
		const ids = new Set<string>();
		for (const anchor of this.anchors) {
			if (anchor.entryId) ids.add(anchor.entryId);
		}
		return ids;
	}

	/** Path to persisted pins JSON for the active session. */
	getStateFilePath(): string {
		return join(this.artifactsDir, this.sessionId, "pins.json");
	}

	private persist(): void {
		const dir = join(this.artifactsDir, this.sessionId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(this.getStateFilePath(), JSON.stringify(this.anchors, null, 2), "utf8");
	}
}

/** Circuit breaker that trips after 2 consecutive L3 compaction failures to prevent infinite retry loops. */
export class CompactionCircuitBreaker {
	private readonly maxFailures: number;
	private consecutiveFailures = 0;
	private lastFailureReason: string | undefined;

	constructor(maxFailures = MAX_CONSECUTIVE_COMPACTION_FAILURES) {
		this.maxFailures = maxFailures;
	}

	/** Record a successful compaction and reset failure count. */
	recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.lastFailureReason = undefined;
	}

	/** Record a compaction failure; returns true if the breaker is now tripped. */
	recordFailure(reason: string): boolean {
		this.consecutiveFailures += 1;
		this.lastFailureReason = reason;
		return this.isTripped();
	}

	/** Whether consecutive failures reached the circuit breaker threshold. */
	isTripped(): boolean {
		return this.consecutiveFailures >= this.maxFailures;
	}

	/** Number of consecutive failures recorded so far. */
	getConsecutiveFailures(): number {
		return this.consecutiveFailures;
	}

	/** Most recent failure message, if any. */
	getLastFailureReason(): string | undefined {
		return this.lastFailureReason;
	}

	/** Reset breaker state (e.g. on new session or manual reset). */
	reset(): void {
		this.consecutiveFailures = 0;
		this.lastFailureReason = undefined;
	}
}

/**
 * Deterministically collect SourceIndex provenance from session entries and messages
 * without passing paths, URLs, PDF pages, or failure logs through LLM rewriting.
 */
export function extractSourceIndex(
	branchEntries: readonly SessionEntry[],
	messages: readonly AgentMessage[],
): SourceIndex {
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();
	const urls = new Set<string>();
	const pdfPages = new Set<string>();
	const artifacts = new Set<string>();
	const failedCommands: FailedCommandRecord[] = [];
	const seenFailed = new Set<string>();

	const recordFailure = (tool: string, summary: string, exitCode?: number) => {
		const clean = summary.replace(/\s+/g, " ").trim().slice(0, 160);
		const key = `${tool}|${exitCode ?? ""}|${clean}`;
		if (seenFailed.has(key)) return;
		seenFailed.add(key);
		failedCommands.push({ tool, summary: clean, exitCode });
	};

	// Merge previous compaction's deterministic SourceIndex first.
	for (const entry of branchEntries) {
		if (entry.type === "compaction" && isFidelityDetails(entry.details)) {
			const prev = entry.details.sourceIndex;
			for (const p of prev.readFiles) readFiles.add(p);
			for (const p of prev.modifiedFiles) modifiedFiles.add(p);
			for (const u of prev.urls) urls.add(u);
			for (const p of prev.pdfPages) pdfPages.add(p);
			for (const a of prev.artifacts) artifacts.add(a);
			for (const f of prev.failedCommands) recordFailure(f.tool, f.summary, f.exitCode);
		}
	}

	const allMessages: AgentMessage[] = [...messages];
	for (const entry of branchEntries) {
		if (entry.type === "message") {
			allMessages.push(entry.message);
		}
	}

	const toolInputById = new Map<string, { name: string; args: Record<string, unknown> }>();

	for (const msg of allMessages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type !== "toolCall") continue;
				const args = isPlainRecord(block.arguments) ? block.arguments : {};
				toolInputById.set(block.id, { name: block.name, args });
				collectProvenanceFromToolCall(block.name, args, readFiles, modifiedFiles, urls, pdfPages);
			}
		} else if (msg.role === "toolResult") {
			const text = extractTextContent(msg.content);
			collectProvenanceFromText(text, urls, pdfPages, artifacts);
			if (msg.isError) {
				const call = toolInputById.get(msg.toolCallId);
				const cmdHint =
					call && typeof call.args.command === "string"
						? `${call.args.command} -> ${text}`
						: text || "tool returned error";
				const exitCode = extractExitCode(text);
				recordFailure(msg.toolName, cmdHint, exitCode);
			}
		}
	}

	return {
		readFiles: [...readFiles].sort((a, b) => a.localeCompare(b)),
		modifiedFiles: [...modifiedFiles].sort((a, b) => a.localeCompare(b)),
		urls: [...urls].sort((a, b) => a.localeCompare(b)),
		pdfPages: [...pdfPages].sort((a, b) => a.localeCompare(b)),
		artifacts: [...artifacts].sort((a, b) => a.localeCompare(b)),
		failedCommands,
	};
}

/** Build task-aware L3 compaction instructions injecting active TODOs and pinned constraints. */
export function buildL3CompactionInstructions(params: {
	todos: readonly TodoItem[];
	pinnedAnchors: readonly PinnedAnchor[];
	customInstructions?: string;
}): string {
	const parts: string[] = [
		"请生成面向个人智能体助理的结构化对话压缩摘要，严格包含以下 5 个章节：",
		"## Goal（当前核心目标）",
		"## Constraints（不可违背的硬约束与用户偏好覆盖项）",
		"## Decisions（已确认的关键决定与理由）",
		"## Failed Attempts（尝试过但失败的方案/命令与报错原因，防止后续重复踩坑）",
		"## Next Steps（下一步明确行动）",
		"",
		"要求：严禁省略硬约束、否定条件与失败路径；文件路径、PDF 页码、URL 与落盘 artifact 路径会由外置代码确定性重新挂载，请勿编造未出现的路径。",
	];

	if (params.todos.length > 0) {
		parts.push("", "当前活跃 TODO 清单（外置真相源）：");
		for (const item of params.todos) {
			parts.push(`- [${item.status}] (${item.id}) ${item.title}`);
		}
	}

	if (params.pinnedAnchors.length > 0) {
		parts.push("", "用户已固定（Pinned）的不可压缩关键锚点（供上下文对齐，原文将另行强制保留）：");
		for (const anchor of params.pinnedAnchors) {
			parts.push(`- (${anchor.id}) ${anchor.text}`);
		}
	}

	if (params.customInstructions && params.customInstructions.trim().length > 0) {
		parts.push("", `补充要求：${params.customInstructions.trim()}`);
	}

	return parts.join("\n");
}

/**
 * Deterministically mount externalized state (pinned verbatim anchors, active TODOs, SourceIndex)
 * outside LLM summary rewriting so critical provenance and constraints are never lost.
 */
export function assembleFidelityCompactionSummary(params: {
	llmSummary: string;
	sourceIndex: SourceIndex;
	pinnedAnchors: readonly PinnedAnchor[];
	todos: readonly TodoItem[];
	degradedReason?: string;
}): string {
	const blocks: string[] = [];

	if (params.degradedReason) {
		blocks.push(
			`> [熔断降级压缩检查点] 自动 LLM 摘要已触发连续失败熔断（${params.degradedReason}），以下为确定性保留的外置状态与出处索引。`,
		);
	}

	blocks.push(params.llmSummary.trim());

	if (params.pinnedAnchors.length > 0) {
		blocks.push(
			"<pinned_anchors>",
			...params.pinnedAnchors.map(
				(anchor) => `[${anchor.id}${anchor.entryId ? ` entry=${anchor.entryId}` : ""}] ${anchor.text}`,
			),
			"</pinned_anchors>",
		);
	}

	if (params.todos.length > 0) {
		blocks.push(
			"<active_todos>",
			...params.todos.map((item) => `- [${item.status}] (${item.id}) ${item.title}`),
			"</active_todos>",
		);
	}

	blocks.push(formatSourceIndexXml(params.sourceIndex));
	blocks.push(
		"<history_recall_hint>原始无损会话记录已完整保留，若需核查已归档轮次的原文细节，请调用 search_session_history(query) 工具按需回查。</history_recall_hint>",
	);

	return blocks.filter((b) => b.length > 0).join("\n\n");
}

/** Search lossless raw session entries (JSONL) by Chinese/English query terms. */
export function searchSessionEntries(entries: readonly SessionEntry[], query: string, limit = 8): SessionHistoryHit[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [];

	const normalizedQuery = trimmed.toLowerCase();
	const terms = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);
	const hits: SessionHistoryHit[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" && entry.type !== "custom_message") continue;
		const role = entry.type === "message" ? entry.message.role : `custom:${entry.customType}`;
		const rawText =
			entry.type === "message"
				? extractAgentMessagePlainText(entry.message)
				: typeof entry.content === "string"
					? entry.content
					: extractTextContent(entry.content);
		if (rawText.trim().length === 0) continue;

		const lower = rawText.toLowerCase();
		const matchedTerms = terms.filter((term) => lower.includes(term));
		if (matchedTerms.length === 0) continue;

		const exactPhraseBoost = lower.includes(normalizedQuery) ? 2 : 0;
		const score = matchedTerms.length + exactPhraseBoost;
		const firstIndex = lower.indexOf(matchedTerms[0]);
		const snippet = buildSnippet(rawText, firstIndex, 220);

		hits.push({
			entryId: entry.id,
			role,
			timestamp: entry.timestamp,
			snippet,
			matchedTerms,
			score,
		});
	}

	hits.sort((a, b) => b.score - a.score || b.timestamp.localeCompare(a.timestamp));
	return hits.slice(0, Math.max(1, Math.min(20, limit)));
}

/** Read raw lossless session entries from the on-disk JSONL file when available. */
export function readRawSessionEntries(
	sessionFile: string | undefined,
	fallbackEntries: readonly SessionEntry[],
): SessionEntry[] {
	if (sessionFile && existsSync(sessionFile)) {
		try {
			const raw = readFileSync(sessionFile, "utf8");
			const entries: SessionEntry[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				const parsed: unknown = JSON.parse(trimmed);
				if (isPlainRecord(parsed) && typeof parsed.type === "string" && parsed.type !== "session") {
					entries.push(parsed as unknown as SessionEntry);
				}
			}
			if (entries.length > 0) return entries;
		} catch {
			// Fall back to in-memory entries if raw JSONL cannot be parsed.
		}
	}
	return [...fallbackEntries];
}

/** Attach L1 spill, L2 micro-compaction, L3 fidelity compaction, /pin, and search_session_history. */
export function attachCompactionModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	todoStore: TodoStore,
	options: AttachCompactionOptions = {},
): { pinStore: PinStore; circuitBreaker: CompactionCircuitBreaker } {
	const pinStore = new PinStore(runtime.workspace.artifactsDir);
	const circuitBreaker = new CompactionCircuitBreaker(MAX_CONSECUTIVE_COMPACTION_FAILURES);
	const summarizer = options.summarizer;

	pi.on("session_start", (_event, ctx) => {
		pinStore.loadSession(ctx.sessionManager.getSessionId());
		circuitBreaker.reset();
	});

	// L1 write-time artifact spill + frozen preview.
	pi.on("tool_result", (event, ctx) => {
		const fullText = extractTextContent(event.content);
		if (fullText.length === 0) return undefined;

		const spilled = spillLargeToolOutput({
			artifactsDir: runtime.workspace.artifactsDir,
			sessionId: ctx.sessionManager.getSessionId(),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			fullText,
		});
		if (!spilled) return undefined;

		const existingDetails = isPlainRecord(event.details) ? event.details : {};
		return {
			content: [{ type: "text", text: spilled.previewText }],
			details: {
				...existingDetails,
				assistantArtifact: {
					path: spilled.artifactPath,
					bytes: spilled.bytes,
					lineCount: spilled.lineCount,
					reusedFrozen: spilled.reusedFrozen,
				},
			},
		};
	});

	// L2 zero-LLM batch folding (60%-65%) + proactive L3 trigger (70%-75%).
	pi.on("turn_end", (event, ctx) => {
		const contextWindow = ctx.model?.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		const estimate = estimateConversationTokens(event.context.contextMessages);
		const ratio = computeUsageRatio(estimate.tokens, contextWindow);

		let edits: ContextEditEntryDraft[] = [];
		let savedTokens = 0;

		if (runtime.config.features.l2MicroCompact && ratio >= L2_COMPACT_THRESHOLD_RATIO) {
			const plan = planL2MicroCompactEdits({
				contextEntries: event.context.contextEntries,
				artifactsDir: runtime.workspace.artifactsDir,
				sessionId: ctx.sessionManager.getSessionId(),
				pinnedEntryIds: pinStore.getPinnedEntryIds(),
			});
			edits = plan.edits;
			savedTokens = plan.savedTokens;
		}

		const postL2Ratio = computeUsageRatio(Math.max(0, estimate.tokens - savedTokens), contextWindow);
		if (postL2Ratio >= L3_COMPACT_THRESHOLD_RATIO && !circuitBreaker.isTripped() && ctx.model) {
			ctx.compact();
		}

		if (edits.length > 0) {
			return {
				entries: [...event.entries, ...edits],
			};
		}
		return undefined;
	});

	// L3 task-aware fidelity compaction + 2-failure circuit breaker.
	pi.on("session_before_compact", async (event, ctx) => {
		const todos = todoStore.getItems();
		const pinnedAnchors = pinStore.getAll();
		const sourceIndex = extractSourceIndex(event.branchEntries, event.preparation.messagesToSummarize);

		if (circuitBreaker.isTripped() && event.reason !== "manual") {
			const degraded = buildDegradedCompactionResult(
				event,
				sourceIndex,
				pinnedAnchors,
				todos,
				`连续失败 ${circuitBreaker.getConsecutiveFailures()} 次，已熔断自动压缩`,
			);
			if (ctx.hasUI) {
				ctx.ui.notify(
					"自动压缩熔断器已触发，已降级为确定性外置状态保留模式，请检查模型状态或手动 /compact。",
					"warning",
				);
			}
			return { compaction: degraded };
		}

		const model = ctx.model;
		if (!model) {
			const tripped = circuitBreaker.recordFailure("no active model");
			if (tripped) {
				return {
					compaction: buildDegradedCompactionResult(
						event,
						sourceIndex,
						pinnedAnchors,
						todos,
						"无可用模型，连续失败触发熔断降级",
					),
				};
			}
			throw new Error("Compaction failed: no active model available");
		}

		if (!summarizer) {
			return {
				compaction: buildDegradedCompactionResult(
					event,
					sourceIndex,
					pinnedAnchors,
					todos,
					"未注入 L3 摘要执行器，已按确定性外置状态保留模式生成检查点",
				),
			};
		}

		const instructions = buildL3CompactionInstructions({
			todos,
			pinnedAnchors,
			customInstructions: event.customInstructions,
		});

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const summaryResult = await summarizer({
				messages: event.preparation.messagesToSummarize,
				model,
				reserveTokens: event.preparation.settings.reserveTokens,
				apiKey: auth.apiKey,
				headers: normalizeStringHeaders(auth.headers),
				signal: event.signal,
				customInstructions: instructions,
				previousSummary: event.preparation.previousSummary,
				thinkingLevel: ctx.thinkingLevel,
				sessionId: ctx.sessionManager.getSessionId(),
			});

			const fullSummary = assembleFidelityCompactionSummary({
				llmSummary: summaryResult.text,
				sourceIndex,
				pinnedAnchors,
				todos,
			});

			circuitBreaker.recordSuccess();
			const details: FidelityCompactionDetails = {
				version: 1,
				degraded: false,
				sourceIndex,
				pinnedAnchors,
				todos,
			};

			return {
				compaction: {
					summary: fullSummary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					estimatedTokensAfter: estimateTextTokens(fullSummary),
					usage: summaryResult.usage,
					details,
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const tripped = circuitBreaker.recordFailure(reason);
			if (tripped) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`对话压缩连续失败 ${circuitBreaker.getConsecutiveFailures()} 次，已触发熔断并降级保留核心锚点与出处索引（原因：${reason}）。`,
						"warning",
					);
				}
				return {
					compaction: buildDegradedCompactionResult(event, sourceIndex, pinnedAnchors, todos, reason),
				};
			}
			throw error;
		}
	});

	pi.on("session_compact", () => {
		circuitBreaker.recordSuccess();
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (event.aborted) return;
		if (!event.fromExtension) {
			const tripped = circuitBreaker.recordFailure(event.errorMessage ?? "compaction failed");
			if (tripped && ctx.hasUI) {
				ctx.ui.notify("对话压缩连续失败达 2 次，已触发自动压缩熔断保护。", "warning");
			}
		}
	});

	// /pin command for uncompressible anchors.
	pi.registerCommand("pin", {
		description: "将当前关键需求、硬约束或指定消息固定为不可压缩锚点（用法: /pin [list | <entryId> | <约束文本>]）",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "list") {
				const all = pinStore.getAll();
				const msg =
					all.length === 0
						? "当前会话暂无 Pinned 锚点。"
						: all.map((a) => `${a.id}${a.entryId ? ` (${a.entryId})` : ""}: ${a.text}`).join("\n");
				notifyOrLog(ctx, msg, "info");
				return;
			}

			const entries = ctx.sessionManager.getBranch();
			let anchor: PinnedAnchor;

			if (trimmed.length === 0) {
				const latestUser = [...entries]
					.reverse()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (!latestUser || latestUser.type !== "message") {
					notifyOrLog(ctx, "当前会话尚无可固定的用户消息，可直接使用 `/pin <约束文本>`。", "warning");
					return;
				}
				const text = extractAgentMessagePlainText(latestUser.message);
				anchor = pinStore.add(text, latestUser.id);
			} else {
				const matchedEntry = entries.find((entry) => entry.id === trimmed && entry.type === "message");
				if (matchedEntry && matchedEntry.type === "message") {
					anchor = pinStore.add(extractAgentMessagePlainText(matchedEntry.message), matchedEntry.id);
				} else {
					anchor = pinStore.add(trimmed);
				}
			}

			pi.appendEntry(PIN_ENTRY_TYPE, { anchors: pinStore.getAll() });
			notifyOrLog(ctx, `已固定锚点 [${anchor.id}]：${anchor.text.slice(0, 120)}`, "info");
		},
	});

	pi.registerCommand("unpin", {
		description: "移除指定的不可压缩锚点（用法: /unpin <pin-id>）",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				notifyOrLog(ctx, "请指定要移除的锚点 ID，例如 `/unpin pin-1`。", "warning");
				return;
			}
			const removed = pinStore.remove(id);
			if (!removed) {
				notifyOrLog(ctx, `未找到锚点 ${id}。`, "warning");
				return;
			}
			pi.appendEntry(PIN_ENTRY_TYPE, { anchors: pinStore.getAll() });
			notifyOrLog(ctx, `已移除锚点 ${id}。`, "info");
		},
	});

	// Lossless archived history search tool.
	pi.registerTool({
		name: "search_session_history",
		label: "Search Session History",
		description:
			"在当前会话无损原始 JSONL 轨迹中按关键词检索被压缩或折叠的历史轮次原文（只读工具，支持中英文多词查询）。",
		promptSnippet: "回查当前会话已压缩/折叠的原始无损历史记录",
		parameters: SearchSessionHistoryParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const rawEntries = readRawSessionEntries(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getEntries());
			const hits = searchSessionEntries(rawEntries, params.query, params.limit ?? 8);
			if (hits.length === 0) {
				return {
					content: [{ type: "text", text: `未在原始会话历史中找到与 "${params.query}" 匹配的记录。` }],
					details: { query: params.query, hits: [] },
				};
			}

			const formatted = hits
				.map((hit, index) => `${index + 1}. [${hit.entryId}] (${hit.role} @ ${hit.timestamp})\n   ${hit.snippet}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: `在原始会话历史中命中 ${hits.length} 条记录：\n\n${formatted}` }],
				details: { query: params.query, hits },
			};
		},
	});

	return { pinStore, circuitBreaker };
}

function buildDegradedCompactionResult(
	event: SessionBeforeCompactEvent,
	sourceIndex: SourceIndex,
	pinnedAnchors: readonly PinnedAnchor[],
	todos: readonly TodoItem[],
	reason: string,
): CompactionResult<FidelityCompactionDetails> {
	const recentSnippets = event.preparation.messagesToSummarize
		.slice(-4)
		.map((msg) => `- [${msg.role}] ${extractAgentMessagePlainText(msg).replace(/\s+/g, " ").slice(0, 180)}`)
		.filter((line) => line.length > 0);

	const degradedBody = [
		"## Goal / Context (Degraded Fallback)",
		"自动 LLM 压缩失败触发熔断降级，以下为截断保留的最近消息片段：",
		...(recentSnippets.length > 0 ? recentSnippets : ["- (无可用最近消息片段)"]),
	].join("\n");

	const summary = assembleFidelityCompactionSummary({
		llmSummary: degradedBody,
		sourceIndex,
		pinnedAnchors,
		todos,
		degradedReason: reason,
	});

	return {
		summary,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		estimatedTokensAfter: estimateTextTokens(summary),
		details: {
			version: 1,
			degraded: true,
			degradedReason: reason,
			sourceIndex,
			pinnedAnchors: [...pinnedAnchors],
			todos: [...todos],
		},
	};
}

function buildFrozenL1Preview(toolName: string, artifactPath: string, lines: readonly string[], bytes: number): string {
	const normalizedPath = artifactPath.replace(/\\/g, "/");
	const header = `[L1 输出已落盘冻结 | tool=${toolName} | lines=${lines.length} | bytes=${bytes} | artifact=${normalizedPath}]`;
	const footer = "[完整输出请使用 read 工具按 offset/limit 分段读取上述 artifact 路径]";

	if (lines.length <= L1_HEAD_LINES + L1_TAIL_LINES) {
		const truncated = lines.join("\n").slice(0, 2400);
		return `${header}\n${truncated}\n... [truncated due to byte size: ${bytes} bytes]\n${footer}`;
	}

	const head = lines.slice(0, L1_HEAD_LINES).join("\n");
	const tail = lines.slice(-L1_TAIL_LINES).join("\n");
	const omitted = lines.length - L1_HEAD_LINES - L1_TAIL_LINES;

	return [
		header,
		`--- HEAD (${L1_HEAD_LINES} lines) ---`,
		head,
		`--- OMITTED (${omitted} lines) ---`,
		`--- TAIL (${L1_TAIL_LINES} lines) ---`,
		tail,
		footer,
	].join("\n");
}

function persistRawArtifact(artifactsDir: string, sessionId: string, toolCallId: string, fullText: string): string {
	const sessionDir = join(artifactsDir, sanitizeSegment(sessionId));
	mkdirSync(sessionDir, { recursive: true });
	const artifactPath = join(sessionDir, `${sanitizeSegment(toolCallId)}.txt`);
	if (!existsSync(artifactPath)) {
		writeFileSync(artifactPath, fullText, "utf8");
	}
	return artifactPath;
}

function collectProvenanceFromToolCall(
	toolName: string,
	args: Record<string, unknown>,
	readFiles: Set<string>,
	modifiedFiles: Set<string>,
	urls: Set<string>,
	pdfPages: Set<string>,
): void {
	const pathArg =
		typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;

	if (pathArg) {
		if (toolName === "write" || toolName === "edit") {
			modifiedFiles.add(pathArg);
		} else if (toolName === "read" || toolName === "analyze_visual") {
			readFiles.add(pathArg);
		}
		if (pathArg.toLowerCase().endsWith(".pdf")) {
			if (typeof args.page === "number" || typeof args.page === "string") {
				pdfPages.add(`${pathArg}#p${args.page}`);
			} else if (Array.isArray(args.page_range) && args.page_range.length >= 2) {
				pdfPages.add(`${pathArg}#p${args.page_range[0]}-p${args.page_range[1]}`);
			}
		}
	}

	if (typeof args.url === "string" && /^https?:\/\//i.test(args.url)) {
		urls.add(args.url);
	}
}

function collectProvenanceFromText(
	text: string,
	urls: Set<string>,
	pdfPages: Set<string>,
	artifacts: Set<string>,
): void {
	const artifactMatches = text.matchAll(/artifact=([^\s\]|]+)/g);
	for (const match of artifactMatches) {
		if (match[1]) artifacts.add(match[1]);
	}

	const l2Matches = text.matchAll(/完整内容见:\s*([^\s\]|]+)/g);
	for (const match of l2Matches) {
		if (match[1]) artifacts.add(match[1]);
	}

	const externalSourceMatches = text.matchAll(/<external_content\s+source="(https?:\/\/[^"]+)"/gi);
	for (const match of externalSourceMatches) {
		if (match[1]) urls.add(match[1]);
	}

	const pdfCitationMatches = text.matchAll(/([^\s[\]()'"]+\.pdf#p\d+(?:-p?\d+)?)/gi);
	for (const match of pdfCitationMatches) {
		if (match[1]) pdfPages.add(match[1]);
	}
}

function formatSourceIndexXml(index: SourceIndex): string {
	const lines = ["<source_index>"];
	lines.push(`read_files: ${index.readFiles.length > 0 ? index.readFiles.join(", ") : "(none)"}`);
	lines.push(`modified_files: ${index.modifiedFiles.length > 0 ? index.modifiedFiles.join(", ") : "(none)"}`);
	lines.push(`urls: ${index.urls.length > 0 ? index.urls.join(", ") : "(none)"}`);
	lines.push(`pdf_pages: ${index.pdfPages.length > 0 ? index.pdfPages.join(", ") : "(none)"}`);
	lines.push(`artifacts: ${index.artifacts.length > 0 ? index.artifacts.join(", ") : "(none)"}`);
	if (index.failedCommands.length > 0) {
		lines.push("failed_commands:");
		for (const item of index.failedCommands) {
			const codePart = item.exitCode !== undefined ? ` (exit=${item.exitCode})` : "";
			lines.push(`  - [${item.tool}]${codePart} ${item.summary}`);
		}
	} else {
		lines.push("failed_commands: (none)");
	}
	lines.push("</source_index>");
	return lines.join("\n");
}

function extractArtifactPathFromText(text: string): string | undefined {
	const match = text.match(/artifact=([^\s\]|]+)/);
	return match?.[1];
}

function extractExitCode(text: string): number | undefined {
	const match = text.match(/exit(?:ed with)? code\s+(-?\d+)/i);
	if (!match) return undefined;
	const parsed = Number.parseInt(match[1], 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function extractTextContent(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function extractAgentMessagePlainText(msg: AgentMessage): string {
	switch (msg.role) {
		case "user":
			return typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
		case "assistant": {
			const parts: string[] = [];
			for (const block of msg.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "toolCall")
					parts.push(`[toolCall:${block.name}] ${JSON.stringify(block.arguments)}`);
			}
			return parts.join("\n");
		}
		case "toolResult":
			return `[toolResult:${msg.toolName}] ${extractTextContent(msg.content)}`;
		case "custom":
			return typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
		case "compactionSummary":
		case "branchSummary":
			return msg.summary;
		case "bashExecution":
			return `${msg.command}\n${msg.output}`;
		default:
			return "";
	}
}

function buildSnippet(text: string, matchIndex: number, maxLength: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	const safeIndex = Math.max(0, Math.min(matchIndex, singleLine.length - 1));
	const half = Math.floor(maxLength / 2);
	const start = Math.max(0, safeIndex - half);
	const end = Math.min(singleLine.length, start + maxLength);
	const prefix = start > 0 ? "..." : "";
	const suffix = end < singleLine.length ? "..." : "";
	return `${prefix}${singleLine.slice(start, end)}${suffix}`;
}

function isFidelityDetails(value: unknown): value is FidelityCompactionDetails {
	if (!isPlainRecord(value)) return false;
	return value.version === 1 && isPlainRecord(value.sourceIndex);
}

function isValidPinnedAnchor(value: unknown): value is PinnedAnchor {
	if (!isPlainRecord(value)) return false;
	return typeof value.id === "string" && typeof value.text === "string" && typeof value.pinnedAt === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringHeaders(
	headers: Record<string, string | null | undefined> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") {
			out[key] = value;
		}
	}
	return out;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function notifyOrLog(
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.log(message);
	}
}
