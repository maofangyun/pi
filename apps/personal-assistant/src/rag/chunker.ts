// Structure-aware recursive chunker with atomic block protection (code/tables/math),
// intra-section 15% overlap, short-fragment merging, and L1/L2 contextual retrieval prefixes.

import { createHash } from "node:crypto";
import { estimateTextTokens } from "../context/token-estimator.ts";
import type { MemoryEvent } from "../memory/event-store.ts";
import type { ParsedDocument, ParsedSection } from "./parser.ts";

export type ChunkSourceType = "markdown" | "pdf" | "memory_event";

export interface DocumentChunk {
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
	indexedText: string;
	chunkIndex: number;
	eventId: string | null;
	supersedes: string | null;
}

export interface ChunkingOptions {
	targetTokens?: number;
	maxTokens?: number;
	atomicMaxTokens?: number;
	overlapRatio?: number;
	minFragmentChars?: number;
}

interface ContentBlock {
	kind: "atomic" | "prose";
	text: string;
}

export const DEFAULT_TARGET_TOKENS = 500;
export const DEFAULT_MAX_TOKENS = 800;
export const DEFAULT_ATOMIC_MAX_TOKENS = 1200;
export const DEFAULT_OVERLAP_RATIO = 0.15;
export const DEFAULT_MIN_FRAGMENT_CHARS = 80;

/**
 * Chunk a parsed Markdown or PDF document using structure-aware recursive splitting:
 * - Never splits fenced code blocks, Markdown tables, or display math blocks mid-block (up to 1200 tokens);
 * - Targets 350-600 tokens (regular cap 800), keeps 15% overlap within same section (zero cross-section overlap);
 * - Merges <80-char short fragments into adjacent sibling chunks;
 * - Prepends mandatory zero-cost L1 deterministic structural prefix to every chunk.
 */
export function chunkDocument(doc: ParsedDocument, options: ChunkingOptions = {}): DocumentChunk[] {
	const targetTokens = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const atomicMaxTokens = options.atomicMaxTokens ?? DEFAULT_ATOMIC_MAX_TOKENS;
	const overlapRatio = options.overlapRatio ?? DEFAULT_OVERLAP_RATIO;
	const minFragmentChars = options.minFragmentChars ?? DEFAULT_MIN_FRAGMENT_CHARS;

	const chunks: DocumentChunk[] = [];
	let chunkIndex = 0;

	for (const section of doc.sections) {
		const rawSectionChunks = splitSectionWithProtection(section, {
			targetTokens,
			maxTokens,
			atomicMaxTokens,
			overlapRatio,
			minFragmentChars,
		});

		const sectionLabel = section.headings.length > 0 ? section.headings.join(" > ") : doc.title;
		const pageStart = section.pageRange ? section.pageRange[0] : null;
		const pageEnd = section.pageRange ? section.pageRange[1] : null;
		const contextPrefix = buildL1ContextPrefix({
			title: doc.title,
			relPath: doc.relPath,
			section: sectionLabel,
			pageRange: section.pageRange,
			tags: doc.tags,
			updatedAt: doc.updatedAt,
		});

		for (const bodyText of rawSectionChunks) {
			const trimmed = bodyText.trim();
			if (trimmed.length === 0) continue;
			const indexedText = `${contextPrefix}\n${trimmed}`;
			chunks.push({
				chunkId: makeChunkId(doc.relPath, chunkIndex, trimmed),
				docPath: doc.relPath,
				sourceType: doc.sourceType,
				title: doc.title,
				section: sectionLabel,
				pageStart,
				pageEnd,
				tags: [...doc.tags],
				entities: [...doc.wikilinks],
				updatedAt: doc.updatedAt,
				contextPrefix,
				content: trimmed,
				indexedText,
				chunkIndex,
				eventId: null,
				supersedes: null,
			});
			chunkIndex += 1;
		}
	}

	return chunks;
}

/** Convert a Layer 2 episodic MemoryEvent into a retrievable DocumentChunk. */
export function chunkMemoryEvent(event: MemoryEvent, relPath: string, chunkIndex = 0): DocumentChunk {
	const normalizedPath = relPath.replace(/\\/g, "/");
	const lines = [
		event.summary,
		event.decisions.length > 0 ? `决定: ${event.decisions.join("；")}` : "",
		event.open_items.length > 0 ? `待办: ${event.open_items.join("；")}` : "",
		event.artifacts.length > 0 ? `产物: ${event.artifacts.join(", ")}` : "",
		`证据出处: ${event.evidence_ref}`,
	].filter((line) => line.length > 0);

	const content = lines.join("\n");
	const contextPrefix = event.context_prefix;
	const indexedText = `${contextPrefix}\n${content}`;

	return {
		chunkId: `evt:${event.id}`,
		docPath: normalizedPath,
		sourceType: "memory_event",
		title: event.topic,
		section: event.session_id,
		pageStart: null,
		pageEnd: null,
		tags: ["memory", "event"],
		entities: [...event.entities],
		updatedAt: event.timestamp,
		contextPrefix,
		content,
		indexedText,
		chunkIndex,
		eventId: event.id,
		supersedes: event.supersedes,
	};
}

/** Build the mandatory zero-LLM L1 deterministic structural prefix. */
export function buildL1ContextPrefix(params: {
	title: string;
	relPath: string;
	section: string;
	pageRange?: [number, number];
	tags: readonly string[];
	updatedAt: string;
}): string {
	const pageText = params.pageRange
		? params.pageRange[0] === params.pageRange[1]
			? `p${params.pageRange[0]}`
			: `p${params.pageRange[0]}-p${params.pageRange[1]}`
		: "N/A";
	const tagsText = params.tags.length > 0 ? params.tags.join(",") : "无";
	return `[文档: ${params.title} | 路径: ${params.relPath} | 章节: ${params.section} | 页码: ${pageText} | 标签: ${tagsText} | 更新: ${params.updatedAt}]`;
}

/** Optional L2 semantic context enrichment via local Ollama for untitled or unstructured long excerpts. */
export async function enrichChunksWithL2Prefix(
	chunks: readonly DocumentChunk[],
	generateContext: (chunk: DocumentChunk) => Promise<string | undefined>,
): Promise<DocumentChunk[]> {
	const enriched: DocumentChunk[] = [];
	for (const chunk of chunks) {
		const semantic = (await generateContext(chunk))?.trim();
		if (semantic && semantic.length > 0) {
			const combinedPrefix = `${chunk.contextPrefix}\n[背景: ${semantic}]`;
			enriched.push({
				...chunk,
				contextPrefix: combinedPrefix,
				indexedText: `${combinedPrefix}\n${chunk.content}`,
			});
		} else {
			enriched.push(chunk);
		}
	}
	return enriched;
}

function splitSectionWithProtection(section: ParsedSection, opts: Required<ChunkingOptions>): string[] {
	const blocks = segmentIntoBlocks(section.text);
	const rawPieces: Array<{ kind: "atomic" | "prose"; text: string }> = [];

	for (const block of blocks) {
		if (block.kind === "atomic") {
			// Preserve atomic block intact up to atomicMaxTokens (1200 tokens).
			if (estimateTextTokens(block.text) <= opts.atomicMaxTokens) {
				rawPieces.push(block);
			} else {
				// Only if an extraordinary block exceeds 1200 tokens, split cleanly on line boundaries.
				for (const sub of splitByLines(block.text, opts.atomicMaxTokens)) {
					rawPieces.push({ kind: "atomic", text: sub });
				}
			}
			continue;
		}

		// Prose block: split by paragraphs -> sentences.
		const paragraphs = block.text
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter((p) => p.length > 0);
		for (const para of paragraphs) {
			if (estimateTextTokens(para) <= opts.maxTokens) {
				rawPieces.push({ kind: "prose", text: para });
			} else {
				for (const sentChunk of splitParagraphBySentences(para, opts.targetTokens, opts.maxTokens)) {
					rawPieces.push({ kind: "prose", text: sentChunk });
				}
			}
		}
	}

	// Pack pieces into target-sized chunks without breaking atomic blocks.
	const packed: Array<{ text: string; hasAtomic: boolean }> = [];
	let currentParts: string[] = [];
	let currentTokens = 0;
	let currentHasAtomic = false;

	const flushPacked = () => {
		if (currentParts.length === 0) return;
		packed.push({ text: currentParts.join("\n\n"), hasAtomic: currentHasAtomic });
		currentParts = [];
		currentTokens = 0;
		currentHasAtomic = false;
	};

	for (const piece of rawPieces) {
		const pieceTokens = estimateTextTokens(piece.text);
		if (piece.kind === "atomic" && pieceTokens > opts.maxTokens) {
			flushPacked();
			packed.push({ text: piece.text, hasAtomic: true });
			continue;
		}

		const budget = currentHasAtomic || piece.kind === "atomic" ? opts.atomicMaxTokens : opts.targetTokens;
		if (
			currentParts.length > 0 &&
			currentTokens + pieceTokens > budget &&
			currentTokens + pieceTokens > opts.maxTokens
		) {
			flushPacked();
		} else if (currentParts.length > 0 && currentTokens >= opts.targetTokens) {
			flushPacked();
		}

		currentParts.push(piece.text);
		currentTokens += pieceTokens;
		if (piece.kind === "atomic") currentHasAtomic = true;
	}
	flushPacked();

	// Merge short sibling fragments (<80 chars) into adjacent chunks within the same section.
	const merged: string[] = [];
	for (const item of packed) {
		const trimmed = item.text.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.length < opts.minFragmentChars && merged.length > 0) {
			const candidate = `${merged[merged.length - 1]}\n\n${trimmed}`;
			if (estimateTextTokens(candidate) <= opts.atomicMaxTokens) {
				merged[merged.length - 1] = candidate;
				continue;
			}
		}
		merged.push(trimmed);
	}
	if (merged.length > 1 && merged[0].length < opts.minFragmentChars) {
		const combined = `${merged[0]}\n\n${merged[1]}`;
		if (estimateTextTokens(combined) <= opts.atomicMaxTokens) {
			merged[1] = combined;
			merged.shift();
		}
	}

	// Apply 15% overlap between consecutive chunks ONLY within the same section.
	if (merged.length <= 1 || opts.overlapRatio <= 0) {
		return merged;
	}

	const withOverlap: string[] = [merged[0]];
	for (let i = 1; i < merged.length; i++) {
		const prev = merged[i - 1];
		const curr = merged[i];
		const overlapText = extractTailOverlap(prev, opts.overlapRatio);
		if (overlapText.length > 0 && !curr.startsWith(overlapText)) {
			withOverlap.push(`${overlapText}\n${curr}`);
		} else {
			withOverlap.push(curr);
		}
	}
	return withOverlap;
}

/** Segment section markdown into prose blocks vs atomic blocks (fenced code, tables, $$ math). */
function segmentIntoBlocks(text: string): ContentBlock[] {
	const lines = text.split(/\r?\n/);
	const blocks: ContentBlock[] = [];
	let proseLines: string[] = [];
	let i = 0;

	const flushProse = () => {
		const joined = proseLines.join("\n").trim();
		if (joined.length > 0) {
			blocks.push({ kind: "prose", text: joined });
		}
		proseLines = [];
	};

	while (i < lines.length) {
		const line = lines[i];

		// 1. Fenced code block (``` or ~~~)
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			flushProse();
			const fenceChar = fenceMatch[1][0];
			const fenceLen = fenceMatch[1].length;
			const codeLines = [line];
			i += 1;
			while (i < lines.length) {
				codeLines.push(lines[i]);
				const closeRegex = new RegExp(`^\\s*${fenceChar}{${fenceLen},}\\s*$`);
				if (closeRegex.test(lines[i])) {
					i += 1;
					break;
				}
				i += 1;
			}
			blocks.push({ kind: "atomic", text: codeLines.join("\n").trim() });
			continue;
		}

		// 2. Display math block ($$ ... $$)
		if (/^\s*\$\$/.test(line)) {
			flushProse();
			const mathLines = [line];
			const singleLineClosed = /^\s*\$\$.+\$\$\s*$/.test(line);
			i += 1;
			if (!singleLineClosed) {
				while (i < lines.length) {
					mathLines.push(lines[i]);
					if (/\$\$\s*$/.test(lines[i])) {
						i += 1;
						break;
					}
					i += 1;
				}
			}
			blocks.push({ kind: "atomic", text: mathLines.join("\n").trim() });
			continue;
		}

		// 3. Markdown table (header row + separator row with --- and |)
		if (i + 1 < lines.length && isTableRow(line) && isTableSeparator(lines[i + 1])) {
			flushProse();
			const tableLines = [line, lines[i + 1]];
			i += 2;
			while (i < lines.length && isTableRow(lines[i])) {
				tableLines.push(lines[i]);
				i += 1;
			}
			blocks.push({ kind: "atomic", text: tableLines.join("\n").trim() });
			continue;
		}

		proseLines.push(line);
		i += 1;
	}

	flushProse();
	return blocks;
}

function splitParagraphBySentences(paragraph: string, targetTokens: number, maxTokens: number): string[] {
	const sentences = paragraph
		.split(/(?<=[。！？.!?\n])/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	if (sentences.length <= 1) {
		return splitByCharBudget(paragraph, maxTokens);
	}

	const chunks: string[] = [];
	let current = "";
	for (const sent of sentences) {
		if (estimateTextTokens(sent) > maxTokens) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			chunks.push(...splitByCharBudget(sent, maxTokens));
			continue;
		}

		const candidate = current ? `${current} ${sent}` : sent;
		if (current && estimateTextTokens(candidate) > targetTokens) {
			chunks.push(current);
			current = sent;
		} else {
			current = candidate;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitByLines(text: string, maxTokens: number): string[] {
	const lines = text.split(/\r?\n/);
	const out: string[] = [];
	let current: string[] = [];
	let tokens = 0;
	for (const line of lines) {
		const t = estimateTextTokens(line);
		if (current.length > 0 && tokens + t > maxTokens) {
			out.push(current.join("\n"));
			current = [];
			tokens = 0;
		}
		current.push(line);
		tokens += t;
	}
	if (current.length > 0) out.push(current.join("\n"));
	return out;
}

function splitByCharBudget(text: string, maxTokens: number): string[] {
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(text.length, start + Math.max(100, Math.floor(maxTokens * 0.8)));
		while (end < text.length && estimateTextTokens(text.slice(start, end + 40)) <= maxTokens) {
			end = Math.min(text.length, end + 40);
		}
		while (end > start + 20 && estimateTextTokens(text.slice(start, end)) > maxTokens) {
			end -= 20;
		}
		chunks.push(text.slice(start, end).trim());
		start = end;
	}
	return chunks.filter((c) => c.length > 0);
}

function extractTailOverlap(text: string, ratio: number): string {
	// Skip taking raw half-broken code/table lines as overlap; prefer prose tail lines.
	if (text.trimEnd().endsWith("```") || text.trimEnd().endsWith("|")) {
		return "";
	}
	const targetChars = Math.min(140, Math.max(40, Math.round(text.length * ratio)));
	if (text.length <= targetChars) return "";
	const tail = text.slice(-targetChars);
	const boundary = tail.search(/[。！？.!?\n]/);
	if (boundary > 0 && boundary < tail.length - 15) {
		return tail.slice(boundary + 1).trim();
	}
	return tail.trim();
}

function isTableRow(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.includes("|") && trimmed.replace(/\|/g, "").trim().length > 0;
}

function isTableSeparator(line: string): boolean {
	const trimmed = line.trim();
	return /^\|?[\s:]*-{3,}[\s:]*(?:\|[\s:]*-{3,}[\s:]*)+\|?$/.test(trimmed);
}

function makeChunkId(relPath: string, chunkIndex: number, content: string): string {
	const hash = createHash("sha256").update(relPath).update(`#${chunkIndex}:`).update(content).digest("hex");
	return `chk-${hash.slice(0, 16)}`;
}
