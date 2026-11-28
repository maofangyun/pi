// /feedback command: capture failure trajectory slices, model/flag snapshot, and structured attribution drafts
// under evidence/feedback/ (physically isolated from evals/golden/) with one-step export to prefix boundary cases.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { FeatureFlags } from "../config.ts";
import type { AssistantRuntime } from "../extension.ts";

export type FeedbackErrorCategory =
	| "missed_constraint"
	| "wrong_action"
	| "right_action_wrong_report"
	| "retrieval_miss"
	| "security_violation"
	| "other";

export interface FeedbackTrajectoryItem {
	step: number;
	entryId: string;
	role: string;
	text: string;
}

export interface FeedbackRecord {
	id: string;
	timestamp: string;
	sessionId: string;
	description: string;
	model: {
		provider: string;
		model: string;
		thinking: string;
	};
	features: FeatureFlags;
	firstErrorStep: number | null;
	errorCategory: FeedbackErrorCategory;
	trajectorySlice: FeedbackTrajectoryItem[];
	processedByEvolve: boolean;
}

export interface ExportedPrefixBoundaryDraft {
	id: string;
	sourceFeedbackId: string;
	description: string;
	category: FeedbackErrorCategory;
	prefixMessages: Array<{ role: string; text: string }>;
	acceptableActions: string[];
	forbiddenActions: string[];
	redLinePass3: boolean;
}

/** Classify a short Chinese/English user feedback note into an initial error category. */
export function inferFeedbackCategory(description: string): FeedbackErrorCategory {
	const text = description.toLowerCase();
	if (/(?:越界|只读|raw_pdfs|安全|未确认|sidecar|泄露)/.test(text)) return "security_violation";
	if (/(?:做对了但说错|汇报错|总结错|幻觉|页码错|出处错)/.test(text)) return "right_action_wrong_report";
	if (/(?:没搜到|漏召回|召回|检索|找不到笔记|rag)/.test(text)) return "retrieval_miss";
	if (/(?:漏|忘|约束|编码|utf-8|小数|忽略|覆盖偏好)/.test(text)) return "missed_constraint";
	if (/(?:做错|跑错|改错|删错)/.test(text)) return "wrong_action";
	return "other";
}

/** Feedback persistence store under evidence/feedback/ (consumed by M7 regression export & M9 /evolve). */
export class FeedbackStore {
	private readonly feedbackDir: string;
	private seq = 0;

	constructor(feedbackDir: string) {
		this.feedbackDir = feedbackDir;
	}

	/** Save a structured failure feedback draft JSON file under evidence/feedback/. */
	save(params: {
		sessionId: string;
		description: string;
		runtime: AssistantRuntime;
		entries: readonly SessionEntry[];
		firstErrorStep?: number | null;
		now?: Date;
	}): { record: FeedbackRecord; filePath: string } {
		mkdirSync(this.feedbackDir, { recursive: true });
		this.seq += 1;
		const now = params.now ?? new Date();
		const id = `fb-${now.toISOString().replace(/[:.]/g, "-")}-${this.seq}`;

		const slice: FeedbackTrajectoryItem[] = [];
		const recentEntries = params.entries.slice(-16);
		for (let i = 0; i < recentEntries.length; i++) {
			const entry = recentEntries[i];
			if (entry.type !== "message") continue;
			slice.push({
				step: i + 1,
				entryId: entry.id,
				role: entry.message.role,
				text: extractAgentMessageText(entry.message).slice(0, 600),
			});
		}

		const record: FeedbackRecord = {
			id,
			timestamp: now.toISOString(),
			sessionId: params.sessionId,
			description: params.description.trim(),
			model: {
				provider: params.runtime.config.models.main.provider,
				model: params.runtime.config.models.main.model,
				thinking: params.runtime.config.models.main.thinking,
			},
			features: { ...params.runtime.config.features },
			firstErrorStep: params.firstErrorStep ?? (slice.length > 0 ? slice[slice.length - 1].step : null),
			errorCategory: inferFeedbackCategory(params.description),
			trajectorySlice: slice,
			processedByEvolve: false,
		};

		const filePath = join(this.feedbackDir, `${id}.json`);
		writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
		return { record, filePath };
	}

	/** Load all saved feedback records (excluding hitl-audit.jsonl). */
	listAll(): FeedbackRecord[] {
		if (!existsSync(this.feedbackDir)) return [];
		const files = readdirSync(this.feedbackDir)
			.filter((name) => name.startsWith("fb-") && name.endsWith(".json"))
			.sort((a, b) => a.localeCompare(b));
		const records: FeedbackRecord[] = [];
		for (const file of files) {
			try {
				records.push(JSON.parse(readFileSync(join(this.feedbackDir, file), "utf8")) as FeedbackRecord);
			} catch {
				// Skip corrupted files.
			}
		}
		return records;
	}

	/** Mark a feedback record as processed by /evolve. */
	markProcessed(id: string): boolean {
		const filePath = join(this.feedbackDir, `${id}.json`);
		if (!existsSync(filePath)) return false;
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as FeedbackRecord;
		parsed.processedByEvolve = true;
		writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");
		return true;
	}
}

/** Convert a captured feedback failure record into a frozen trajectory-prefix boundary test case draft. */
export function exportFeedbackAsPrefixCase(record: FeedbackRecord): ExportedPrefixBoundaryDraft {
	const cutoff =
		record.firstErrorStep !== null
			? record.trajectorySlice.filter((item) => item.step < record.firstErrorStep!)
			: record.trajectorySlice.slice(0, -1);

	const prefixMessages = (cutoff.length > 0 ? cutoff : record.trajectorySlice).map((item) => ({
		role: item.role,
		text: item.text,
	}));

	return {
		id: `prefix-from-${record.id}`,
		sourceFeedbackId: record.id,
		description: record.description,
		category: record.errorCategory,
		prefixMessages,
		acceptableActions: ["请补充可接受的下一步动作/工具集合"],
		forbiddenActions: [`重复发生反馈问题：${record.description}`],
		redLinePass3: record.errorCategory === "security_violation" || record.errorCategory === "missed_constraint",
	};
}

/** Register /feedback <描述> command onto pi's ExtensionAPI. */
export function attachFeedbackCommand(pi: ExtensionAPI, runtime: AssistantRuntime): FeedbackStore {
	const store = new FeedbackStore(runtime.workspace.feedbackDir);

	pi.registerCommand("feedback", {
		description: "记录当前会话翻车轨迹并生成结构化失败归因草稿（用法: /feedback <简述问题>）",
		handler: async (args, ctx) => {
			const description = args.trim();
			if (description.length === 0) {
				const hint = "用法：/feedback <简述遇到的问题>，例如 `/feedback 压缩后漏掉了金额保留两位小数约束`";
				if (ctx.hasUI) ctx.ui.notify(hint, "warning");
				else console.log(hint);
				return;
			}

			const { record, filePath } = store.save({
				sessionId: ctx.sessionManager.getSessionId(),
				description,
				runtime,
				entries: ctx.sessionManager.getBranch(),
			});

			const msg = [
				`已归档反馈 ${record.id}（类别=${record.errorCategory}，初判首个错误步=${record.firstErrorStep ?? "N/A"}）`,
				`文件：${filePath}`,
				"后续可运行 /evolve 离线复盘或导出为轨迹前缀回归用例。",
			].join("\n");

			if (ctx.hasUI) ctx.ui.notify(msg, "info");
			else console.log(msg);
		},
	});

	return store;
}

function extractAgentMessageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "custom":
			return extractPlainText(message.content);
		case "assistant":
		case "toolResult":
			return extractPlainText(message.content);
		case "compactionSummary":
		case "branchSummary":
			return message.summary;
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		default:
			return "";
	}
}

function extractPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(b): b is { type: string; text: string } =>
				typeof b === "object" &&
				b !== null &&
				(b as { type?: string }).type === "text" &&
				typeof (b as { text?: unknown }).text === "string",
		)
		.map((b) => b.text)
		.join("\n");
}
