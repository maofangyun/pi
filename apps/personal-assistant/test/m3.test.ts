// Milestone 3 unit tests: Layer 1 YAML Profile, Layer 2 ADD-only JSONL Events & supersedes,
// Markdown/PDF parsing, structure-aware chunking with atomic block protection, Node 22 SQLite FTS5 + vector store,
// incremental manifest + full rebuild, RRF hybrid retrieval + rerank ablation, and Agentic RAG tools.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	SessionEntry,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadAssistantConfig } from "../src/config.ts";
import type { AssistantRuntime } from "../src/extension.ts";
import {
	attachMemoryEventModule,
	EventStore,
	EventValidationError,
	resolveSupersedesMap,
} from "../src/memory/event-store.ts";
import {
	type ProfileCard,
	ProfileStore,
	ProfileValidationError,
	validateProfileCard,
} from "../src/memory/profile-store.ts";
import { chunkDocument, enrichChunksWithL2Prefix } from "../src/rag/chunker.ts";
import { HybridIndexStore, tokenizeForFts } from "../src/rag/index-store.ts";
import { OllamaClient, type RagModelClient } from "../src/rag/ollama-client.ts";
import { normalizeParsedPdf, parseMarkdownDocument, type RawPdfPayload } from "../src/rag/parser.ts";
import { HybridRetriever, isExactLexicalQuery } from "../src/rag/retriever.ts";
import { attachRagModule, readKnowledgeIndexOverview } from "../src/rag/tools.ts";
import { initWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];
const storesToClose: HybridIndexStore[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createTestRuntime(overrides?: Record<string, string>): AssistantRuntime {
	const root = createTempDir("pa-m3-");
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

/** Deterministic topic-based mock embedding client so semantic synonym recall is testable offline. */
function createMockRagClient(options?: { rerankBoostPhrase?: string }): RagModelClient {
	const topicRules: Array<{ keywords: string[]; dim: number }> = [
		{ keywords: ["差旅", "出差", "报销", "住宿", "补贴", "酒店"], dim: 0 },
		{ keywords: ["utf-8-bom", "csv", "excel", "乱码", "金额"], dim: 1 },
		{ keywords: ["pdf", "页码", "财报", "营收", "毛利率", "季度"], dim: 2 },
		{ keywords: ["笔记", "双链", "markdown", "三层分离", "归档"], dim: 3 },
		{ keywords: ["docker", "沙箱", "断网", "容器", "只读"], dim: 4 },
		{ keywords: ["架构", "向量", "sqlite", "fts5", "混合检索"], dim: 5 },
	];

	const encode = (text: string): Float32Array => {
		const lower = text.toLowerCase();
		const vec = new Float32Array(8);
		vec[7] = 0.05; // tiny baseline to avoid zero vector
		for (const rule of topicRules) {
			for (const kw of rule.keywords) {
				if (lower.includes(kw)) {
					vec[rule.dim] += 1;
				}
			}
		}
		return vec;
	};

	return {
		async embed(texts) {
			return texts.map(encode);
		},
		async rerank(query, documents) {
			const boost = options?.rerankBoostPhrase?.toLowerCase();
			const qLower = query.toLowerCase();
			return documents
				.map((doc, index) => {
					const dLower = doc.toLowerCase();
					let score = 0.1;
					if (boost && dLower.includes(boost)) score += 10;
					for (const token of qLower.split(/\s+/).filter(Boolean)) {
						if (dLower.includes(token)) score += 1;
					}
					return { index, score };
				})
				.sort((a, b) => b.score - a.score);
		},
		async healthCheck() {
			return {
				reachable: true,
				baseUrl: "http://127.0.0.1:11434",
				installedModels: ["bge-m3", "bge-reranker-v2-m3", "qwen2.5:3b"],
				missingModels: [],
			};
		},
	};
}

function createFakeExtensionHarness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const tools = new Map<string, ToolDefinition>();

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
	} as unknown as ExtensionAPI;

	return {
		pi,
		async emit(event: string, payload: unknown, ctx: unknown) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
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

describe("M3 Layer 1 ProfileStore (YAML preference cards)", () => {
	it("strictly validates schema, compiles confirmed active cards within budget, and stages updates as proposals", () => {
		const runtime = createTestRuntime();
		const store = new ProfileStore(runtime.workspace.profileDir, runtime.workspace.knowledgeDir);

		const validCard: ProfileCard = {
			id: "pref-csv-export-encoding",
			category: "workflow.data_processing",
			key: "csv_export_encoding",
			value: "导出供 Excel 打开的中文 CSV 默认使用 UTF-8-BOM，金额保留两位小数",
			scope: "仅限 CSV 导出，不适用于代码文件与 JSON",
			status: "active",
			confidence: "confirmed",
			backstory: "处理财务报表时遇到 Excel 打开 UTF-8 CSV 中文乱码",
			evidence_refs: [{ session: "2026-11-20-csv-clean", turn: 3 }],
			created_at: "2026-11-20T14:10:00+08:00",
			updated_at: "2026-11-20T14:10:00+08:00",
		};

		// Proposal must write to .drafts/ and NOT silently apply to main profile directory.
		const proposal = store.proposeCardUpdate(validCard, { createGitBranch: true });
		expect(proposal.requiresApproval).toBe(true);
		expect(existsSync(proposal.proposalPath)).toBe(true);
		expect(proposal.branchName).toMatch(/^assistant\/profile-pref-csv-export-encoding-/);
		expect(store.listCards()).toHaveLength(0);

		// Apply after explicit approval.
		store.applyApprovedCard(validCard);
		store.applyApprovedCard({
			...validCard,
			id: "pref-inferred-only",
			confidence: "inferred",
			value: "不应被注入的推断偏好",
		});

		expect(store.listCards()).toHaveLength(2);
		const compiled = store.compileUserProfile(1500);
		expect(compiled).toContain("UTF-8-BOM");
		expect(compiled).not.toContain("不应被注入的推断偏好");

		// Invalid card without scope or evidence_refs is rejected.
		expect(() => validateProfileCard({ id: "bad", category: "a" })).toThrowError(ProfileValidationError);
	});
});

describe("M3 Layer 2 EventStore (ADD-only JSONL & supersedes chains)", () => {
	it("appends events without overwriting prior lines and resolves transitive supersedes annotations", () => {
		const runtime = createTestRuntime();
		const store = new EventStore(runtime.workspace.eventsDir);

		store.append({
			id: "evt-20261101-001",
			session_id: "s1",
			timestamp: "2026-11-01T10:00:00+08:00",
			topic: "向量库选型",
			entities: ["SQLite", "RAG"],
			summary: "初步打算使用外部 Qdrant 服务。",
			decisions: ["尝试 Qdrant"],
			open_items: [],
			artifacts: [],
			supersedes: null,
			evidence_ref: "evidence/sessions/s1.jsonl#L1-L20",
		});

		const { filePath } = store.append({
			id: "evt-20261126-002",
			session_id: "s2",
			timestamp: "2026-11-26T21:30:00+08:00",
			topic: "向量库选型变更",
			entities: ["node:sqlite", "RAG"],
			summary: "改用 Node 22 内置 node:sqlite 存 FTS5 与 float32 向量，零原生编译。",
			decisions: ["改用 node:sqlite"],
			open_items: [],
			artifacts: ["apps/personal-assistant/src/rag/index-store.ts"],
			supersedes: "evt-20261101-001",
			evidence_ref: "evidence/sessions/s2.jsonl#L1-L40",
		});

		const lines = readFileSync(filePath, "utf8").trim().split(/\r?\n/);
		expect(lines).toHaveLength(2);

		const annotated = store.loadAnnotated();
		expect(annotated[0].supersededBy?.annotation).toBe("[已于 2026-11-26 被 evt-20261126-002 更新]");
		expect(annotated[1].supersededBy).toBeUndefined();

		const map = resolveSupersedesMap(store.loadAll());
		expect(map.get("evt-20261101-001")?.supersededById).toBe("evt-20261126-002");

		expect(() =>
			store.append({
				id: "",
				session_id: "s",
				timestamp: "2026-11-26T00:00:00Z",
				topic: "bad",
				entities: [],
				summary: "bad",
				decisions: [],
				open_items: [],
				artifacts: [],
				supersedes: null,
				evidence_ref: "x",
			}),
		).toThrowError(EventValidationError);
	});

	it("extracts session event automatically on normal shutdown and skips on abnormal exit", async () => {
		const runtime = createTestRuntime();
		const harness = createFakeExtensionHarness();
		let abnormal = false;

		const store = attachMemoryEventModule(harness.pi, runtime, {
			isAbnormalShutdown: () => abnormal,
			getTodos: () => [{ id: "t1", title: "完成索引验证", status: "completed", updatedAt: "2026-11-28T10:00:00Z" }],
		});

		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-11-28T10:00:00Z",
				message: { role: "user", content: "整理个人知识库目录架构", timestamp: 1 },
			},
			{
				type: "message",
				id: "m2",
				parentId: "m1",
				timestamp: "2026-11-28T10:01:00Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "已完成三层目录初始化与索引验证。" }],
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

		const ctx = {
			sessionManager: {
				getSessionId: () => "sess-shutdown-1",
				getSessionFile: () => join(runtime.workspace.sessionsDir, "sess-shutdown-1.jsonl"),
				getBranch: () => entries,
			},
		} as unknown as ExtensionContext;

		// Abnormal shutdown must NOT write a memory event.
		abnormal = true;
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		expect(store.loadAll()).toHaveLength(0);

		// Normal shutdown appends exactly 1 event.
		abnormal = false;
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
		const events = store.loadAll();
		expect(events).toHaveLength(1);
		expect(events[0].topic).toContain("整理个人知识库目录架构");
		expect(events[0].decisions).toContain("完成索引验证");
	});
});

describe("M3 Markdown/PDF parsing and structure-aware chunking", () => {
	it("preserves Markdown frontmatter, H1-H3 hierarchy, wikilinks, atomic code/table/math blocks, and L1/L2 prefixes", async () => {
		const bigCodeBody = Array.from({ length: 35 }, (_, i) => `const line_${i} = "atomic_code_guard_${i}";`).join(
			"\n",
		);
		const bigTableRows = Array.from({ length: 18 }, (_, i) => `| 项目_${i} | ${(i + 1) * 100}.00 | 正常 |`).join(
			"\n",
		);

		const md = [
			"---",
			'title: "财务自动化规范"',
			"tags:",
			"  - finance",
			"  - automation",
			"date: 2026-11-28",
			"---",
			"",
			"# 财务自动化规范",
			"",
			"## 数据清洗",
			"",
			"参考 [[CSV编码规则]] 与 [[报表核对清单|核对清单]]。本节说明核心脚本模板：",
			"",
			"```ts",
			bigCodeBody,
			"```",
			"",
			"### 核对指标表",
			"",
			"| 指标名 | 金额 | 状态 |",
			"| --- | --- | --- |",
			bigTableRows,
			"",
			"$$",
			"\\text{GrossMargin} = \\frac{\\text{Revenue} - \\text{COGS}}{\\text{Revenue}}",
			"$$",
		].join("\n");

		const parsed = parseMarkdownDocument(md, "knowledge/notes/finance/spec.md", "2026-11-28T00:00:00Z");
		expect(parsed.title).toBe("财务自动化规范");
		expect(parsed.tags).toEqual(["finance", "automation"]);
		expect(parsed.wikilinks).toEqual(["CSV编码规则", "报表核对清单"]);

		const chunks = chunkDocument(parsed, { targetTokens: 220, maxTokens: 320, atomicMaxTokens: 1200 });
		expect(chunks.length).toBeGreaterThanOrEqual(2);

		// Verify atomic fenced code block was NOT cut in half.
		const codeChunk = chunks.find((c) => c.content.includes("atomic_code_guard_0"));
		expect(codeChunk).toBeDefined();
		expect(codeChunk?.content).toContain("atomic_code_guard_34");
		expect(codeChunk?.content.startsWith("```ts") || codeChunk?.content.includes("```ts")).toBe(true);
		expect(codeChunk?.contextPrefix).toContain(
			"[文档: 财务自动化规范 | 路径: knowledge/notes/finance/spec.md | 章节: 财务自动化规范 > 数据清洗",
		);

		// Verify atomic table was NOT split mid-table.
		const tableChunk = chunks.find((c) => c.content.includes("项目_0"));
		expect(tableChunk).toBeDefined();
		expect(tableChunk?.content).toContain("项目_17");

		// Verify atomic math block intact.
		const mathChunk = chunks.find((c) => c.content.includes("GrossMargin"));
		expect(mathChunk?.content).toContain("$$");

		// Verify optional L2 semantic prefix enrichment.
		const enriched = await enrichChunksWithL2Prefix(chunks.slice(0, 1), async () => "财务 CSV 清洗脚本规范说明");
		expect(enriched[0].indexedText).toContain("[背景: 财务 CSV 清洗脚本规范说明]");
	});

	it("strips repeated PDF headers/footers, stitches cross-page sentences with page_range, and flags scanned pages", () => {
		const rawPdf: RawPdfPayload = {
			title: "2026 Q3 经营分析报告",
			page_count: 4,
			pages: [
				{
					page: 1,
					text: "内部机密 - Q3 报告\n第1章 营收概览\n本季度整体营收实现稳健增长，核心驱动因素来自企业级订阅。\n第 1 页",
					image_count: 0,
				},
				{
					page: 2,
					text: "内部机密 - Q3 报告\n第2章 成本拆解\n云基础设施推理成本较上季度显著下降，主要归功于提示词缓存命中率提升至",
					image_count: 0,
				},
				{
					page: 3,
					text: "内部机密 - Q3 报告\n87.5%，同时单次批处理吞吐提升了三倍。\n第 3 页",
					tables_markdown: ["| 科目 | Q2 | Q3 |\n| --- | --- | --- |\n| 推理成本 | 120万 | 78万 |"],
					image_count: 0,
				},
				{
					page: 4,
					text: "内部机密 - Q3 报告\n第 4 页",
					effective_chars: 0,
					image_count: 2,
				},
			],
		};

		const parsed = normalizeParsedPdf(rawPdf, "evidence/raw_pdfs/q3-report.pdf", "2026-11-28T00:00:00Z");
		expect(parsed.scannedPages).toEqual([4]);

		const chunks = chunkDocument(parsed);
		// Repeated header must be stripped.
		expect(chunks.every((c) => !c.content.includes("内部机密 - Q3 报告"))).toBe(true);

		// Cross-page sentence from page 2 -> page 3 must be merged and carry exact page_range [2, 3].
		const crossPageChunk = chunks.find((c) => c.content.includes("提示词缓存命中率提升至87.5%"));
		expect(crossPageChunk).toBeDefined();
		expect(crossPageChunk?.pageStart).toBe(2);
		expect(crossPageChunk?.pageEnd).toBe(3);
		expect(crossPageChunk?.contextPrefix).toContain("页码: p2-p3");
		expect(crossPageChunk?.content).toContain("| 推理成本 | 120万 | 78万 |");
	});
});

describe("M3 Hybrid SQLite Index + RRF Retriever + Reranker + Agentic RAG Tools", () => {
	it("indexes 50+ notes, PDF, and conflicting events; supports incremental sync, full rebuild, and 4 hard query types", async () => {
		const runtime = createTestRuntime();
		const notesFinanceDir = join(runtime.workspace.notesDir, "finance");
		const notesTechDir = join(runtime.workspace.notesDir, "tech");
		mkdirSync(notesFinanceDir, { recursive: true });
		mkdirSync(notesTechDir, { recursive: true });

		// Write 50 background Markdown notes + 3 targeted notes.
		for (let i = 1; i <= 50; i++) {
			writeFileSync(
				join(notesTechDir, `note-${String(i).padStart(3, "0")}.md`),
				`---\ntitle: "常规笔记 ${i}"\ntags: [general]\ndate: 2026-11-01\n---\n# 常规笔记 ${i}\n\n这是第 ${i} 篇普通记录，用于验证百篇级增量索引稳定性。`,
				"utf8",
			);
		}

		writeFileSync(
			join(notesFinanceDir, "csv-rule.md"),
			`---\ntitle: "CSV 导出编码规则"\ntags: [finance, csv]\ndate: 2026-11-20\n---\n# CSV 导出编码规则\n\n处理财务导出时，文件 \`src/export_utf8.py\` 必须使用 UTF-8-BOM 编码并校验 CUST-9981 科目汇总。`,
			"utf8",
		);
		writeFileSync(
			join(notesFinanceDir, "travel-policy.md"),
			`---\ntitle: "出差住宿补贴上限"\ntags: [finance, policy]\ndate: 2026-11-22\n---\n# 出差住宿补贴上限\n\n一线城市出差酒店每晚补贴上限为 650 元，二线城市为 450 元，需附电子发票。`,
			"utf8",
		);

		// Write a dummy PDF placeholder file (parsed via customExtractor in test).
		const pdfAbsPath = join(runtime.workspace.rawPdfsDir, "annual-review.pdf");
		writeFileSync(pdfAbsPath, "%PDF-1.4 mock", "utf8");

		// Write conflicting Layer 2 events with supersedes.
		const eventStore = new EventStore(runtime.workspace.eventsDir);
		eventStore.append({
			id: "evt-20261110-001",
			session_id: "s-old",
			timestamp: "2026-11-10T09:00:00+08:00",
			topic: "Docker 沙箱网络策略",
			entities: ["Docker", "沙箱"],
			summary: "旧决定：沙箱默认开启外网访问以便 pip install。",
			decisions: ["默认联网"],
			open_items: [],
			artifacts: [],
			supersedes: null,
			evidence_ref: "evidence/sessions/s-old.jsonl#L1-L15",
		});
		eventStore.append({
			id: "evt-20261125-002",
			session_id: "s-new",
			timestamp: "2026-11-25T18:00:00+08:00",
			topic: "Docker 沙箱网络策略收紧",
			entities: ["Docker", "沙箱"],
			summary: "新决定：沙箱默认强制 --network=none 断网运行，仅人工批准后临时放行。",
			decisions: ["默认断网 --network=none"],
			open_items: [],
			artifacts: [],
			supersedes: "evt-20261110-001",
			evidence_ref: "evidence/sessions/s-new.jsonl#L1-L30",
		});

		const mockPdfExtractor = (): RawPdfPayload => ({
			title: "年度架构复盘",
			page_count: 3,
			pages: [
				{ page: 1, text: "第1章 总览\n本报告总结混合检索系统的核心收益。" },
				{ page: 2, text: "第2章 性能数据\n在千篇笔记规模下，SQLite FTS5 与向量混合检索的 P95 延迟控制在" },
				{ page: 3, text: "38 毫秒以内，recall@10 达到 94.2%。" },
			],
		});

		const modelClient = createMockRagClient({ rerankBoostPhrase: "650 元" });
		const indexStore = new HybridIndexStore(runtime.workspace);
		storesToClose.push(indexStore);

		const sync1 = await indexStore.syncWorkspace(runtime.workspace, modelClient, {
			pdfOptions: { customExtractor: mockPdfExtractor },
		});
		expect(sync1.indexedFiles).toBe(55); // 52 md + _index.md + 1 pdf + 1 jsonl
		expect(sync1.skippedFiles).toBe(0);
		expect(sync1.totalChunks).toBeGreaterThanOrEqual(56);

		// Second incremental sync skips 100% unchanged files.
		const sync2 = await indexStore.syncWorkspace(runtime.workspace, modelClient, {
			pdfOptions: { customExtractor: mockPdfExtractor },
		});
		expect(sync2.indexedFiles).toBe(0);
		expect(sync2.skippedFiles).toBe(55);

		const retriever = new HybridRetriever(indexStore, modelClient, runtime.workspace.eventsDir);

		// 1. Exact lexical/path query tilts RRF to 0.7/0.3 and retrieves exact file.
		expect(isExactLexicalQuery("src/export_utf8.py CUST-9981")).toBe(true);
		const q1 = await retriever.retrieve({ query: "src/export_utf8.py CUST-9981", useReranker: false });
		expect(q1.weights).toEqual({ bm25: 0.7, vector: 0.3 });
		expect(q1.hits[0]?.docPath).toContain("csv-rule.md");

		// 2. Semantic synonym query (no shared characters between "差旅报销标准" and "出差住宿补贴上限") via vector recall.
		const q2 = await retriever.retrieve({
			query: "差旅报销标准",
			filter: { sourceTypes: ["markdown"] },
			useReranker: true,
		});
		expect(q2.rerankerApplied).toBe(true);
		expect(q2.hits[0]?.docPath).toContain("travel-policy.md");
		expect(q2.hits[0]?.content).toContain("650 元");

		// 3. Cross-page PDF query returns exact pageRange [2, 3].
		const q3 = await retriever.retrieve({
			query: "P95 延迟 recall@10",
			filter: { sourceTypes: ["pdf"] },
			useReranker: false,
		});
		expect(q3.hits[0]?.docPath).toContain("annual-review.pdf");
		expect(q3.hits[0]?.pageRange).toEqual([2, 3]);

		// 4. Conflicting Layer 2 memory query annotates superseded event.
		const q4 = await retriever.retrieve({
			query: "Docker 沙箱 网络策略",
			filter: { sourceTypes: ["memory_event"] },
			useReranker: false,
		});
		const oldHit = q4.hits.find((h) => h.eventId === "evt-20261110-001");
		const newHit = q4.hits.find((h) => h.eventId === "evt-20261125-002");
		expect(oldHit?.supersededAnnotation).toBe("[已于 2026-11-25 被 evt-20261125-002 更新]");
		expect(newHit?.supersededAnnotation).toBeUndefined();

		// 5. Wipe index/ and verify full rebuild restores all chunks.
		indexStore.resetIndexFiles();
		expect(existsSync(runtime.workspace.ftsDbPath)).toBe(false);
		const sync3 = await indexStore.syncWorkspace(runtime.workspace, modelClient, {
			fullRebuild: true,
			pdfOptions: { customExtractor: mockPdfExtractor },
		});
		expect(sync3.indexedFiles).toBe(55);
		expect(sync3.totalChunks).toBe(sync1.totalChunks);

		// 6. Test Agentic RAG tools & browse_knowledge_index traversal guard.
		const harness = createFakeExtensionHarness();
		const rag = attachRagModule(harness.pi, runtime, { modelClient });
		storesToClose.push(rag.indexStore);

		const ctx = {
			hasUI: false,
			ui: { notify() {} },
		} as unknown as ExtensionToolContext & ExtensionCommandContext;

		const skTool = harness.getTool("search_knowledge");
		const skRes = await skTool.execute("t1", { query: "UTF-8-BOM", type: "markdown" }, undefined, undefined, ctx);
		expect(skRes.content[0].type === "text" ? skRes.content[0].text : "").toContain("csv-rule.md");

		const smTool = harness.getTool("search_memory");
		const smRes = await smTool.execute("t2", { query: "沙箱 网络", entities: ["Docker"] }, undefined, undefined, ctx);
		expect(smRes.content[0].type === "text" ? smRes.content[0].text : "").toContain(
			"[已于 2026-11-25 被 evt-20261125-002 更新]",
		);

		const browseTool = harness.getTool("browse_knowledge_index");
		const rootIdxRes = await browseTool.execute("t3", {}, undefined, undefined, ctx);
		expect(rootIdxRes.content[0].type === "text" ? rootIdxRes.content[0].text : "").toContain("个人知识库目录索引");
		expect(readKnowledgeIndexOverview(runtime.workspace.notesDir, "../../etc")).toContain("超出知识库笔记目录边界");

		// Verify FTS tokenizer handles mixed Chinese + hyphenated technical tokens.
		const tokens = tokenizeForFts("导出 UTF-8-BOM 财务报表");
		expect(tokens).toContain("utf-8-bom");
		expect(tokens).toContain("财务");
	});

	it("OllamaClient parses /api/embed, /api/rerank, and /api/tags healthCheck cleanly", async () => {
		const fakeFetch: typeof fetch = async (input) => {
			const url = String(input);
			if (url.endsWith("/api/embed")) {
				return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), { status: 200 });
			}
			if (url.endsWith("/api/rerank")) {
				return new Response(
					JSON.stringify({
						results: [
							{ index: 1, relevance_score: 0.92 },
							{ index: 0, relevance_score: 0.15 },
						],
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/api/tags")) {
				return new Response(JSON.stringify({ models: [{ name: "bge-m3:latest" }, { name: "qwen2.5:3b" }] }), {
					status: 200,
				});
			}
			return new Response("not found", { status: 404 });
		};

		const client = new OllamaClient(
			{
				baseUrl: "http://127.0.0.1:11434",
				embedModel: "bge-m3",
				rerankModel: "bge-reranker-v2-m3",
				sidecarModel: "qwen2.5:3b",
			},
			{ fetchFn: fakeFetch },
		);

		const vecs = await client.embed(["hello"]);
		expect(vecs).toHaveLength(1);
		expect(vecs[0][0]).toBeCloseTo(0.1);

		const ranked = await client.rerank("q", ["docA", "docB"]);
		expect(ranked[0].index).toBe(1);
		expect(ranked[0].score).toBeCloseTo(0.92);

		const health = await client.healthCheck();
		expect(health.reachable).toBe(true);
		expect(health.missingModels).toEqual(["bge-reranker-v2-m3"]);
	});
});
