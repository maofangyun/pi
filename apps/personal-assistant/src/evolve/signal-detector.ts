// Pure deterministic evolution signal detector (zero LLM calls) checking the 3 manual /evolve triggers:
// weekly cadence (>=7 days), cumulative thresholds (feedback/HITL/scripts/sessions/model upgrade), and major incidents.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeedbackRecord, FeedbackStore } from "../commands/feedback.ts";
import type { AssistantRuntime } from "../extension.ts";
import type { TraceStore, TraceTurnRecord } from "../observability/trace-store.ts";
import type { HitlAuditRecord, HitlAuditStore } from "../tools/hitl.ts";

export interface EvolveState {
	lastEvolveAt: string | null;
	lastModelId: string | null;
	processedHitlIds: string[];
	mergedArtifacts: Array<{ path: string; mergedAt: string; proposalId: string }>;
}

export interface EvolveSignalReason {
	kind:
		| "weekly_cadence"
		| "feedback_threshold"
		| "repeated_category"
		| "script_pattern"
		| "session_count"
		| "model_upgrade"
		| "major_incident";
	message: string;
}

export interface EvolveSignalReport {
	shouldSuggestEvolve: boolean;
	reasons: EvolveSignalReason[];
	unprocessedFeedbackCount: number;
	unprocessedHitlRejectionCount: number;
	newSessionCount: number;
}

export interface SignalDetectionInput {
	state: EvolveState;
	feedbacks: readonly FeedbackRecord[];
	hitlRecords: readonly HitlAuditRecord[];
	traces: readonly TraceTurnRecord[];
	currentModelId: string;
	now?: Date;
}

const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FEEDBACK_AND_HITL_THRESHOLD = 3;
const REPEATED_CATEGORY_THRESHOLD = 2;
const REPEATED_SCRIPT_SUCCESS_THRESHOLD = 3;
const NEW_SESSION_THRESHOLD = 15;

/** Persistent state tracker under <workspace>/.pi/evolve-state.json. */
export class EvolveStateStore {
	private readonly statePath: string;

	constructor(workspaceRoot: string) {
		this.statePath = join(workspaceRoot, ".pi", "evolve-state.json");
	}

	read(): EvolveState {
		if (!existsSync(this.statePath)) {
			return {
				lastEvolveAt: null,
				lastModelId: null,
				processedHitlIds: [],
				mergedArtifacts: [],
			};
		}
		try {
			const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<EvolveState>;
			return {
				lastEvolveAt: typeof parsed.lastEvolveAt === "string" ? parsed.lastEvolveAt : null,
				lastModelId: typeof parsed.lastModelId === "string" ? parsed.lastModelId : null,
				processedHitlIds: Array.isArray(parsed.processedHitlIds) ? parsed.processedHitlIds : [],
				mergedArtifacts: Array.isArray(parsed.mergedArtifacts) ? parsed.mergedArtifacts : [],
			};
		} catch {
			return {
				lastEvolveAt: null,
				lastModelId: null,
				processedHitlIds: [],
				mergedArtifacts: [],
			};
		}
	}

	write(state: EvolveState): void {
		mkdirSync(dirname(this.statePath), { recursive: true });
		writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
	}

	getPath(): string {
		return this.statePath;
	}
}

/** Deterministically evaluate whether one of the 3 /evolve manual review signals has been reached. */
export function detectEvolveSignals(input: SignalDetectionInput): EvolveSignalReport {
	const now = input.now ?? new Date();
	const reasons: EvolveSignalReason[] = [];
	const processedHitl = new Set(input.state.processedHitlIds);

	const unprocessedFeedbacks = input.feedbacks.filter((fb) => !fb.processedByEvolve);
	const unprocessedHitlRejections = input.hitlRecords.filter(
		(rec) => rec.approved === false && !processedHitl.has(rec.id),
	);

	// Count distinct sessions newer than lastEvolveAt.
	const lastEvolveMs = input.state.lastEvolveAt ? new Date(input.state.lastEvolveAt).getTime() : 0;
	const newSessionIds = new Set<string>();
	const toolSuccessCounts = new Map<string, number>();

	for (const tr of input.traces) {
		const ts = new Date(tr.timestamp).getTime();
		if (ts > lastEvolveMs) {
			newSessionIds.add(tr.sessionId);
			for (const tc of tr.toolCalls) {
				if (tc.ok && (tc.name === "bash" || tc.name === "generate_html_report")) {
					toolSuccessCounts.set(tc.name, (toolSuccessCounts.get(tc.name) ?? 0) + 1);
				}
			}
		}
	}

	// Signal 3 (Major incident exception): security violation or severe hallucination report.
	const majorIncidents = unprocessedFeedbacks.filter(
		(fb) => fb.errorCategory === "security_violation" || fb.errorCategory === "right_action_wrong_report",
	);
	if (majorIncidents.length > 0) {
		reasons.push({
			kind: "major_incident",
			message: `检测到 ${majorIncidents.length} 条高严重度反馈（安全越界或“做对了但说错了”）`,
		});
	}

	// Signal 2a: Unprocessed feedback + HITL rejections >= 3.
	const totalNegativeSignals = unprocessedFeedbacks.length + unprocessedHitlRejections.length;
	if (totalNegativeSignals >= FEEDBACK_AND_HITL_THRESHOLD) {
		reasons.push({
			kind: "feedback_threshold",
			message: `未处理 /feedback (${unprocessedFeedbacks.length}) 与 HITL 拒绝 (${unprocessedHitlRejections.length}) 累计达 ${totalNegativeSignals} 条`,
		});
	}

	// Signal 2b: Same error category >= 2.
	const categoryCounts = new Map<string, number>();
	for (const fb of unprocessedFeedbacks) {
		categoryCounts.set(fb.errorCategory, (categoryCounts.get(fb.errorCategory) ?? 0) + 1);
	}
	for (const [category, count] of categoryCounts) {
		if (count >= REPEATED_CATEGORY_THRESHOLD) {
			reasons.push({
				kind: "repeated_category",
				message: `同类错误 "${category}" 累计出现 ${count} 次`,
			});
		}
	}

	// Signal 2c: Repeated successful script workflows >= 3.
	for (const [toolName, count] of toolSuccessCounts) {
		if (count >= REPEATED_SCRIPT_SUCCESS_THRESHOLD) {
			reasons.push({
				kind: "script_pattern",
				message: `高频数据处理流程 (${toolName}) 已稳定跑通 ${count} 次，可沉淀为确定性脚本或 Skill`,
			});
			break;
		}
	}

	// Signal 2d: Cumulative new sessions >= 15.
	if (newSessionIds.size >= NEW_SESSION_THRESHOLD) {
		reasons.push({
			kind: "session_count",
			message: `距上次复盘已累计新增 ${newSessionIds.size} 个会话`,
		});
	}

	// Signal 2e: Main model upgraded.
	if (input.state.lastModelId && input.state.lastModelId !== input.currentModelId) {
		reasons.push({
			kind: "model_upgrade",
			message: `主模型已从 ${input.state.lastModelId} 切换为 ${input.currentModelId}`,
		});
	}

	// Signal 1: Weekly cadence (>= 7 days since last evolve and at least 1 new session or feedback).
	if (
		input.state.lastEvolveAt &&
		now.getTime() - lastEvolveMs >= WEEKLY_INTERVAL_MS &&
		(newSessionIds.size > 0 || totalNegativeSignals > 0)
	) {
		const days = Math.floor((now.getTime() - lastEvolveMs) / (24 * 60 * 60 * 1000));
		reasons.push({
			kind: "weekly_cadence",
			message: `距上次离线复盘已过 ${days} 天（周节奏提醒）`,
		});
	}

	return {
		shouldSuggestEvolve: reasons.length > 0,
		reasons,
		unprocessedFeedbackCount: unprocessedFeedbacks.length,
		unprocessedHitlRejectionCount: unprocessedHitlRejections.length,
		newSessionCount: newSessionIds.size,
	};
}

/** Format a single-line lightweight TUI hint suggesting manual /evolve (never auto-executes). */
export function formatEvolveSuggestionLine(report: EvolveSignalReport): string | undefined {
	if (!report.shouldSuggestEvolve || report.reasons.length === 0) return undefined;
	return `[进化提示] ${report.reasons[0].message}；可随时手动运行 /evolve 审阅离线进化提案。`;
}

/** Attach lightweight zero-LLM /evolve reminder on session_start. */
export function attachEvolveSignalDetector(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	deps: {
		stateStore: EvolveStateStore;
		feedbackStore: FeedbackStore;
		hitlStore: HitlAuditStore;
		traceStore: TraceStore;
	},
): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const report = detectEvolveSignals({
			state: deps.stateStore.read(),
			feedbacks: deps.feedbackStore.listAll(),
			hitlRecords: deps.hitlStore.readAll(),
			traces: deps.traceStore.loadAll(),
			currentModelId: `${runtime.config.models.main.provider}/${runtime.config.models.main.model}`,
		});
		const hint = formatEvolveSuggestionLine(report);
		if (hint) {
			ctx.ui.notify(hint, "info");
		}
	});
}
