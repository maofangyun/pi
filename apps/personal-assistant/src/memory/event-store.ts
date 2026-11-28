// Layer 2 memory store: ADD-only monthly episodic event log (knowledge/memory/events/YYYY-MM.jsonl)
// with supersedes chain resolution and normal-shutdown automatic extraction.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractSourceIndex } from "../context/compaction.ts";
import type { TodoItem } from "../context/todo.ts";
import type { AssistantRuntime } from "../extension.ts";

export interface MemoryEvent {
	id: string;
	session_id: string;
	timestamp: string;
	topic: string;
	entities: string[];
	context_prefix: string;
	summary: string;
	decisions: string[];
	open_items: string[];
	artifacts: string[];
	supersedes: string | null;
	evidence_ref: string;
}

export interface SupersedingInfo {
	supersededById: string;
	supersededAt: string;
	annotation: string;
}

export interface AnnotatedMemoryEvent {
	event: MemoryEvent;
	supersededBy?: SupersedingInfo;
}

export interface AttachMemoryEventOptions {
	/** Guard callback (wired by M5 resilience) that returns true on abnormal/error shutdowns. */
	isAbnormalShutdown?: () => boolean;
	/** Optional callback to obtain current session TODOs for open_items extraction. */
	getTodos?: () => TodoItem[];
	/** Optional callback invoked after an event is appended (e.g. incremental index update). */
	onEventAppended?: (event: MemoryEvent, filePath: string) => void | Promise<void>;
}

export class EventValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EventValidationError";
	}
}

/** Validate an untrusted JSON object against the Layer 2 MemoryEvent schema. */
export function validateMemoryEvent(raw: unknown, sourceLabel = "memory event"): MemoryEvent {
	if (!isPlainRecord(raw)) {
		throw new EventValidationError(`${sourceLabel} must be a JSON object.`);
	}

	const id = requireNonEmptyString(raw.id, `${sourceLabel}.id`);
	const session_id = requireNonEmptyString(raw.session_id, `${sourceLabel}.session_id`);
	const timestamp = requireNonEmptyString(raw.timestamp, `${sourceLabel}.timestamp`);
	const topic = requireNonEmptyString(raw.topic, `${sourceLabel}.topic`);
	const summary = requireNonEmptyString(raw.summary, `${sourceLabel}.summary`);
	const evidence_ref = requireNonEmptyString(raw.evidence_ref, `${sourceLabel}.evidence_ref`);
	const entities = requireStringArray(raw.entities, `${sourceLabel}.entities`);
	const decisions = requireStringArray(raw.decisions, `${sourceLabel}.decisions`);
	const open_items = requireStringArray(raw.open_items, `${sourceLabel}.open_items`);
	const artifacts = requireStringArray(raw.artifacts, `${sourceLabel}.artifacts`);

	let supersedes: string | null = null;
	if (raw.supersedes !== undefined && raw.supersedes !== null) {
		if (typeof raw.supersedes !== "string" || raw.supersedes.trim().length === 0) {
			throw new EventValidationError(`${sourceLabel}.supersedes must be a non-empty string or null.`);
		}
		supersedes = raw.supersedes.trim();
	}

	const datePart = formatDatePrefix(timestamp);
	const rawPrefix = typeof raw.context_prefix === "string" ? raw.context_prefix.trim() : "";
	const context_prefix = rawPrefix.length > 0 ? rawPrefix : buildEventContextPrefix(datePart, topic, entities);

	return {
		id,
		session_id,
		timestamp,
		topic,
		entities,
		context_prefix,
		summary,
		decisions,
		open_items,
		artifacts,
		supersedes,
		evidence_ref,
	};
}

/** Build the deterministic contextual retrieval prefix for a Layer 2 memory event. */
export function buildEventContextPrefix(dateYmd: string, topic: string, entities: readonly string[]): string {
	const entityPart = entities.length > 0 ? ` | 实体: ${entities.join(", ")}` : "";
	return `[${dateYmd} 会话: ${topic}${entityPart}]`;
}

/**
 * Resolve supersedes chains across episodic events without deleting historical records.
 * Returns a map from superseded event ID -> the newest event that directly or transitively replaces it.
 */
export function resolveSupersedesMap(events: readonly MemoryEvent[]): Map<string, SupersedingInfo> {
	const directReplacement = new Map<string, MemoryEvent>();
	for (const evt of events) {
		if (evt.supersedes) {
			const existing = directReplacement.get(evt.supersedes);
			if (!existing || evt.timestamp.localeCompare(existing.timestamp) >= 0) {
				directReplacement.set(evt.supersedes, evt);
			}
		}
	}

	const resolved = new Map<string, SupersedingInfo>();
	for (const evt of events) {
		let current = directReplacement.get(evt.id);
		if (!current) continue;
		const visited = new Set<string>([evt.id]);
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			const next = directReplacement.get(current.id);
			if (!next) break;
			current = next;
		}
		if (current) {
			const dateYmd = formatDatePrefix(current.timestamp);
			resolved.set(evt.id, {
				supersededById: current.id,
				supersededAt: current.timestamp,
				annotation: `[已于 ${dateYmd} 被 ${current.id} 更新]`,
			});
		}
	}
	return resolved;
}

/** ADD-only Layer 2 episodic memory store under knowledge/memory/events/YYYY-MM.jsonl. */
export class EventStore {
	private readonly eventsDir: string;

	constructor(eventsDir: string) {
		this.eventsDir = eventsDir;
	}

	/** Strictly append a validated MemoryEvent to its monthly YYYY-MM.jsonl file (never mutates prior lines). */
	append(event: Omit<MemoryEvent, "context_prefix"> & { context_prefix?: string }): {
		event: MemoryEvent;
		filePath: string;
	} {
		const validated = validateMemoryEvent(event);
		mkdirSync(this.eventsDir, { recursive: true });
		const monthKey = formatMonthKey(validated.timestamp);
		const filePath = join(this.eventsDir, `${monthKey}.jsonl`);
		appendFileSync(filePath, `${JSON.stringify(validated)}\n`, "utf8");
		return { event: validated, filePath };
	}

	/** Load all episodic events chronologically across all YYYY-MM.jsonl files. */
	loadAll(): MemoryEvent[] {
		if (!existsSync(this.eventsDir)) return [];

		const files = readdirSync(this.eventsDir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort((a, b) => a.localeCompare(b));

		const events: MemoryEvent[] = [];
		for (const file of files) {
			const fullPath = join(this.eventsDir, file);
			const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const trimmed = lines[i].trim();
				if (!trimmed) continue;
				const parsed: unknown = JSON.parse(trimmed);
				events.push(validateMemoryEvent(parsed, `${file}#L${i + 1}`));
			}
		}

		events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		return events;
	}

	/** Load all events annotated with supersedes status for retrieval rendering. */
	loadAnnotated(): AnnotatedMemoryEvent[] {
		const events = this.loadAll();
		const supersedesMap = resolveSupersedesMap(events);
		return events.map((event) => ({
			event,
			supersededBy: supersedesMap.get(event.id),
		}));
	}

	/** Generate the next deterministic event ID for a given date (evt-YYYYMMDD-NNN). */
	nextEventId(now = new Date()): string {
		const ymd = formatCompactYmd(now);
		const prefix = `evt-${ymd}-`;
		const existing = this.loadAll().filter((evt) => evt.id.startsWith(prefix));
		const nextNum = existing.length + 1;
		return `${prefix}${String(nextNum).padStart(3, "0")}`;
	}
}

/** Deterministically extract a structured Layer 2 MemoryEvent from a completed session branch. */
export function extractSessionEventDraft(params: {
	sessionId: string;
	sessionFile?: string;
	entries: readonly SessionEntry[];
	todos?: readonly TodoItem[];
	eventId: string;
	now?: Date;
}): MemoryEvent | undefined {
	const userTexts: string[] = [];
	const assistantTexts: string[] = [];

	for (const entry of params.entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			const text = extractMessageText(entry.message.content).trim();
			if (text.length > 0 && !text.startsWith("<agent_status>")) {
				userTexts.push(text);
			}
		} else if (entry.message.role === "assistant") {
			const text = extractMessageText(entry.message.content).trim();
			if (text.length > 0) {
				assistantTexts.push(text);
			}
		}
	}

	if (userTexts.length === 0) return undefined;

	const now = params.now ?? new Date();
	const timestamp = now.toISOString();
	const firstPrompt = userTexts[0].replace(/\s+/g, " ").trim();
	const topic = firstPrompt.length > 60 ? `${firstPrompt.slice(0, 57)}...` : firstPrompt;

	const sourceIndex = extractSourceIndex(params.entries, []);
	const artifacts = [...new Set([...sourceIndex.modifiedFiles, ...sourceIndex.artifacts])];

	const entitySet = new Set<string>();
	for (const p of [...sourceIndex.readFiles, ...sourceIndex.modifiedFiles]) {
		const name = basename(p);
		if (name) entitySet.add(name);
	}
	for (const pdf of sourceIndex.pdfPages) {
		entitySet.add(pdf);
	}
	const entities = [...entitySet].slice(0, 12);

	const todos = params.todos ?? [];
	const decisions = todos.filter((t) => t.status === "completed").map((t) => t.title);
	const open_items = todos.filter((t) => t.status === "pending" || t.status === "in_progress").map((t) => t.title);

	const lastAssistant = assistantTexts[assistantTexts.length - 1] ?? "";
	const conciseConclusion = lastAssistant.replace(/\s+/g, " ").trim().slice(0, 240);
	const summary =
		conciseConclusion.length > 0
			? `围绕“${topic}”完成交互（共 ${userTexts.length} 轮用户输入）：${conciseConclusion}`
			: `围绕“${topic}”完成交互（共 ${userTexts.length} 轮用户输入）。`;

	const sessionRef = params.sessionFile
		? `${params.sessionFile.replace(/\\/g, "/")}#L1-L${Math.max(1, params.entries.length)}`
		: `evidence/sessions/${params.sessionId}.jsonl#L1-L${Math.max(1, params.entries.length)}`;

	return validateMemoryEvent({
		id: params.eventId,
		session_id: params.sessionId,
		timestamp,
		topic,
		entities,
		context_prefix: buildEventContextPrefix(formatDatePrefix(timestamp), topic, entities),
		summary,
		decisions,
		open_items,
		artifacts,
		supersedes: null,
		evidence_ref: sessionRef,
	});
}

/** Attach Layer 2 ADD-only episodic event extraction on normal session_shutdown. */
export function attachMemoryEventModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options: AttachMemoryEventOptions = {},
): EventStore {
	const store = new EventStore(runtime.workspace.eventsDir);

	pi.on("session_shutdown", async (_event, ctx) => {
		if (options.isAbnormalShutdown?.()) {
			return;
		}
		const entries = ctx.sessionManager.getBranch();
		if (entries.length === 0) return;

		const draft = extractSessionEventDraft({
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			entries,
			todos: options.getTodos?.(),
			eventId: store.nextEventId(),
		});
		if (!draft) return;

		const { event, filePath } = store.append(draft);
		await options.onEventAppended?.(event, filePath);
	});

	return store;
}

function formatDatePrefix(timestamp: string): string {
	const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})/);
	if (match) return match[1];
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "1970-01-01";
	return date.toISOString().slice(0, 10);
}

function formatMonthKey(timestamp: string): string {
	return formatDatePrefix(timestamp).slice(0, 7);
}

function formatCompactYmd(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function extractMessageText(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new EventValidationError(`${field} must be a non-empty string.`);
	}
	return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value)) {
		throw new EventValidationError(`${field} must be an array of strings.`);
	}
	const out: string[] = [];
	for (let i = 0; i < value.length; i++) {
		if (typeof value[i] !== "string") {
			throw new EventValidationError(`${field}[${i}] must be a string.`);
		}
		const trimmed = value[i].trim();
		if (trimmed.length > 0) out.push(trimmed);
	}
	return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
