#!/usr/bin/env node
// Deterministic RAG recall evaluation & 4-group ablation pipeline (BM25 / Vector / Hybrid RRF / Hybrid + Rerank)
// computing recall@5, recall@10, MRR, nDCG@10, Top-20 failure rate, and p95 latency + Markdown/HTML reports.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAssistantConfig } from "../../src/config.ts";
import { HybridIndexStore } from "../../src/rag/index-store.ts";
import { OllamaClient } from "../../src/rag/ollama-client.ts";
import { HybridRetriever, type RetrievalMode, type RetrievedHit } from "../../src/rag/retriever.ts";
import { generateInteractiveHtmlReport } from "../../src/tools/html-report.ts";
import { resolveWorkspacePaths } from "../../src/workspace.ts";

export type RagQueryCategory = "exact_term" | "semantic_synonym" | "cross_page_pdf" | "conflicting_memory";

export interface RagEvalCase {
	id: string;
	category: RagQueryCategory;
	query: string;
	relevant_doc_paths: string[];
	expected_pages?: number[];
	expected_event_id?: string;
	superseded_event_id?: string;
	notes?: string;
}

export interface RagQueryEvalDetail {
	caseId: string;
	category: RagQueryCategory;
	recallAt5: number;
	recallAt10: number;
	mrr: number;
	ndcgAt10: number;
	failedTop20: boolean;
	latencyMs: number;
	matchedRank: number | null;
}

export interface RagModeMetrics {
	mode: RetrievalMode;
	label: string;
	queryCount: number;
	recallAt5: number;
	recallAt10: number;
	mrr: number;
	ndcgAt10: number;
	failureRateTop20: number;
	p95LatencyMs: number;
	perQuery: RagQueryEvalDetail[];
}

export interface RagAblationReport {
	generatedAt: string;
	datasetSize: number;
	modes: RagModeMetrics[];
}

export const ABLATION_MODES: ReadonlyArray<{ mode: RetrievalMode; label: string }> = [
	{ mode: "bm25", label: "纯 BM25" },
	{ mode: "vector", label: "纯向量" },
	{ mode: "hybrid", label: "混合 RRF" },
	{ mode: "hybrid_rerank", label: "混合 RRF + Rerank" },
];

/** Load a JSONL golden RAG dataset from disk. */
export function loadRagEvalDataset(datasetPath: string): RagEvalCase[] {
	const lines = readFileSync(datasetPath, "utf8").split(/\r?\n/);
	const cases: RagEvalCase[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		cases.push(JSON.parse(trimmed) as RagEvalCase);
	}
	return cases;
}

/** Evaluate a single query's ranked hits against its ground-truth relevant docs/event/pages. */
export function scoreRagQueryHits(
	evalCase: RagEvalCase,
	hits: readonly RetrievedHit[],
	latencyMs: number,
): RagQueryEvalDetail {
	const relevantSet = new Set(evalCase.relevant_doc_paths.map((p) => p.replace(/\\/g, "/").toLowerCase()));

	const isHitRelevant = (hit: RetrievedHit): boolean => {
		const normPath = hit.docPath.replace(/\\/g, "/").toLowerCase();
		const pathMatched = [...relevantSet].some(
			(rel) => normPath === rel || normPath.endsWith(`/${rel}`) || normPath.endsWith(rel),
		);
		if (!pathMatched) return false;
		if (evalCase.expected_event_id && hit.eventId !== evalCase.expected_event_id) {
			return false;
		}
		if (evalCase.expected_pages && evalCase.expected_pages.length > 0 && hit.pageRange) {
			const [start, end] = hit.pageRange;
			const overlaps = evalCase.expected_pages.some((p) => p >= start && p <= end);
			if (!overlaps) return false;
		}
		return true;
	};

	const totalRelevant = Math.max(1, relevantSet.size);
	let firstRank: number | null = null;
	const matchedDocsAt5 = new Set<string>();
	const matchedDocsAt10 = new Set<string>();
	let dcgAt10 = 0;

	const top20 = hits.slice(0, 20);
	for (let i = 0; i < top20.length; i++) {
		const rank = i + 1;
		const hit = top20[i];
		if (!isHitRelevant(hit)) continue;
		if (firstRank === null) firstRank = rank;
		const normPath = hit.docPath.replace(/\\/g, "/").toLowerCase();
		if (rank <= 5) matchedDocsAt5.add(normPath);
		if (rank <= 10) {
			if (!matchedDocsAt10.has(normPath)) {
				dcgAt10 += 1 / Math.log2(rank + 1);
			}
			matchedDocsAt10.add(normPath);
		}
	}

	let idcgAt10 = 0;
	for (let i = 0; i < Math.min(10, totalRelevant); i++) {
		idcgAt10 += 1 / Math.log2(i + 2);
	}

	return {
		caseId: evalCase.id,
		category: evalCase.category,
		recallAt5: Math.min(1, matchedDocsAt5.size / totalRelevant),
		recallAt10: Math.min(1, matchedDocsAt10.size / totalRelevant),
		mrr: firstRank !== null ? 1 / firstRank : 0,
		ndcgAt10: idcgAt10 > 0 ? Math.min(1, dcgAt10 / idcgAt10) : 0,
		failedTop20: firstRank === null,
		latencyMs,
		matchedRank: firstRank,
	};
}

/** Run 4-group ablation evaluation (BM25 / Vector / Hybrid RRF / Hybrid + Rerank) over a retriever and dataset. */
export async function runRagAblationSuite(
	retriever: HybridRetriever,
	dataset: readonly RagEvalCase[],
	modes: ReadonlyArray<{ mode: RetrievalMode; label: string }> = ABLATION_MODES,
): Promise<RagAblationReport> {
	const results: RagModeMetrics[] = [];

	for (const entry of modes) {
		const perQuery: RagQueryEvalDetail[] = [];
		for (const evalCase of dataset) {
			const retrieved = await retriever.retrieve({
				query: evalCase.query,
				mode: entry.mode,
				topK: 20,
				useReranker: entry.mode === "hybrid_rerank",
			});
			perQuery.push(scoreRagQueryHits(evalCase, retrieved.hits, retrieved.latencyMs));
		}

		const count = perQuery.length;
		const avg = (getter: (d: RagQueryEvalDetail) => number) =>
			count > 0 ? round4(perQuery.reduce((s, d) => s + getter(d), 0) / count) : 0;
		const latencies = perQuery.map((d) => d.latencyMs).sort((a, b) => a - b);
		const p95Idx = latencies.length > 0 ? Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1) : 0;

		results.push({
			mode: entry.mode,
			label: entry.label,
			queryCount: count,
			recallAt5: avg((d) => d.recallAt5),
			recallAt10: avg((d) => d.recallAt10),
			mrr: avg((d) => d.mrr),
			ndcgAt10: avg((d) => d.ndcgAt10),
			failureRateTop20: avg((d) => (d.failedTop20 ? 1 : 0)),
			p95LatencyMs: latencies.length > 0 ? Math.round(latencies[p95Idx] * 100) / 100 : 0,
			perQuery,
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		datasetSize: dataset.length,
		modes: results,
	};
}

/** Render a concise Markdown comparison table for the 4 RAG ablation groups. */
export function formatRagAblationMarkdown(report: RagAblationReport): string {
	const lines = [
		`# 本地混合 RAG 消融评估报告（共 ${report.datasetSize} 题）`,
		"",
		"| 检索模式 | recall@5 | recall@10 | MRR | nDCG@10 | Top-20 失败率 | P95 延迟 (ms) |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const m of report.modes) {
		lines.push(
			`| ${m.label} (\`${m.mode}\`) | ${pct(m.recallAt5)} | ${pct(m.recallAt10)} | ${m.mrr.toFixed(3)} | ${m.ndcgAt10.toFixed(3)} | ${pct(m.failureRateTop20)} | ${m.p95LatencyMs.toFixed(2)} |`,
		);
	}
	return lines.join("\n");
}

/** Render an offline single-file interactive HTML comparison report for the 4 RAG ablation groups. */
export function formatRagAblationHtml(report: RagAblationReport): string {
	const best = [...report.modes].sort((a, b) => b.recallAt10 - a.recallAt10 || b.mrr - a.mrr)[0];
	return generateInteractiveHtmlReport({
		title: "本地混合 RAG 四组消融评估报告",
		subtitle: `评测题量: ${report.datasetSize} 题`,
		generatedAt: report.generatedAt,
		kpis: [
			{ label: "评测样本数", value: String(report.datasetSize) },
			{ label: "最优模式", value: best?.label ?? "N/A" },
			{ label: "最高 recall@10", value: best ? pct(best.recallAt10) : "N/A" },
			{ label: "最高 MRR", value: best ? best.mrr.toFixed(3) : "N/A" },
		],
		charts: [
			{
				title: "各消融组 recall@10 对比",
				type: "bar",
				labels: report.modes.map((m) => m.label),
				values: report.modes.map((m) => Math.round(m.recallAt10 * 1000) / 10),
				unit: "%",
			},
			{
				title: "各消融组 MRR 对比",
				type: "bar",
				labels: report.modes.map((m) => m.label),
				values: report.modes.map((m) => Math.round(m.mrr * 1000) / 10),
				unit: "x100",
			},
		],
		table: {
			title: "四组消融详细指标",
			columns: ["模式", "recall@5", "recall@10", "MRR", "nDCG@10", "Top-20 失败率", "P95 延迟(ms)"],
			rows: report.modes.map((m) => ({
				模式: m.label,
				"recall@5": pct(m.recallAt5),
				"recall@10": pct(m.recallAt10),
				MRR: m.mrr.toFixed(3),
				"nDCG@10": m.ndcgAt10.toFixed(3),
				"Top-20 失败率": pct(m.failureRateTop20),
				"P95 延迟(ms)": m.p95LatencyMs.toFixed(2),
			})),
		},
		methodologyNotes: [
			"4 组对照：纯 BM25 / 纯向量 / 混合 RRF (k=60) / 混合 RRF + Rerank。",
			"数据直接由评估脚本注入 JSON，无人工或 LLM 抄数。",
		],
	});
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

/** CLI entry point for running RAG ablation evaluation against a configured workspace. */
export async function runRagEvalCli(argv: string[] = process.argv.slice(2)): Promise<void> {
	let datasetPath = fileURLToPath(new URL("../golden/rag-dataset.sample.jsonl", import.meta.url));
	let outHtmlPath: string | undefined;
	let workspaceDir: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--dataset" && i + 1 < argv.length) datasetPath = resolve(argv[++i]);
		else if (argv[i] === "--html" && i + 1 < argv.length) outHtmlPath = resolve(argv[++i]);
		else if (argv[i] === "--workspace" && i + 1 < argv.length) workspaceDir = argv[++i];
	}

	const config = loadAssistantConfig({ workspaceDir });
	const workspace = resolveWorkspacePaths(config.workspace);
	const dataset = loadRagEvalDataset(datasetPath);
	const store = new HybridIndexStore(workspace);
	const client = new OllamaClient(config.ollama);
	const retriever = new HybridRetriever(store, client, workspace.eventsDir);

	try {
		const report = await runRagAblationSuite(retriever, dataset);
		console.log(formatRagAblationMarkdown(report));
		if (outHtmlPath) {
			mkdirSync(dirname(outHtmlPath), { recursive: true });
			writeFileSync(outHtmlPath, formatRagAblationHtml(report), "utf8");
			console.log(`\nHTML report written to: ${outHtmlPath}`);
		}
	} finally {
		store.close();
	}
}

const isDirectEntry =
	process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectEntry && existsSync(fileURLToPath(new URL("../golden/rag-dataset.sample.jsonl", import.meta.url)))) {
	await runRagEvalCli();
}
