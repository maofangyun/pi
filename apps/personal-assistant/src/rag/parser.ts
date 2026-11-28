// Structure-aware Markdown and PDF document parsers with YAML frontmatter, wikilinks,
// repeated header/footer filtering, scanned-page detection, and cross-page sentence stitching.

import { execFileSync } from "node:child_process";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface MarkdownFrontmatter {
	title?: string;
	tags: string[];
	date?: string;
	aliases: string[];
	sources: string[];
}

export interface ParsedSection {
	headings: string[];
	text: string;
	pageRange?: [number, number];
}

export interface ParsedDocument {
	sourceType: "markdown" | "pdf";
	relPath: string;
	title: string;
	tags: string[];
	updatedAt: string;
	aliases: string[];
	wikilinks: string[];
	sections: ParsedSection[];
	scannedPages: number[];
}

export interface RawPdfPage {
	page: number;
	text: string;
	tables_markdown?: string[];
	effective_chars?: number;
	image_count?: number;
	needs_visual_ocr?: boolean;
}

export interface RawPdfPayload {
	title?: string;
	page_count?: number;
	pages: RawPdfPage[];
}

export interface PdfExtractOptions {
	pythonBin?: string;
	scriptPath?: string;
	timeoutMs?: number;
	/** Optional custom extractor for Docker sandbox or unit tests. */
	customExtractor?: (filePath: string) => RawPdfPayload;
}

const DEFAULT_PDF_SCRIPT = fileURLToPath(new URL("../../scripts/parse_pdf.py", import.meta.url));
const PAGE_NUMBER_LINE =
	/^(?:第\s*\d+\s*页(?:\s*[/／]\s*共?\s*\d+\s*页?)?|page\s+\d+(?:\s+of\s+\d+)?|[-—–]?\s*\d+\s*[-—–]?)$/i;

/** Parse a Markdown note preserving YAML frontmatter, H1-H3 heading hierarchy, and [[wikilinks]]. */
export function parseMarkdownDocument(content: string, relPath: string, fallbackDateIso: string): ParsedDocument {
	const normalizedPath = relPath.replace(/\\/g, "/");
	const { frontmatter, body } = extractFrontmatter(content);
	const wikilinks = extractWikilinks(body);

	const fallbackTitle = basename(normalizedPath, extname(normalizedPath));
	let firstH1: string | undefined;

	const lines = body.split(/\r?\n/);
	const sections: ParsedSection[] = [];
	const headingStack: Array<{ level: number; title: string }> = [];
	let currentLines: string[] = [];
	let inCodeFence = false;
	let fenceChar = "";

	const flushSection = () => {
		const text = currentLines.join("\n").trim();
		if (text.length === 0) return;
		sections.push({
			headings: headingStack.map((h) => h.title),
			text,
		});
		currentLines = [];
	};

	for (const line of lines) {
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1][0];
			if (!inCodeFence) {
				inCodeFence = true;
				fenceChar = marker;
			} else if (marker === fenceChar) {
				inCodeFence = false;
				fenceChar = "";
			}
			currentLines.push(line);
			continue;
		}

		if (!inCodeFence) {
			const headingMatch = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
			if (headingMatch) {
				flushSection();
				const level = headingMatch[1].length;
				const headingTitle = headingMatch[2].trim();
				if (level === 1 && !firstH1) {
					firstH1 = headingTitle;
				}
				while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
					headingStack.pop();
				}
				headingStack.push({ level, title: headingTitle });
				continue;
			}
		}

		currentLines.push(line);
	}

	flushSection();

	const title = frontmatter.title || firstH1 || fallbackTitle;
	const updatedAt = frontmatter.date || fallbackDateIso.slice(0, 10);

	return {
		sourceType: "markdown",
		relPath: normalizedPath,
		title,
		tags: frontmatter.tags,
		updatedAt,
		aliases: frontmatter.aliases,
		wikilinks,
		sections,
		scannedPages: [],
	};
}

/**
 * Remove repeated headers, footers, and standalone page-number noise across PDF pages.
 * Safe and deterministic even when called in TypeScript on raw page text.
 */
export function stripRepeatedPageHeadersFooters(pageTexts: readonly string[]): string[] {
	if (pageTexts.length === 0) return [];
	const splitPages = pageTexts.map((text) => text.split(/\r?\n/).map((line) => line.trim()));

	const repeatedTop = new Set<string>();
	const repeatedBottom = new Set<string>();

	if (pageTexts.length >= 3) {
		const topCounts = new Map<string, number>();
		const bottomCounts = new Map<string, number>();
		for (const lines of splitPages) {
			const nonEmpty = lines.filter((line) => line.length > 0);
			for (const candidate of nonEmpty.slice(0, 2)) {
				if (candidate.length <= 120) {
					topCounts.set(candidate, (topCounts.get(candidate) ?? 0) + 1);
				}
			}
			for (const candidate of nonEmpty.slice(-2)) {
				if (candidate.length <= 120) {
					bottomCounts.set(candidate, (bottomCounts.get(candidate) ?? 0) + 1);
				}
			}
		}
		const minFreq = Math.max(2, Math.ceil(pageTexts.length * 0.4));
		for (const [line, count] of topCounts) {
			if (count >= minFreq) repeatedTop.add(line);
		}
		for (const [line, count] of bottomCounts) {
			if (count >= minFreq) repeatedBottom.add(line);
		}
	}

	return splitPages.map((lines) => {
		const copy = [...lines];
		let removedTop = 0;
		while (copy.length > 0 && removedTop < 2) {
			if (copy[0].length === 0) {
				copy.shift();
				continue;
			}
			if (repeatedTop.has(copy[0]) || PAGE_NUMBER_LINE.test(copy[0])) {
				copy.shift();
				removedTop += 1;
			} else {
				break;
			}
		}

		let removedBottom = 0;
		while (copy.length > 0 && removedBottom < 2) {
			const last = copy[copy.length - 1];
			if (last.length === 0) {
				copy.pop();
				continue;
			}
			if (repeatedBottom.has(last) || PAGE_NUMBER_LINE.test(last)) {
				copy.pop();
				removedBottom += 1;
			} else {
				break;
			}
		}

		return copy.join("\n").trim();
	});
}

/**
 * Normalize raw per-page PDF output into structured sections with exact page_range [start, end],
 * cross-page broken sentence stitching, Markdown tables, and scanned-page detection.
 */
export function normalizeParsedPdf(raw: RawPdfPayload, relPath: string, fallbackDateIso: string): ParsedDocument {
	const normalizedPath = relPath.replace(/\\/g, "/");
	const title = raw.title?.trim() || basename(normalizedPath, extname(normalizedPath));
	const cleanedTexts = stripRepeatedPageHeadersFooters(raw.pages.map((p) => p.text ?? ""));

	const scannedPages: number[] = [];
	const usablePages: Array<{ page: number; text: string; heading?: string }> = [];

	for (let i = 0; i < raw.pages.length; i++) {
		const pageMeta = raw.pages[i];
		const baseText = cleanedTexts[i] ?? "";
		const effectiveChars = pageMeta.effective_chars ?? baseText.replace(/\s+/g, "").length;
		const imageCount = pageMeta.image_count ?? 0;
		const needsOcr = pageMeta.needs_visual_ocr ?? (effectiveChars < 50 && imageCount > 0);

		if (needsOcr) {
			scannedPages.push(pageMeta.page);
			continue;
		}

		const tables = (pageMeta.tables_markdown ?? []).filter((t) => t.trim().length > 0);
		const combined = [baseText, ...tables]
			.filter((part) => part.trim().length > 0)
			.join("\n\n")
			.trim();
		if (combined.length === 0) continue;

		usablePages.push({
			page: pageMeta.page,
			text: combined,
			heading: detectPdfSectionHeading(baseText),
		});
	}

	const sections: ParsedSection[] = [];
	let currentHeading = title;

	for (const item of usablePages) {
		if (item.heading) {
			currentHeading = item.heading;
		}

		const prev = sections[sections.length - 1];
		const isBrokenAcrossPage =
			prev !== undefined &&
			prev.pageRange !== undefined &&
			prev.pageRange[1] + 1 === item.page &&
			!item.heading &&
			endsWithIncompleteSentence(prev.text) &&
			startsWithContinuation(item.text);

		if (isBrokenAcrossPage && prev && prev.pageRange) {
			const joiner = needsSpaceBetween(prev.text, item.text) ? " " : "";
			prev.text = `${prev.text.trimEnd()}${joiner}${item.text.trimStart()}`;
			prev.pageRange = [prev.pageRange[0], item.page];
		} else {
			sections.push({
				headings: currentHeading === title ? [title] : [title, currentHeading],
				text: item.text,
				pageRange: [item.page, item.page],
			});
		}
	}

	return {
		sourceType: "pdf",
		relPath: normalizedPath,
		title,
		tags: ["pdf"],
		updatedAt: fallbackDateIso.slice(0, 10),
		aliases: [],
		wikilinks: [],
		sections,
		scannedPages,
	};
}

/** Parse a local PDF file using scripts/parse_pdf.py (or an injected extractor for Docker/tests). */
export function parsePdfDocument(
	filePath: string,
	relPath: string,
	fallbackDateIso: string,
	options: PdfExtractOptions = {},
): ParsedDocument {
	const raw = options.customExtractor ? options.customExtractor(filePath) : runPythonPdfExtractor(filePath, options);
	return normalizeParsedPdf(raw, relPath, fallbackDateIso);
}

function runPythonPdfExtractor(filePath: string, options: PdfExtractOptions): RawPdfPayload {
	const pythonBin = options.pythonBin ?? (process.platform === "win32" ? "python" : "python3");
	const scriptPath = options.scriptPath ?? DEFAULT_PDF_SCRIPT;
	const stdout = execFileSync(pythonBin, [scriptPath, filePath], {
		encoding: "utf8",
		timeout: options.timeoutMs ?? 60_000,
		maxBuffer: 20 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const parsed: unknown = JSON.parse(stdout);
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { pages?: unknown }).pages)) {
		throw new Error(`Invalid JSON returned by parse_pdf.py for ${filePath}`);
	}
	return parsed as RawPdfPayload;
}

function extractFrontmatter(content: string): { frontmatter: MarkdownFrontmatter; body: string } {
	const empty: MarkdownFrontmatter = { tags: [], aliases: [], sources: [] };
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		return { frontmatter: empty, body: content };
	}

	const body = content.slice(match[0].length);
	let parsed: unknown;
	try {
		parsed = parseYaml(match[1]);
	} catch {
		return { frontmatter: empty, body };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { frontmatter: empty, body };
	}

	const record = parsed as Record<string, unknown>;
	const rawDate = record.updated ?? record.date;
	const date =
		rawDate instanceof Date
			? rawDate.toISOString().slice(0, 10)
			: typeof rawDate === "string"
				? rawDate.trim()
				: undefined;

	return {
		frontmatter: {
			title: typeof record.title === "string" ? record.title.trim() : undefined,
			tags: normalizeStringList(record.tags),
			date: date && date.length > 0 ? date : undefined,
			aliases: normalizeStringList(record.aliases),
			sources: normalizeStringList(record.sources),
		},
		body,
	};
}

function extractWikilinks(markdownBody: string): string[] {
	const found = new Set<string>();
	const regex = /\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g;
	for (const match of markdownBody.matchAll(regex)) {
		const target = match[1]?.trim();
		if (target) found.add(target);
	}
	return [...found];
}

function detectPdfSectionHeading(text: string): string | undefined {
	const firstLine = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	if (!firstLine || firstLine.length > 80) return undefined;
	if (/[。！？.!?;；]$/.test(firstLine)) return undefined;
	if (/^(?:第[一二三四五六七八九十百\d]+[章节部分]|Chapter\s+\d+|\d+\.\d*(?:\.\d+)*\s+\S+)/i.test(firstLine)) {
		return firstLine;
	}
	return undefined;
}

function endsWithIncompleteSentence(text: string): boolean {
	const trimmed = text.trimEnd();
	if (trimmed.length === 0) return false;
	const lastChar = trimmed[trimmed.length - 1];
	return !/[。！？.!?:：；;)\]】」』|`]/.test(lastChar);
}

function startsWithContinuation(text: string): boolean {
	const trimmed = text.trimStart();
	if (trimmed.length === 0) return false;
	if (/^(?:#|\||```|- |\* |\d+\.\s)/.test(trimmed)) return false;
	return true;
}

function needsSpaceBetween(prev: string, next: string): boolean {
	const last = prev.trimEnd().slice(-1);
	const first = next.trimStart().slice(0, 1);
	return /[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first);
}

function normalizeStringList(value: unknown): string[] {
	if (typeof value === "string" && value.trim().length > 0) {
		return [value.trim()];
	}
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}
