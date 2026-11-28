// Agentic RAG tools (search_knowledge, search_memory, browse_knowledge_index) and /reindex command.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";
import type { ChunkSourceType } from "./chunker.ts";
import { HybridIndexStore, type MetadataFilter } from "./index-store.ts";
import { OllamaClient, type RagModelClient } from "./ollama-client.ts";
import { formatRetrievedHits, HybridRetriever } from "./retriever.ts";

export interface AttachRagOptions {
	modelClient?: RagModelClient;
}

export interface AttachedRagModule {
	indexStore: HybridIndexStore;
	retriever: HybridRetriever;
	modelClient: RagModelClient;
}

const SearchKnowledgeParams = Type.Object({
	query: Type.String({ description: "检索查询词（支持精确术语/路径/代码符号或模糊语义问题）" }),
	type: Type.Optional(
		Type.Union([Type.Literal("markdown"), Type.Literal("pdf"), Type.Literal("all")], {
			description: "限定来源类型：markdown、pdf 或 all（默认 all）",
		}),
	),
	dir: Type.Optional(Type.String({ description: "可选目录子路径预过滤（如 notes/finance）" })),
	tags: Type.Optional(Type.Array(Type.String(), { description: "可选标签列表预过滤" })),
	top_k: Type.Optional(Type.Number({ description: "返回条数，默认 8（建议 6-8）", minimum: 1, maximum: 20 })),
});

const SearchMemoryParams = Type.Object({
	query: Type.String({ description: "跨会话情景记忆检索问题或主题关键词" }),
	time_range: Type.Optional(
		Type.Object({
			from: Type.Optional(Type.String({ description: "起始日期 YYYY-MM-DD" })),
			to: Type.Optional(Type.String({ description: "结束日期 YYYY-MM-DD" })),
		}),
	),
	entities: Type.Optional(Type.Array(Type.String(), { description: "可选实体名称过滤" })),
	top_k: Type.Optional(Type.Number({ description: "返回条数，默认 6", minimum: 1, maximum: 20 })),
});

const BrowseKnowledgeIndexParams = Type.Object({
	dir: Type.Optional(Type.String({ description: "相对于 knowledge/notes 的子目录，省略时读取根目录 _index.md" })),
});

/** Read or synthesize the directory-level L0/L1 overview for knowledge/notes/. */
export function readKnowledgeIndexOverview(notesDir: string, subDir?: string): string {
	const baseDir = resolve(notesDir);
	const targetDir = subDir && subDir.trim().length > 0 ? resolve(baseDir, subDir.trim()) : baseDir;

	// Guard against directory traversal outside notesDir.
	const rel = relative(baseDir, targetDir);
	if (rel.startsWith("..") || rel.includes(":")) {
		return `错误：目录 "${subDir}" 超出知识库笔记目录边界。`;
	}
	if (!existsSync(targetDir)) {
		return `目录不存在：${subDir || "knowledge/notes"}`;
	}

	const indexFile = join(targetDir, "_index.md");
	if (existsSync(indexFile)) {
		return readFileSync(indexFile, "utf8");
	}

	// Synthesize a concise L0 directory listing when _index.md does not exist in a subdirectory.
	const entries = readdirSync(targetDir, { withFileTypes: true })
		.filter((e) => !e.name.startsWith("."))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (entries.length === 0) {
		return `目录 ${subDir || "knowledge/notes"} 当前为空。`;
	}

	const lines = [`# 目录概览: ${subDir || "knowledge/notes"}`, ""];
	for (const entry of entries) {
		lines.push(entry.isDirectory() ? `- [dir] ${entry.name}/` : `- [file] ${entry.name}`);
	}
	return lines.join("\n");
}

/** Register Agentic RAG tools (search_knowledge, search_memory, browse_knowledge_index) and /reindex. */
export function attachRagModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options: AttachRagOptions = {},
): AttachedRagModule {
	const indexStore = new HybridIndexStore(runtime.workspace);
	const modelClient = options.modelClient ?? new OllamaClient(runtime.config.ollama);
	const retriever = new HybridRetriever(indexStore, modelClient, runtime.workspace.eventsDir);

	pi.registerTool({
		name: "search_knowledge",
		label: "Search Knowledge",
		description:
			"在个人 Markdown 笔记与 PDF 知识库中执行混合检索（BM25 中文分词 + 本地 Ollama 向量 + RRF 融合 + 可选精排），强制附带路径、章节与页码出处。",
		promptSnippet: "混合检索个人 Markdown 笔记与 PDF 知识库（附精确路径与页码出处）",
		parameters: SearchKnowledgeParams,
		async execute(_toolCallId, params) {
			const sourceTypes: ChunkSourceType[] =
				params.type === "markdown" ? ["markdown"] : params.type === "pdf" ? ["pdf"] : ["markdown", "pdf"];
			const filter: MetadataFilter = {
				sourceTypes,
				dir: params.dir,
				tags: params.tags,
			};
			const result = await retriever.retrieve({
				query: params.query,
				filter,
				topK: params.top_k ?? 8,
				useReranker: runtime.config.features.reranker,
			});

			return {
				content: [{ type: "text", text: formatRetrievedHits(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "search_memory",
		label: "Search Memory",
		description:
			"检索跨会话 Layer 2 情景记忆日志（knowledge/memory/events/YYYY-MM.jsonl），自动标注已被后续决定取代（supersedes）的历史记录。",
		promptSnippet: "检索跨会话历史决定与情景记忆（自动标注 supersedes 更新链）",
		parameters: SearchMemoryParams,
		async execute(_toolCallId, params) {
			const filter: MetadataFilter = {
				sourceTypes: ["memory_event"],
				entities: params.entities,
				timeFrom: params.time_range?.from,
				timeTo: params.time_range?.to,
			};
			const result = await retriever.retrieve({
				query: params.query,
				filter,
				topK: params.top_k ?? 6,
				useReranker: runtime.config.features.reranker,
			});

			return {
				content: [{ type: "text", text: formatRetrievedHits(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "browse_knowledge_index",
		label: "Browse Knowledge Index",
		description: "读取个人知识库目录级 L0/L1 概览（_index.md 或子目录结构），用于先导航再精确读取。",
		promptSnippet: "浏览知识库目录 L0/L1 概览 _index.md",
		parameters: BrowseKnowledgeIndexParams,
		async execute(_toolCallId, params) {
			const text = readKnowledgeIndexOverview(runtime.workspace.notesDir, params.dir);
			return {
				content: [{ type: "text", text }],
				details: { dir: params.dir ?? "" },
			};
		},
	});

	pi.registerCommand("reindex", {
		description: "增量更新本地混合 RAG 索引（加 --full 清空 index/ 并全量重建）",
		handler: async (args, ctx) => {
			const fullRebuild = args.trim().includes("--full");
			const summary = await indexStore.syncWorkspace(runtime.workspace, modelClient, { fullRebuild });
			const lines = [
				`RAG 索引${fullRebuild ? "全量重建" : "增量同步"}完成：更新 ${summary.indexedFiles} 个文件，跳过 ${summary.skippedFiles} 个未变文件，移除 ${summary.removedFiles} 个失效文件，当前共 ${summary.totalChunks} 个索引块。`,
			];
			if (summary.scannedPdfNotices.length > 0) {
				lines.push(
					`检测到需视觉/OCR 处理的扫描 PDF 页：${summary.scannedPdfNotices.map((n) => `${n.relPath}(p${n.pages.join(",")})`).join("；")}`,
				);
			}
			if (summary.warnings.length > 0) {
				lines.push(`警告（${summary.warnings.length}）：${summary.warnings.slice(0, 3).join("；")}`);
			}
			const output = lines.join("\n");
			if (ctx.hasUI) {
				ctx.ui.notify(output, summary.warnings.length > 0 ? "warning" : "info");
			} else {
				console.log(output);
			}
		},
	});

	pi.on("session_shutdown", () => {
		indexStore.close();
	});

	return { indexStore, retriever, modelClient };
}
