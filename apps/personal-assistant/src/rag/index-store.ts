// Local hybrid index store built on Node 22 built-in node:sqlite (FTS5 + float32 vector BLOBs),
// Intl.Segmenter("zh-CN") Chinese tokenization, and SHA-256 manifest.json incremental updates.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateMemoryEvent } from "../memory/event-store.ts";
import type { WorkspacePaths } from "../workspace.ts";
import { type ChunkSourceType, chunkDocument, chunkMemoryEvent, type DocumentChunk } from "./chunker.ts";
import type { RagModelClient } from "./ollama-client.ts";
import { type PdfExtractOptions, parseMarkdownDocument, parsePdfDocument } from "./parser.ts";

export interface ManifestFileEntry {
	sha256: string;
	mtimeMs: number;
	chunkCount: number;
	sourceType: ChunkSourceType;
	scannedPages?: number[];
}

export interface IndexManifest {
	version: 1;
	updatedAt: string;
	files: Record<string, ManifestFileEntry>;
}

export interface IndexedChunkRecord {
	chunkId: string;
	docPath: string;
	sourceType: ChunkSourceType;
	title: string;
	section: string;
	pageStart: number | null;
	pageEnd: number | null;
	tags: string[];
	entities: string[];
	updatedAt: string;
	contextPrefix: string;
	content: string;
	chunkIndex: number;
	eventId: string | null;
	supersedes: string | null;
}

export interface ScoredChunkHit {
	chunk: IndexedChunkRecord;
	score: number;
}

export interface MetadataFilter {
	sourceTypes?: ChunkSourceType[];
	dir?: string;
	tags?: string[];
	entities?: string[];
	timeFrom?: string;
	timeTo?: string;
}

export interface SyncIndexOptions {
	fullRebuild?: boolean;
	pdfOptions?: PdfExtractOptions;
	embedBatchSize?: number;
}

export interface SyncIndexResult {
	indexedFiles: number;
	skippedFiles: number;
	removedFiles: number;
	totalChunks: number;
	scannedPdfNotices: Array<{ relPath: string; pages: number[] }>;
	warnings: string[];
}

const zhSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
const CJK_RUN_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]+/g;
const EXACT_IDENTIFIER_REGEX = /[A-Za-z0-9_./:-]{2,}/g;

/**
 * Tokenize mixed Chinese/English/code text for SQLite FTS5 indexing and querying:
 * - Uses Node's built-in Intl.Segmenter("zh-CN") for Chinese word segmentation;
 * - Adds CJK bigrams for compound Chinese term recall;
 * - Preserves exact ASCII code/path/hyphenated identifiers (e.g. UTF-8-BOM, CUST-9981, src/config.ts).
 */
export function tokenizeForFts(text: string): string[] {
	const tokens: string[] = [];

	for (const seg of zhSegmenter.segment(text)) {
		if (!seg.isWordLike) continue;
		const cleaned = seg.segment.trim().toLowerCase();
		if (cleaned.length > 0) {
			tokens.push(cleaned);
		}
	}

	// Preserve hyphenated / dotted / slashed exact technical identifiers intact.
	for (const match of text.matchAll(EXACT_IDENTIFIER_REGEX)) {
		const raw = match[0].toLowerCase().replace(/^[.:/-]+|[.:/-]+$/g, "");
		if (raw.length >= 2 && /[-_./:]/.test(raw)) {
			tokens.push(raw);
		}
	}

	// Add CJK character bigrams so multi-character Chinese phrases match even across segmentation variations.
	for (const match of text.matchAll(CJK_RUN_REGEX)) {
		const run = match[0];
		if (run.length >= 2) {
			for (let i = 0; i < run.length - 1; i++) {
				tokens.push(run.slice(i, i + 2));
			}
		}
	}

	return tokens;
}

/** Build a safe SQLite FTS5 MATCH expression from raw user query text. */
export function buildFtsMatchQuery(query: string): string {
	const unique = [...new Set(tokenizeForFts(query))].slice(0, 32);
	if (unique.length === 0) return "";
	return unique.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(" OR ");
}

/** Cosine similarity between two equal-length Float32Arrays. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i];
		const bv = b[i];
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Node 22 node:sqlite dual-index store (index/fts.sqlite + index/vectors.db + index/manifest.json). */
export class HybridIndexStore {
	private readonly indexDir: string;
	private readonly ftsDbPath: string;
	private readonly vectorsDbPath: string;
	private readonly manifestPath: string;
	private ftsDb: DatabaseSync | undefined;
	private vectorsDb: DatabaseSync | undefined;

	constructor(paths: Pick<WorkspacePaths, "indexDir" | "ftsDbPath" | "vectorsDbPath" | "manifestPath">) {
		this.indexDir = paths.indexDir;
		this.ftsDbPath = paths.ftsDbPath;
		this.vectorsDbPath = paths.vectorsDbPath;
		this.manifestPath = paths.manifestPath;
	}

	/** Open (or create) both SQLite databases and initialize schemas idempotently. */
	open(): void {
		if (this.ftsDb && this.vectorsDb) return;
		mkdirSync(this.indexDir, { recursive: true });

		this.ftsDb = new DatabaseSync(this.ftsDbPath);
		this.ftsDb.exec(`
			PRAGMA journal_mode = WAL;
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
				chunk_id UNINDEXED,
				doc_path UNINDEXED,
				tokens
			);
		`);

		this.vectorsDb = new DatabaseSync(this.vectorsDbPath);
		this.vectorsDb.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS chunks (
				chunk_id TEXT PRIMARY KEY,
				doc_path TEXT NOT NULL,
				source_type TEXT NOT NULL,
				title TEXT NOT NULL,
				section TEXT NOT NULL,
				page_start INTEGER,
				page_end INTEGER,
				tags_json TEXT NOT NULL,
				entities_json TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				context_prefix TEXT NOT NULL,
				content TEXT NOT NULL,
				chunk_index INTEGER NOT NULL,
				event_id TEXT,
				supersedes TEXT,
				vector_blob BLOB,
				vector_dim INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_doc_path ON chunks(doc_path);
			CREATE INDEX IF NOT EXISTS idx_chunks_source_type ON chunks(source_type);
		`);
	}

	/** Close both SQLite connections cleanly (important on Windows before removing files). */
	close(): void {
		this.ftsDb?.close();
		this.vectorsDb?.close();
		this.ftsDb = undefined;
		this.vectorsDb = undefined;
	}

	/** Delete index SQLite files and manifest.json so a clean full rebuild can run. */
	resetIndexFiles(): void {
		this.close();
		for (const file of [
			this.ftsDbPath,
			`${this.ftsDbPath}-wal`,
			`${this.ftsDbPath}-shm`,
			this.vectorsDbPath,
			`${this.vectorsDbPath}-wal`,
			`${this.vectorsDbPath}-shm`,
			this.manifestPath,
		]) {
			if (existsSync(file)) {
				rmSync(file, { force: true });
			}
		}
	}

	/** Read index/manifest.json (returns empty manifest when missing). */
	readManifest(): IndexManifest {
		if (!existsSync(this.manifestPath)) {
			return { version: 1, updatedAt: new Date(0).toISOString(), files: {} };
		}
		try {
			const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Partial<IndexManifest>;
			if (parsed && parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
				return {
					version: 1,
					updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
					files: parsed.files,
				};
			}
		} catch {
			// Rebuild manifest cleanly if corrupted.
		}
		return { version: 1, updatedAt: new Date(0).toISOString(), files: {} };
	}

	/** Persist index/manifest.json to disk. */
	writeManifest(manifest: IndexManifest): void {
		mkdirSync(this.indexDir, { recursive: true });
		writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
	}

	/** Replace all indexed chunks for a single document path atomically across both FTS5 and vectors DBs. */
	upsertDocumentChunks(docPath: string, chunks: readonly DocumentChunk[], embeddings?: readonly Float32Array[]): void {
		this.open();
		const normalizedPath = docPath.replace(/\\/g, "/");
		this.deleteDocumentChunks(normalizedPath);

		const insertFts = this.ftsDb!.prepare("INSERT INTO chunks_fts (chunk_id, doc_path, tokens) VALUES (?, ?, ?)");
		const insertVec = this.vectorsDb!.prepare(`
			INSERT INTO chunks (
				chunk_id, doc_path, source_type, title, section, page_start, page_end,
				tags_json, entities_json, updated_at, context_prefix, content, chunk_index,
				event_id, supersedes, vector_blob, vector_dim
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const tokenString = tokenizeForFts(chunk.indexedText).join(" ");
			insertFts.run(chunk.chunkId, normalizedPath, tokenString);

			const vec = embeddings?.[i];
			const blob = vec ? encodeFloat32(vec) : null;
			const dim = vec ? vec.length : 0;

			insertVec.run(
				chunk.chunkId,
				normalizedPath,
				chunk.sourceType,
				chunk.title,
				chunk.section,
				chunk.pageStart,
				chunk.pageEnd,
				JSON.stringify(chunk.tags),
				JSON.stringify(chunk.entities),
				chunk.updatedAt,
				chunk.contextPrefix,
				chunk.content,
				chunk.chunkIndex,
				chunk.eventId,
				chunk.supersedes,
				blob,
				dim,
			);
		}
	}

	/** Delete all chunks associated with a document path from both SQLite stores. */
	deleteDocumentChunks(docPath: string): void {
		this.open();
		const normalizedPath = docPath.replace(/\\/g, "/");
		this.ftsDb!.prepare("DELETE FROM chunks_fts WHERE doc_path = ?").run(normalizedPath);
		this.vectorsDb!.prepare("DELETE FROM chunks WHERE doc_path = ?").run(normalizedPath);
	}

	/** Sparse BM25 recall from SQLite FTS5 with optional metadata pre-filtering. */
	searchBm25(query: string, topK = 30, filter?: MetadataFilter): ScoredChunkHit[] {
		this.open();
		const matchExpr = buildFtsMatchQuery(query);
		if (!matchExpr) return [];

		// Over-fetch from FTS5 before applying metadata filters so filtered queries keep enough hits.
		const fetchLimit = Math.max(topK * 4, 120);
		const rows = this.ftsDb!.prepare(
			"SELECT chunk_id, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank ASC LIMIT ?",
		).all(matchExpr, fetchLimit) as Array<{ chunk_id: string; rank: number }>;

		if (rows.length === 0) return [];

		const byId = this.getChunksByIds(rows.map((r) => r.chunk_id));
		const hits: ScoredChunkHit[] = [];

		for (const row of rows) {
			const chunk = byId.get(row.chunk_id);
			if (!chunk) continue;
			if (!matchesMetadataFilter(chunk, filter)) continue;
			// SQLite FTS5 bm25() is lower (more negative) for better matches; negate for positive score.
			hits.push({ chunk, score: -row.rank });
			if (hits.length >= topK) break;
		}
		return hits;
	}

	/** Dense vector cosine recall from vectors.db with optional metadata pre-filtering. */
	searchVector(queryEmbedding: Float32Array, topK = 30, filter?: MetadataFilter): ScoredChunkHit[] {
		this.open();
		if (queryEmbedding.length === 0) return [];

		const rows = this.vectorsDb!.prepare(
			`SELECT chunk_id, doc_path, source_type, title, section, page_start, page_end,
				        tags_json, entities_json, updated_at, context_prefix, content, chunk_index,
				        event_id, supersedes, vector_blob, vector_dim
				 FROM chunks WHERE vector_dim = ?`,
		).all(queryEmbedding.length) as unknown as RawChunkRow[];

		const scored: ScoredChunkHit[] = [];
		for (const row of rows) {
			const chunk = rowToChunkRecord(row);
			if (!matchesMetadataFilter(chunk, filter)) continue;
			if (!row.vector_blob) continue;
			const vec = decodeFloat32(row.vector_blob);
			const sim = cosineSimilarity(queryEmbedding, vec);
			scored.push({ chunk, score: sim });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, topK);
	}

	/** Fetch total indexed chunk count for diagnostics and /doctor. */
	countChunks(): number {
		this.open();
		const row = this.vectorsDb!.prepare("SELECT COUNT(*) AS cnt FROM chunks").get() as { cnt: number };
		return row?.cnt ?? 0;
	}

	/**
	 * Synchronize the local hybrid index incrementally against Layer 1 (raw_pdfs) and Layer 2 (notes + events)
	 * using SHA-256 comparison in index/manifest.json. Pass fullRebuild=true to wipe and rebuild from scratch.
	 */
	async syncWorkspace(
		workspace: WorkspacePaths,
		modelClient: RagModelClient | undefined,
		options: SyncIndexOptions = {},
	): Promise<SyncIndexResult> {
		if (options.fullRebuild) {
			this.resetIndexFiles();
		}
		this.open();

		const manifest = this.readManifest();
		const nextFiles: Record<string, ManifestFileEntry> = {};
		const scannedPdfNotices: Array<{ relPath: string; pages: number[] }> = [];
		const warnings: string[] = [];

		let indexedFiles = 0;
		let skippedFiles = 0;
		const seenPaths = new Set<string>();

		// 1. Collect Markdown notes, PDFs, and Layer 2 memory event JSONL files.
		const sources = collectWorkspaceSourceFiles(workspace);

		for (const source of sources) {
			seenPaths.add(source.relPath);
			const rawBytes = readFileSync(source.absPath);
			const sha256 = createHash("sha256").update(rawBytes).digest("hex");
			const mtimeMs = statSync(source.absPath).mtimeMs;
			const prev = manifest.files[source.relPath];

			if (!options.fullRebuild && prev && prev.sha256 === sha256) {
				nextFiles[source.relPath] = prev;
				if (prev.scannedPages && prev.scannedPages.length > 0) {
					scannedPdfNotices.push({ relPath: source.relPath, pages: prev.scannedPages });
				}
				skippedFiles += 1;
				continue;
			}

			let chunks: DocumentChunk[] = [];
			let scannedPages: number[] = [];

			try {
				if (source.sourceType === "markdown") {
					const text = rawBytes.toString("utf8");
					const parsed = parseMarkdownDocument(text, source.relPath, new Date(mtimeMs).toISOString());
					chunks = chunkDocument(parsed);
				} else if (source.sourceType === "pdf") {
					const parsed = parsePdfDocument(
						source.absPath,
						source.relPath,
						new Date(mtimeMs).toISOString(),
						options.pdfOptions,
					);
					scannedPages = parsed.scannedPages;
					if (scannedPages.length > 0) {
						scannedPdfNotices.push({ relPath: source.relPath, pages: scannedPages });
					}
					chunks = chunkDocument(parsed);
				} else {
					// Layer 2 memory events JSONL
					const lines = rawBytes.toString("utf8").split(/\r?\n/);
					let idx = 0;
					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;
						const parsedEvt = validateMemoryEvent(JSON.parse(trimmed), `${source.relPath}#L${idx + 1}`);
						chunks.push(chunkMemoryEvent(parsedEvt, source.relPath, idx));
						idx += 1;
					}
				}
			} catch (error) {
				warnings.push(
					`Failed to parse ${source.relPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}

			let embeddings: Float32Array[] | undefined;
			if (modelClient && chunks.length > 0) {
				try {
					embeddings = await embedInBatches(
						modelClient,
						chunks.map((c) => c.indexedText),
						options.embedBatchSize ?? 32,
					);
				} catch (error) {
					warnings.push(
						`Embedding failed for ${source.relPath} (indexed BM25-only): ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			this.upsertDocumentChunks(source.relPath, chunks, embeddings);
			nextFiles[source.relPath] = {
				sha256,
				mtimeMs,
				chunkCount: chunks.length,
				sourceType: source.sourceType,
				scannedPages: scannedPages.length > 0 ? scannedPages : undefined,
			};
			indexedFiles += 1;
		}

		// 2. Remove stale documents no longer present on disk.
		let removedFiles = 0;
		for (const oldPath of Object.keys(manifest.files)) {
			if (!seenPaths.has(oldPath)) {
				this.deleteDocumentChunks(oldPath);
				removedFiles += 1;
			}
		}

		this.writeManifest({
			version: 1,
			updatedAt: new Date().toISOString(),
			files: nextFiles,
		});

		return {
			indexedFiles,
			skippedFiles,
			removedFiles,
			totalChunks: this.countChunks(),
			scannedPdfNotices,
			warnings,
		};
	}

	private getChunksByIds(ids: readonly string[]): Map<string, IndexedChunkRecord> {
		const map = new Map<string, IndexedChunkRecord>();
		if (ids.length === 0) return map;
		const placeholders = ids.map(() => "?").join(", ");
		const rows = this.vectorsDb!.prepare(
			`SELECT chunk_id, doc_path, source_type, title, section, page_start, page_end,
				        tags_json, entities_json, updated_at, context_prefix, content, chunk_index,
				        event_id, supersedes
				 FROM chunks WHERE chunk_id IN (${placeholders})`,
		).all(...ids) as unknown as RawChunkRow[];
		for (const row of rows) {
			map.set(row.chunk_id, rowToChunkRecord(row));
		}
		return map;
	}
}

interface RawChunkRow {
	chunk_id: string;
	doc_path: string;
	source_type: ChunkSourceType;
	title: string;
	section: string;
	page_start: number | null;
	page_end: number | null;
	tags_json: string;
	entities_json: string;
	updated_at: string;
	context_prefix: string;
	content: string;
	chunk_index: number;
	event_id: string | null;
	supersedes: string | null;
	vector_blob?: Uint8Array | null;
	vector_dim?: number;
}

interface DiscoveredSourceFile {
	absPath: string;
	relPath: string;
	sourceType: ChunkSourceType;
}

function collectWorkspaceSourceFiles(workspace: WorkspacePaths): DiscoveredSourceFile[] {
	const files: DiscoveredSourceFile[] = [];

	walkFiles(workspace.notesDir, (absPath) => {
		const ext = extname(absPath).toLowerCase();
		if (ext !== ".md" && ext !== ".markdown") return;
		const rel = toRelPath(workspace.root, workspace.notesDir, "knowledge/notes", absPath);
		files.push({ absPath, relPath: rel, sourceType: "markdown" });
	});

	walkFiles(workspace.rawPdfsDir, (absPath) => {
		if (extname(absPath).toLowerCase() !== ".pdf") return;
		const rel = toRelPath(workspace.root, workspace.rawPdfsDir, "evidence/raw_pdfs", absPath);
		files.push({ absPath, relPath: rel, sourceType: "pdf" });
	});

	walkFiles(workspace.eventsDir, (absPath) => {
		if (extname(absPath).toLowerCase() !== ".jsonl") return;
		const rel = toRelPath(workspace.root, workspace.eventsDir, "knowledge/memory/events", absPath);
		files.push({ absPath, relPath: rel, sourceType: "memory_event" });
	});

	files.sort((a, b) => a.relPath.localeCompare(b.relPath));
	return files;
}

function walkFiles(dir: string, onFile: (absPath: string) => void): void {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(full, onFile);
		} else if (entry.isFile()) {
			onFile(full);
		}
	}
}

function toRelPath(workspaceRoot: string, baseDir: string, externalPrefix: string, absPath: string): string {
	const relToRoot = relative(workspaceRoot, absPath).replace(/\\/g, "/");
	if (!relToRoot.startsWith("..") && !relToRoot.includes(":")) {
		return relToRoot;
	}
	const relToBase = relative(baseDir, absPath).replace(/\\/g, "/");
	return `${externalPrefix}/${relToBase}`;
}

function rowToChunkRecord(row: RawChunkRow): IndexedChunkRecord {
	return {
		chunkId: row.chunk_id,
		docPath: row.doc_path,
		sourceType: row.source_type,
		title: row.title,
		section: row.section,
		pageStart: row.page_start,
		pageEnd: row.page_end,
		tags: safeParseStringArray(row.tags_json),
		entities: safeParseStringArray(row.entities_json),
		updatedAt: row.updated_at,
		contextPrefix: row.context_prefix,
		content: row.content,
		chunkIndex: row.chunk_index,
		eventId: row.event_id,
		supersedes: row.supersedes,
	};
}

function matchesMetadataFilter(chunk: IndexedChunkRecord, filter: MetadataFilter | undefined): boolean {
	if (!filter) return true;
	if (filter.sourceTypes && filter.sourceTypes.length > 0 && !filter.sourceTypes.includes(chunk.sourceType)) {
		return false;
	}
	if (filter.dir) {
		const normDir = filter.dir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (normDir.length > 0 && !chunk.docPath.includes(normDir)) {
			return false;
		}
	}
	if (filter.tags && filter.tags.length > 0) {
		const chunkTags = new Set(chunk.tags.map((t) => t.toLowerCase()));
		if (!filter.tags.some((t) => chunkTags.has(t.toLowerCase()))) {
			return false;
		}
	}
	if (filter.entities && filter.entities.length > 0) {
		const haystack = [...chunk.entities, chunk.title, chunk.content].join(" ").toLowerCase();
		if (!filter.entities.some((e) => haystack.includes(e.toLowerCase()))) {
			return false;
		}
	}
	if (filter.timeFrom && chunk.updatedAt.slice(0, 10) < filter.timeFrom.slice(0, 10)) {
		return false;
	}
	if (filter.timeTo && chunk.updatedAt.slice(0, 10) > filter.timeTo.slice(0, 10)) {
		return false;
	}
	return true;
}

async function embedInBatches(
	client: RagModelClient,
	texts: readonly string[],
	batchSize: number,
): Promise<Float32Array[]> {
	const results: Float32Array[] = [];
	for (let i = 0; i < texts.length; i += batchSize) {
		const batch = texts.slice(i, i + batchSize);
		const vecs = await client.embed(batch);
		results.push(...vecs);
	}
	return results;
}

function encodeFloat32(vec: Float32Array): Uint8Array {
	return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

function decodeFloat32(blob: Uint8Array): Float32Array {
	if (blob.byteOffset % 4 === 0) {
		return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
	}
	const copy = Uint8Array.from(blob);
	return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function safeParseStringArray(json: string): string[] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}
