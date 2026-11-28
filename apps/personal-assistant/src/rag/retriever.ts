// Hybrid retrieval pipeline: metadata pre-filter -> parallel BM25 Top-30 + Vector Top-30 ->
// RRF fusion (k=60, dynamic exact-query weighting) -> optional local Rerank -> adjacent chunk merging
// with provenance (path, section, page_range) and Layer 2 supersedes annotations.

import { EventStore, resolveSupersedesMap, type SupersedingInfo } from "../memory/event-store.ts";
import type { HybridIndexStore, IndexedChunkRecord, MetadataFilter, ScoredChunkHit } from "./index-store.ts";
import type { RagModelClient } from "./ollama-client.ts";

export type RetrievalMode = "bm25" | "vector" | "hybrid" | "hybrid_rerank";

export interface RetrieveOptions {
	query: string;
	filter?: MetadataFilter;
	topK?: number;
	bm25TopN?: number;
	vectorTopN?: number;
	rrfTopN?: number;
	rrfK?: number;
	useReranker?: boolean;
	/** Optional ablation mode override (used by M7 RAG ablation evaluation). */
	mode?: RetrievalMode;
	eventsDir?: string;
}

export interface RetrievedHit {
	chunkIds: string[];
	docPath: string;
	sourceType: IndexedChunkRecord["sourceType"];
	title: string;
	section: string;
	pageRange: [number, number] | null;
	contextPrefix: string;
	content: string;
	score: number;
	bm25Rank?: number;
	vectorRank?: number;
	rerankScore?: number;
	eventId?: string | null;
	supersededAnnotation?: string;
}

export interface RetrieveResult {
	query: string;
	mode: RetrievalMode;
	isExactQuery: boolean;
	weights: { bm25: number; vector: number };
	hits: RetrievedHit[];
	latencyMs: number;
	rerankerApplied: boolean;
	warnings: string[];
}

export const DEFAULT_RRF_K = 60;
export const DEFAULT_RECALL_TOP_N = 30;
export const DEFAULT_RRF_POOL_SIZE = 25;
export const DEFAULT_FINAL_TOP_K = 8;

/**
 * Detect whether a query contains exact paths, code symbols, quoted phrases, or alphanumeric IDs
 * so RRF tilts weights to 0.7/0.3 in favor of BM25 lexical matching.
 */
export function isExactLexicalQuery(query: string): boolean {
	if (/["“”'‘’`].+["“”'‘’`]/.test(query)) return true;
	if (/(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+/.test(query)) return true;
	if (/[A-Za-z]+-[0-9]+|[A-Z]{2,}_[A-Z0-9_]+/.test(query)) return true;
	if (/\.[a-z]{2,5}\b/i.test(query)) return true;
	return false;
}

/** Combine ranked BM25 and dense vector hit lists using weighted Reciprocal Rank Fusion (k=60). */
export function fuseWithRrf(
	bm25Hits: readonly ScoredChunkHit[],
	vectorHits: readonly ScoredChunkHit[],
	options: { k?: number; bm25Weight: number; vectorWeight: number; topN?: number },
): Array<{ chunk: IndexedChunkRecord; score: number; bm25Rank?: number; vectorRank?: number }> {
	const k = options.k ?? DEFAULT_RRF_K;
	const topN = options.topN ?? DEFAULT_RRF_POOL_SIZE;

	const fused = new Map<
		string,
		{ chunk: IndexedChunkRecord; score: number; bm25Rank?: number; vectorRank?: number }
	>();

	for (let i = 0; i < bm25Hits.length; i++) {
		const rank = i + 1;
		const hit = bm25Hits[i];
		const contribution = options.bm25Weight / (k + rank);
		const existing = fused.get(hit.chunk.chunkId);
		if (existing) {
			existing.score += contribution;
			existing.bm25Rank = rank;
		} else {
			fused.set(hit.chunk.chunkId, {
				chunk: hit.chunk,
				score: contribution,
				bm25Rank: rank,
			});
		}
	}

	for (let i = 0; i < vectorHits.length; i++) {
		const rank = i + 1;
		const hit = vectorHits[i];
		const contribution = options.vectorWeight / (k + rank);
		const existing = fused.get(hit.chunk.chunkId);
		if (existing) {
			existing.score += contribution;
			existing.vectorRank = rank;
		} else {
			fused.set(hit.chunk.chunkId, {
				chunk: hit.chunk,
				score: contribution,
				vectorRank: rank,
			});
		}
	}

	return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * Merge adjacent chunk hits from the same document (consecutive chunkIndex) while keeping
 * highest rank order, exact pageRange bounds, and superseding metadata.
 */
export function mergeAdjacentHits(
	hits: ReadonlyArray<{
		chunk: IndexedChunkRecord;
		score: number;
		bm25Rank?: number;
		vectorRank?: number;
		rerankScore?: number;
	}>,
	supersedesMap: ReadonlyMap<string, SupersedingInfo>,
): RetrievedHit[] {
	const merged: Array<{
		chunkIds: string[];
		docPath: string;
		sourceType: IndexedChunkRecord["sourceType"];
		title: string;
		section: string;
		pageStart: number | null;
		pageEnd: number | null;
		contextPrefix: string;
		parts: Array<{ index: number; content: string }>;
		score: number;
		bm25Rank?: number;
		vectorRank?: number;
		rerankScore?: number;
		eventId: string | null;
		supersededAnnotation?: string;
	}> = [];

	for (const item of hits) {
		const c = item.chunk;
		const superseded = c.eventId ? supersedesMap.get(c.eventId)?.annotation : undefined;

		// Only merge non-event document chunks that belong to the same document and have adjacent chunkIndex.
		const target =
			c.sourceType !== "memory_event"
				? merged.find(
						(m) =>
							m.docPath === c.docPath &&
							m.section === c.section &&
							m.parts.some((p) => Math.abs(p.index - c.chunkIndex) === 1),
					)
				: undefined;

		if (target) {
			target.chunkIds.push(c.chunkId);
			target.parts.push({ index: c.chunkIndex, content: c.content });
			target.parts.sort((a, b) => a.index - b.index);
			target.score = Math.max(target.score, item.score);
			if (c.pageStart !== null) {
				target.pageStart = target.pageStart === null ? c.pageStart : Math.min(target.pageStart, c.pageStart);
			}
			if (c.pageEnd !== null) {
				target.pageEnd = target.pageEnd === null ? c.pageEnd : Math.max(target.pageEnd, c.pageEnd);
			}
		} else {
			merged.push({
				chunkIds: [c.chunkId],
				docPath: c.docPath,
				sourceType: c.sourceType,
				title: c.title,
				section: c.section,
				pageStart: c.pageStart,
				pageEnd: c.pageEnd,
				contextPrefix: c.contextPrefix,
				parts: [{ index: c.chunkIndex, content: c.content }],
				score: item.score,
				bm25Rank: item.bm25Rank,
				vectorRank: item.vectorRank,
				rerankScore: item.rerankScore,
				eventId: c.eventId,
				supersededAnnotation: superseded,
			});
		}
	}

	return merged.map((m) => ({
		chunkIds: m.chunkIds,
		docPath: m.docPath,
		sourceType: m.sourceType,
		title: m.title,
		section: m.section,
		pageRange: m.pageStart !== null && m.pageEnd !== null ? [m.pageStart, m.pageEnd] : null,
		contextPrefix: m.contextPrefix,
		content: m.parts.map((p) => p.content).join("\n\n"),
		score: m.score,
		bm25Rank: m.bm25Rank,
		vectorRank: m.vectorRank,
		rerankScore: m.rerankScore,
		eventId: m.eventId,
		supersededAnnotation: m.supersededAnnotation,
	}));
}

/** Hybrid retriever executing the full dual-recall -> RRF -> optional rerank -> merge pipeline. */
export class HybridRetriever {
	private readonly store: HybridIndexStore;
	private readonly modelClient: RagModelClient | undefined;
	private readonly defaultEventsDir: string | undefined;

	constructor(store: HybridIndexStore, modelClient?: RagModelClient, defaultEventsDir?: string) {
		this.store = store;
		this.modelClient = modelClient;
		this.defaultEventsDir = defaultEventsDir;
	}

	/** Execute hybrid retrieval with configurable ablation modes and provenance formatting. */
	async retrieve(options: RetrieveOptions): Promise<RetrieveResult> {
		const startMs = performance.now();
		const warnings: string[] = [];
		const topK = Math.max(1, Math.min(20, options.topK ?? DEFAULT_FINAL_TOP_K));
		const bm25TopN = options.bm25TopN ?? DEFAULT_RECALL_TOP_N;
		const vectorTopN = options.vectorTopN ?? DEFAULT_RECALL_TOP_N;
		const rrfTopN = options.rrfTopN ?? DEFAULT_RRF_POOL_SIZE;

		const mode: RetrievalMode = options.mode ?? (options.useReranker ? "hybrid_rerank" : "hybrid");
		const exactQuery = isExactLexicalQuery(options.query);
		const weights =
			mode === "bm25"
				? { bm25: 1, vector: 0 }
				: mode === "vector"
					? { bm25: 0, vector: 1 }
					: exactQuery
						? { bm25: 0.7, vector: 0.3 }
						: { bm25: 0.5, vector: 0.5 };

		// Step 1 + 2: Dual recall (BM25 + Vector) with metadata pre-filtering.
		const bm25Hits = weights.bm25 > 0 ? this.store.searchBm25(options.query, bm25TopN, options.filter) : [];

		let vectorHits: ScoredChunkHit[] = [];
		if (weights.vector > 0 && this.modelClient) {
			try {
				const [queryVec] = await this.modelClient.embed([options.query]);
				if (queryVec) {
					vectorHits = this.store.searchVector(queryVec, vectorTopN, options.filter);
				}
			} catch (error) {
				warnings.push(
					`Dense vector recall degraded to BM25-only: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Step 3: RRF fusion (Top-25 candidate pool).
		let candidates: Array<{
			chunk: IndexedChunkRecord;
			score: number;
			bm25Rank?: number;
			vectorRank?: number;
			rerankScore?: number;
		}>;

		if (mode === "bm25") {
			candidates = bm25Hits.slice(0, rrfTopN).map((hit, idx) => ({
				chunk: hit.chunk,
				score: hit.score,
				bm25Rank: idx + 1,
			}));
		} else if (mode === "vector") {
			candidates = vectorHits.slice(0, rrfTopN).map((hit, idx) => ({
				chunk: hit.chunk,
				score: hit.score,
				vectorRank: idx + 1,
			}));
		} else {
			candidates = fuseWithRrf(bm25Hits, vectorHits, {
				k: options.rrfK ?? DEFAULT_RRF_K,
				bm25Weight: weights.bm25,
				vectorWeight: weights.vector,
				topN: rrfTopN,
			});
		}

		// Step 4: Optional local cross-encoder reranking.
		let rerankerApplied = false;
		if (mode === "hybrid_rerank" && this.modelClient && candidates.length > 1) {
			try {
				const ranked = await this.modelClient.rerank(
					options.query,
					candidates.map((c) => `${c.chunk.contextPrefix}\n${c.chunk.content}`),
				);
				if (ranked.length > 0) {
					candidates = ranked.map((item) => ({
						...candidates[item.index],
						score: item.score,
						rerankScore: item.score,
					}));
					rerankerApplied = true;
				}
			} catch (error) {
				warnings.push(
					`Local reranker unavailable, kept RRF order: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Step 5: Merge adjacent same-document chunks & annotate superseded Layer 2 events.
		const eventsDir = options.eventsDir ?? this.defaultEventsDir;
		let supersedesMap = new Map<string, SupersedingInfo>();
		if (eventsDir) {
			try {
				const events = new EventStore(eventsDir).loadAll();
				supersedesMap = resolveSupersedesMap(events);
			} catch {
				supersedesMap = new Map();
			}
		}

		// Apply gentle recency/active boost to non-superseded events if both superseded and newer event appear.
		const merged = mergeAdjacentHits(candidates, supersedesMap).slice(0, topK);

		return {
			query: options.query,
			mode,
			isExactQuery: exactQuery,
			weights,
			hits: merged,
			latencyMs: Math.round((performance.now() - startMs) * 100) / 100,
			rerankerApplied,
			warnings,
		};
	}
}

/** Format retrieval hits with mandatory path, section, page_range, and supersedes provenance. */
export function formatRetrievedHits(result: RetrieveResult): string {
	if (result.hits.length === 0) {
		return `未检索到与 "${result.query}" 相关的知识或记忆条目。`;
	}

	const header = `检索命中 ${result.hits.length} 条结果（mode=${result.mode}, weights=BM25:${result.weights.bm25}/Vec:${result.weights.vector}, ${result.latencyMs}ms）：`;
	const blocks = result.hits.map((hit, idx) => {
		const pagePart = hit.pageRange
			? hit.pageRange[0] === hit.pageRange[1]
				? `#p${hit.pageRange[0]}`
				: `#p${hit.pageRange[0]}-p${hit.pageRange[1]}`
			: "";
		const statusTag = hit.supersededAnnotation ? ` ${hit.supersededAnnotation}` : "";
		return [
			`${idx + 1}. [${hit.sourceType}] ${hit.docPath}${pagePart} | 章节: ${hit.section}${statusTag}`,
			`   摘要前缀: ${hit.contextPrefix}`,
			`   ${hit.content.replace(/\n/g, "\n   ")}`,
		].join("\n");
	});

	const warningBlock = result.warnings.length > 0 ? `\n\n[提示] ${result.warnings.join("；")}` : "";
	return `${header}\n\n${blocks.join("\n\n")}${warningBlock}`;
}
