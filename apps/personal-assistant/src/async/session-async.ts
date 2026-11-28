// Phase 1 in-session asynchronous primitives:
// 1. Cancel-interrupt with explicit unfinished tool_result placeholder + M8 hasInterruptPlaceholder metadata;
// 2. Queue-based mid-execution user supplements delivered as numbered [未处理事件 i/N] batches at safe points.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CustomMessageEntryDraft, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const INTERRUPT_PLACEHOLDER_TEXT = "[工具已被用户中断，未完成]";
export const INTERRUPT_METADATA_ENTRY_TYPE = "assistant-interrupt-metadata";
export const QUEUED_EVENTS_CUSTOM_TYPE = "assistant-queued-events";

export interface QueuedUserEvent {
	id: string;
	text: string;
	timestamp: number;
	source: "user" | "background";
}

export interface InFlightToolExecution {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	cancel?: () => void;
}

export interface InterruptMetadataRecord {
	hasInterruptPlaceholder: true;
	interruptedToolCallIds: string[];
	interruptedToolNames: string[];
	timestamp: string;
	reason: string;
}

export interface SessionAsyncController {
	queue: PendingEventQueue;
	registerInFlightCancel(toolCallId: string, cancel: () => void): void;
	getInFlightToolCalls(): InFlightToolExecution[];
	cancelAllInFlight(reason?: string): InterruptMetadataRecord | undefined;
	getInterruptRecords(): InterruptMetadataRecord[];
}

/** FIFO queue capturing mid-execution user supplements and formatting them as numbered [未处理事件 i/N] batches. */
export class PendingEventQueue {
	private readonly items: QueuedUserEvent[] = [];
	private seq = 0;

	/** Append a new event to the queue; returns the new queue size. */
	enqueue(text: string, source: "user" | "background" = "user", timestamp = Date.now()): number {
		const trimmed = text.trim();
		if (trimmed.length === 0) return this.items.length;
		this.seq += 1;
		this.items.push({
			id: `evt-q-${this.seq}`,
			text: trimmed,
			timestamp,
			source,
		});
		return this.items.length;
	}

	/** Number of currently pending queued events. */
	size(): number {
		return this.items.length;
	}

	/** Drain all queued events atomically and return them in FIFO order. */
	drain(): QueuedUserEvent[] {
		return this.items.splice(0, this.items.length);
	}

	/** Clear queued events without delivering (e.g. on session switch). */
	clear(): void {
		this.items.length = 0;
	}
}

/** Format a batch of queued mid-execution events with explicit [未处理事件 i/N] numbering. */
export function formatQueuedEventsBatch(events: readonly QueuedUserEvent[]): string {
	if (events.length === 0) return "";
	const total = events.length;
	const lines = [`在工具执行期间收到 ${total} 条补充事件，请逐条完整处理（禁止仅关注最后一条）：`];
	for (let i = 0; i < total; i++) {
		const evt = events[i];
		const timeLabel = formatHms(new Date(evt.timestamp));
		const sourceTag = evt.source === "background" ? "后台通知" : "用户补充";
		lines.push(`[未处理事件 ${i + 1}/${total}] (${timeLabel} ${sourceTag}) ${evt.text}`);
	}
	return lines.join("\n");
}

/**
 * Create a protocol-valid synthetic toolResult placeholder for an interrupted toolCall.
 * Never fabricates success; preserves DeepSeek/OpenAI tool_call <-> tool_result pairing contract.
 */
export function createInterruptToolResult(
	toolCallId: string,
	toolName: string,
	timestamp = Date.now(),
): ToolResultMessage<{ hasInterruptPlaceholder: true; interrupted: true }> {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: INTERRUPT_PLACEHOLDER_TEXT }],
		details: { hasInterruptPlaceholder: true, interrupted: true },
		isError: true,
		timestamp,
	};
}

/**
 * Validate and repair conversation messages so every assistant toolCall has a matching toolResult.
 * Any dangling toolCall left behind after an abrupt cancel/interrupt receives an explicit unfinished placeholder
 * so subsequent DeepSeek requests never fail with HTTP 400 tool_call_id mismatch errors.
 */
export function ensureValidToolCallPairing(messages: readonly AgentMessage[]): {
	messages: AgentMessage[];
	repairedToolCallIds: string[];
	hasInterruptPlaceholder: boolean;
} {
	const existingResultIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			existingResultIds.add(msg.toolCallId);
		}
	}

	const repaired: AgentMessage[] = [];
	const repairedToolCallIds: string[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		repaired.push(msg);

		if (msg.role !== "assistant") continue;

		const missingCalls = msg.content.filter(
			(block): block is Extract<(typeof msg.content)[number], { type: "toolCall" }> =>
				block.type === "toolCall" && !existingResultIds.has(block.id),
		);
		if (missingCalls.length === 0) continue;

		// Only inject placeholders when another message follows OR when the assistant turn was aborted.
		const hasFollowingMessage = i < messages.length - 1;
		const isAbortedTurn = msg.stopReason === "aborted";
		if (!hasFollowingMessage && !isAbortedTurn) continue;

		for (const call of missingCalls) {
			repairedToolCallIds.push(call.id);
			existingResultIds.add(call.id);
			repaired.push(createInterruptToolResult(call.id, call.name, msg.timestamp + 1));
		}
	}

	const hasExistingPlaceholder = repaired.some(
		(msg) =>
			msg.role === "toolResult" &&
			msg.content.some((b) => b.type === "text" && b.text.includes(INTERRUPT_PLACEHOLDER_TEXT)),
	);

	return {
		messages: repaired,
		repairedToolCallIds,
		hasInterruptPlaceholder: repairedToolCallIds.length > 0 || hasExistingPlaceholder,
	};
}

/** Attach Phase 1 in-session async interrupt placeholders and queued supplement batching onto pi. */
export function attachSessionAsyncModule(pi: ExtensionAPI): SessionAsyncController {
	const queue = new PendingEventQueue();
	const inFlight = new Map<string, InFlightToolExecution>();
	const interruptRecords: InterruptMetadataRecord[] = [];
	let sessionRunning = false;

	const recordInterruptMetadata = (
		toolCalls: readonly InFlightToolExecution[],
		reason: string,
	): InterruptMetadataRecord => {
		const record: InterruptMetadataRecord = {
			hasInterruptPlaceholder: true,
			interruptedToolCallIds: toolCalls.map((t) => t.toolCallId),
			interruptedToolNames: toolCalls.map((t) => t.toolName),
			timestamp: new Date().toISOString(),
			reason,
		};
		interruptRecords.push(record);
		pi.appendEntry(INTERRUPT_METADATA_ENTRY_TYPE, record);
		return record;
	};

	const cancelAllInFlight = (reason = "用户主动中断执行"): InterruptMetadataRecord | undefined => {
		if (inFlight.size === 0) return undefined;
		const snapshot = [...inFlight.values()];
		for (const item of snapshot) {
			try {
				item.cancel?.();
			} catch {
				// Best-effort process/container cancellation.
			}
		}
		inFlight.clear();
		return recordInterruptMetadata(snapshot, reason);
	};

	pi.on("session_start", () => {
		queue.clear();
		inFlight.clear();
		interruptRecords.length = 0;
		sessionRunning = false;
	});

	pi.on("agent_start", () => {
		sessionRunning = true;
	});

	pi.on("tool_execution_start", (event) => {
		inFlight.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt: Date.now(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		inFlight.delete(event.toolCallId);
	});

	// If a tool returns after an interrupt signal with aborted/empty output, normalize to explicit unfinished placeholder.
	pi.on("tool_result", (event, ctx) => {
		if (!ctx.signal?.aborted) return undefined;
		inFlight.delete(event.toolCallId);
		recordInterruptMetadata(
			[{ toolCallId: event.toolCallId, toolName: event.toolName, startedAt: Date.now() }],
			"tool_result observed aborted signal",
		);
		const existingDetails =
			typeof event.details === "object" && event.details !== null && !Array.isArray(event.details)
				? (event.details as Record<string, unknown>)
				: {};
		return {
			content: [{ type: "text", text: INTERRUPT_PLACEHOLDER_TEXT }],
			details: { ...existingDetails, hasInterruptPlaceholder: true, interrupted: true },
			isError: true,
		};
	});

	// Queue mid-execution user supplements instead of interrupting running tools; flush at safe point.
	pi.on("input", (event, ctx) => {
		const isBusy = sessionRunning || inFlight.size > 0 || !ctx.isIdle();
		if (!isBusy) return { action: "continue" };

		const trimmed = event.text.trim();
		// Never swallow slash commands like /cancel or /doctor.
		if (trimmed.length === 0 || trimmed.startsWith("/")) {
			return { action: "continue" };
		}

		const count = queue.enqueue(trimmed, "user");
		if (ctx.hasUI) {
			ctx.ui.notify(`已入队补充说明（共 ${count} 条），将在当前工具返回安全点后统一编号注入。`, "info");
		}
		return { action: "handled" };
	});

	// Flush queued events at turn_end safe point right after tool results return.
	pi.on("turn_end", (event) => {
		if (queue.size() === 0) return undefined;
		const drained = queue.drain();
		const batchDraft: CustomMessageEntryDraft = {
			type: "custom_message",
			customType: QUEUED_EVENTS_CUSTOM_TYPE,
			content: formatQueuedEventsBatch(drained),
			display: true,
			details: { count: drained.length, events: drained },
		};
		return {
			entries: [...event.entries, batchDraft],
			continue: true,
		};
	});

	// Also flush before final settlement in case events arrived during the final assistant text turn.
	pi.on("agent_before_settle", (event) => {
		if (queue.size() === 0) return undefined;
		const drained = queue.drain();
		const batchDraft: CustomMessageEntryDraft = {
			type: "custom_message",
			customType: QUEUED_EVENTS_CUSTOM_TYPE,
			content: formatQueuedEventsBatch(drained),
			display: true,
			details: { count: drained.length, events: drained },
		};
		return {
			entries: [...event.entries, batchDraft],
			continue: true,
		};
	});

	// Guarantee valid tool_call <-> tool_result pairing before every LLM call (prevents DeepSeek HTTP 400 after cancel).
	pi.on("context", (event) => {
		const { messages, repairedToolCallIds } = ensureValidToolCallPairing(event.messages);
		if (repairedToolCallIds.length === 0) return undefined;
		recordInterruptMetadata(
			repairedToolCallIds.map((id) => ({ toolCallId: id, toolName: "interrupted_tool", startedAt: Date.now() })),
			"repaired dangling tool_call before next LLM turn",
		);
		return { messages };
	});

	pi.on("agent_settled", (event) => {
		sessionRunning = false;
		if (event.aborted && inFlight.size > 0) {
			cancelAllInFlight("agent_settled(aborted=true)");
		}
	});

	pi.on("session_shutdown", () => {
		sessionRunning = false;
		if (inFlight.size > 0) {
			cancelAllInFlight("session_shutdown");
		}
	});

	// Explicit emergency cancel command in TUI.
	pi.registerCommand("cancel", {
		description: "紧急中止当前流式推理与正在运行的沙箱工具，并写入规范未完成占位符",
		handler: async (_args, ctx) => {
			const record = cancelAllInFlight("用户执行 /cancel 紧急打断");
			ctx.abort();
			const msg = record
				? `已中止 ${record.interruptedToolCallIds.length} 个进行中工具并写入未完成占位符（hasInterruptPlaceholder=true）。`
				: "已触发当前执行中止信号。";
			if (ctx.hasUI) {
				ctx.ui.notify(msg, "warning");
			} else {
				console.log(msg);
			}
		},
	});

	return {
		queue,
		registerInFlightCancel(toolCallId, cancel) {
			const existing = inFlight.get(toolCallId);
			if (existing) {
				existing.cancel = cancel;
			} else {
				inFlight.set(toolCallId, { toolCallId, toolName: "unknown", startedAt: Date.now(), cancel });
			}
		},
		getInFlightToolCalls() {
			return [...inFlight.values()];
		},
		cancelAllInFlight,
		getInterruptRecords() {
			return [...interruptRecords];
		},
	};
}

function formatHms(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
