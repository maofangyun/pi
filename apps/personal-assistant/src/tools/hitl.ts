// Human-in-the-loop tools (request_human_approval, request_human_input) and audit log persistence
// for Chapter 9 offline evolution learning.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";

export type HitlAuditKind = "approval" | "input" | "security_confirm";

export interface HitlAuditRecord {
	id: string;
	timestamp: string;
	sessionId: string;
	kind: HitlAuditKind;
	actionSummary: string;
	approved?: boolean;
	response?: string;
	reason?: string;
	riskLevel?: "low" | "medium" | "high";
	affectedPaths?: string[];
	commandPreview?: string;
}

export interface ApprovalRequest {
	sessionId: string;
	kind?: HitlAuditKind;
	actionSummary: string;
	riskLevel?: "low" | "medium" | "high";
	affectedPaths?: string[];
	commandPreview?: string;
	diffPreview?: string;
}

export interface ApprovalDecision {
	approved: boolean;
	reason?: string;
	auditId: string;
}

const APPROVE_LABEL = "批准执行 (Approve)";
const REJECT_LABEL = "拒绝 (Reject)";

const RequestHumanApprovalParams = Type.Object({
	action_summary: Type.String({ description: "待人工确认的操作摘要" }),
	risk_level: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
	affected_paths: Type.Optional(Type.Array(Type.String(), { description: "受影响文件或目录清单" })),
	command_preview: Type.Optional(Type.String({ description: "将要执行的精确命令预览" })),
	diff_preview: Type.Optional(Type.String({ description: "变更 diff 预览" })),
});

const RequestHumanInputParams = Type.Object({
	question: Type.String({ description: "向用户提出的问题" }),
	choices: Type.Optional(Type.Array(Type.String(), { description: "可选的候选列表；省略时弹出自由文本输入" })),
	placeholder: Type.Optional(Type.String({ description: "文本输入提示占位符" })),
});

/** Append-only audit log for human approval/rejection decisions and reasons (consumed by M9 /evolve). */
export class HitlAuditStore {
	private readonly auditFilePath: string;
	private counter = 0;

	constructor(feedbackDir: string) {
		this.auditFilePath = join(feedbackDir, "hitl-audit.jsonl");
	}

	/** Append one HITL decision record to evidence/feedback/hitl-audit.jsonl. */
	record(entry: Omit<HitlAuditRecord, "id" | "timestamp"> & { timestamp?: string }): HitlAuditRecord {
		mkdirSync(join(this.auditFilePath, ".."), { recursive: true });
		this.counter += 1;
		const full: HitlAuditRecord = {
			id: `hitl-${Date.now()}-${this.counter}`,
			timestamp: entry.timestamp ?? new Date().toISOString(),
			sessionId: entry.sessionId,
			kind: entry.kind,
			actionSummary: entry.actionSummary,
			approved: entry.approved,
			response: entry.response,
			reason: entry.reason,
			riskLevel: entry.riskLevel,
			affectedPaths: entry.affectedPaths,
			commandPreview: entry.commandPreview,
		};
		appendFileSync(this.auditFilePath, `${JSON.stringify(full)}\n`, "utf8");
		return full;
	}

	/** Read all recorded HITL audit entries. */
	readAll(): HitlAuditRecord[] {
		if (!existsSync(this.auditFilePath)) return [];
		const lines = readFileSync(this.auditFilePath, "utf8").split(/\r?\n/);
		const records: HitlAuditRecord[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as HitlAuditRecord);
			} catch {
				// Skip malformed lines cleanly.
			}
		}
		return records;
	}

	/** Execute an interactive two-stage confirmation dialog (fail-closed when non-interactive) and audit the outcome. */
	async promptForApproval(
		ctx: Pick<ExtensionContext, "hasUI" | "ui">,
		req: ApprovalRequest,
	): Promise<ApprovalDecision> {
		if (!ctx.hasUI) {
			const audit = this.record({
				sessionId: req.sessionId,
				kind: req.kind ?? "approval",
				actionSummary: req.actionSummary,
				approved: false,
				reason: "非交互模式默认拒绝高风险操作（fail-closed）",
				riskLevel: req.riskLevel,
				affectedPaths: req.affectedPaths,
				commandPreview: req.commandPreview,
			});
			return { approved: false, reason: audit.reason, auditId: audit.id };
		}

		const titleLines = [`[需要人工确认 | 风险=${req.riskLevel ?? "high"}] ${req.actionSummary}`];
		if (req.commandPreview) {
			titleLines.push(`命令: ${req.commandPreview}`);
		}
		if (req.affectedPaths && req.affectedPaths.length > 0) {
			titleLines.push(`影响范围: ${req.affectedPaths.join(", ")}`);
		}
		if (req.diffPreview) {
			titleLines.push(`变更预览:\n${req.diffPreview.slice(0, 600)}`);
		}

		const choice = await ctx.ui.select(titleLines.join("\n"), [APPROVE_LABEL, REJECT_LABEL]);
		const approved = choice === APPROVE_LABEL;

		let reason: string | undefined;
		if (!approved) {
			const inputReason = await ctx.ui.input("拒绝原因（可选，将沉淀供后续进化学习）", "留空跳过");
			reason = inputReason?.trim() || "用户拒绝";
		}

		const audit = this.record({
			sessionId: req.sessionId,
			kind: req.kind ?? "approval",
			actionSummary: req.actionSummary,
			approved,
			reason,
			riskLevel: req.riskLevel,
			affectedPaths: req.affectedPaths,
			commandPreview: req.commandPreview,
		});

		return { approved, reason, auditId: audit.id };
	}

	/** Path of the HITL audit JSONL file. */
	getAuditFilePath(): string {
		return this.auditFilePath;
	}
}

/** Register request_human_approval and request_human_input tools onto pi's ExtensionAPI. */
export function attachHitlTools(pi: ExtensionAPI, runtime: AssistantRuntime): HitlAuditStore {
	const auditStore = new HitlAuditStore(runtime.workspace.feedbackDir);

	pi.registerTool({
		name: "request_human_approval",
		label: "Request Human Approval",
		description:
			"对高风险、不可逆或越界操作发起两段式人工确认（展示命令、受影响文件与 diff 预览），批准或拒绝理由自动记入审计日志。",
		promptSnippet: "对不可逆或高风险操作暂停请求人工两段式批准并记录理由",
		parameters: RequestHumanApprovalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = await auditStore.promptForApproval(ctx, {
				sessionId: ctx.sessionManager.getSessionId(),
				kind: "approval",
				actionSummary: params.action_summary,
				riskLevel: params.risk_level ?? "high",
				affectedPaths: params.affected_paths,
				commandPreview: params.command_preview,
				diffPreview: params.diff_preview,
			});

			const text = decision.approved
				? `用户已批准该操作（audit_id=${decision.auditId}）。`
				: `用户已拒绝该操作（audit_id=${decision.auditId}，原因：${decision.reason ?? "未填写"}）。请停止该动作或按用户意见调整方案。`;

			return {
				content: [{ type: "text", text }],
				details: decision,
			};
		},
	});

	pi.registerTool({
		name: "request_human_input",
		label: "Request Human Input",
		description: "在需求存在关键歧义时暂停等待用户选择或输入补充信息。",
		promptSnippet: "遇到关键歧义时暂停向用户收集明确选择或补充输入",
		parameters: RequestHumanInputParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				const audit = auditStore.record({
					sessionId: ctx.sessionManager.getSessionId(),
					kind: "input",
					actionSummary: params.question,
					response: undefined,
					reason: "非交互模式无法收集人工输入",
				});
				return {
					content: [{ type: "text", text: `非交互模式无法向用户提问（audit_id=${audit.id}）。` }],
					details: { answered: false, auditId: audit.id },
				};
			}

			const answer =
				params.choices && params.choices.length > 0
					? await ctx.ui.select(params.question, params.choices)
					: await ctx.ui.input(params.question, params.placeholder);

			const audit = auditStore.record({
				sessionId: ctx.sessionManager.getSessionId(),
				kind: "input",
				actionSummary: params.question,
				response: answer,
			});

			return {
				content: [
					{
						type: "text",
						text: answer !== undefined ? `用户回复：${answer}` : "用户取消了输入，请暂停等待进一步指示。",
					},
				],
				details: { answered: answer !== undefined, response: answer, auditId: audit.id },
			};
		},
	});

	return auditStore;
}
