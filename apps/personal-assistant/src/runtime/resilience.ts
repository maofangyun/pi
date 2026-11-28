// Four-layer runtime failure resilience: streaming idle watchdog, transient backoff helpers,
// duplicate tool-call fingerprint loop breaker, death-spiral prevention, and pause-on-main-model-failure policy.

import { createHash } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ResilienceOptions {
	idleTimeoutMs?: number;
	maxDuplicateFailures?: number;
	onWatchdogAbort?: (idleMs: number) => void;
}

export interface DuplicateCallVerdict {
	fingerprint: string;
	consecutiveFailures: number;
	tripped: boolean;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DUPLICATE_FAILURES = 3;

/** Produce a deterministic canonical JSON representation with sorted object keys for fingerprinting. */
export function canonicalizeArgs(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeArgs(item)).join(",")}]`;
	}
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalizeArgs((value as Record<string, unknown>)[k])}`);
	return `{${pairs.join(",")}}`;
}

/** Compute SHA-256 fingerprint for toolName + canonical arguments. */
export function computeToolCallFingerprint(toolName: string, args: Record<string, unknown>): string {
	return createHash("sha256").update(toolName).update("\0").update(canonicalizeArgs(args)).digest("hex").slice(0, 16);
}

/** Detect transient HTTP/network errors eligible for exponential backoff retry (429/5xx/socket resets). */
export function isTransientProviderError(statusOrMessage: number | string): boolean {
	if (typeof statusOrMessage === "number") {
		return statusOrMessage === 429 || statusOrMessage === 408 || (statusOrMessage >= 500 && statusOrMessage <= 599);
	}
	return /(?:429|rate limit|too many requests|502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed)/i.test(
		statusOrMessage,
	);
}

/** Compute capped exponential backoff delay in milliseconds. */
export function computeExponentialBackoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
	const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
	return exp;
}

/** Streaming idle watchdog that aborts stalled provider streams when no chunks arrive within idleTimeoutMs. */
export class StreamIdleWatchdog {
	private readonly idleTimeoutMs: number;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private active = false;
	private lastActivityMs = 0;

	constructor(idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
		this.idleTimeoutMs = idleTimeoutMs;
	}

	/** Start or arm the watchdog for an active streaming turn. */
	start(onTimeout: (idleMs: number) => void): void {
		this.stop();
		this.active = true;
		this.lastActivityMs = Date.now();
		this.armTimer(onTimeout);
	}

	/** Refresh liveness timestamp upon receiving any stream chunk or event. */
	touch(onTimeout: (idleMs: number) => void): void {
		if (!this.active) return;
		this.lastActivityMs = Date.now();
		this.armTimer(onTimeout);
	}

	/** Stop and clear timers when streaming ends or session shuts down. */
	stop(): void {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Whether the watchdog is currently armed. */
	isActive(): boolean {
		return this.active;
	}

	private armTimer(onTimeout: (idleMs: number) => void): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			if (!this.active) return;
			const idleMs = Date.now() - this.lastActivityMs;
			this.active = false;
			onTimeout(idleMs);
		}, this.idleTimeoutMs);
	}
}

/** Detects identical repeated failing tool calls (toolName + canonicalArgs) to break infinite loops. */
export class DuplicateCallDetector {
	private readonly maxFailures: number;
	private readonly failureCounts = new Map<string, number>();

	constructor(maxFailures = DEFAULT_MAX_DUPLICATE_FAILURES) {
		this.maxFailures = maxFailures;
	}

	/** Check whether a call fingerprint has already hit the consecutive duplicate failure ceiling. */
	check(toolName: string, args: Record<string, unknown>): DuplicateCallVerdict {
		const fingerprint = computeToolCallFingerprint(toolName, args);
		const consecutiveFailures = this.failureCounts.get(fingerprint) ?? 0;
		return {
			fingerprint,
			consecutiveFailures,
			tripped: consecutiveFailures >= this.maxFailures,
		};
	}

	/** Record outcome of a completed tool call; resets count on success, increments on error. */
	recordOutcome(toolName: string, args: Record<string, unknown>, isError: boolean): DuplicateCallVerdict {
		const fingerprint = computeToolCallFingerprint(toolName, args);
		if (!isError) {
			this.failureCounts.delete(fingerprint);
			return { fingerprint, consecutiveFailures: 0, tripped: false };
		}
		const next = (this.failureCounts.get(fingerprint) ?? 0) + 1;
		this.failureCounts.set(fingerprint, next);
		return {
			fingerprint,
			consecutiveFailures: next,
			tripped: next >= this.maxFailures,
		};
	}

	/** Clear all fingerprint counters. */
	reset(): void {
		this.failureCounts.clear();
	}
}

/** Tracks abnormal/error exit state to prevent death-spiral background LLM hooks on shutdown. */
export class AbnormalExitTracker {
	private abnormal = false;
	private reason: string | undefined;

	markAbnormal(reason: string): void {
		this.abnormal = true;
		this.reason = reason;
	}

	clear(): void {
		this.abnormal = false;
		this.reason = undefined;
	}

	isAbnormal(): boolean {
		return this.abnormal;
	}

	getReason(): string | undefined {
		return this.reason;
	}
}

export interface AttachedResilience {
	watchdog: StreamIdleWatchdog;
	duplicateDetector: DuplicateCallDetector;
	abnormalExit: AbnormalExitTracker;
}

/** Attach all 4 failure recovery guardrails onto pi's ExtensionAPI. */
export function attachResilienceModule(pi: ExtensionAPI, options: ResilienceOptions = {}): AttachedResilience {
	const watchdog = new StreamIdleWatchdog(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
	const duplicateDetector = new DuplicateCallDetector(options.maxDuplicateFailures ?? DEFAULT_MAX_DUPLICATE_FAILURES);
	const abnormalExit = new AbnormalExitTracker();
	let activeAbort: (() => void) | undefined;

	const triggerIdleAbort = (idleMs: number) => {
		abnormalExit.markAbnormal(`流式空闲超时 (${idleMs}ms)`);
		options.onWatchdogAbort?.(idleMs);
		activeAbort?.();
	};

	pi.on("session_start", () => {
		watchdog.stop();
		duplicateDetector.reset();
		abnormalExit.clear();
	});

	pi.on("agent_start", (_event, ctx) => {
		abnormalExit.clear();
		activeAbort = () => {
			if (ctx.hasUI) {
				ctx.ui.notify("检测到主模型流式响应长时间空闲卡死，看门狗已主动中止当前请求。", "warning");
			}
			ctx.abort();
		};
		watchdog.start(triggerIdleAbort);
	});

	pi.on("provider_stream_event", () => {
		watchdog.touch(triggerIdleAbort);
	});

	pi.on("message_update", () => {
		watchdog.touch(triggerIdleAbort);
	});

	pi.on("agent_end", (event, ctx) => {
		watchdog.stop();
		activeAbort = undefined;

		// Check main model failure policy: pause & report clearly, never switch vendors automatically.
		const lastMsg = event.messages[event.messages.length - 1];
		if (lastMsg && lastMsg.role === "assistant") {
			const assistant = lastMsg as AssistantMessage;
			if (assistant.stopReason === "error") {
				const errMsg = assistant.errorMessage ?? "主模型调用失败";
				abnormalExit.markAbnormal(errMsg);
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`[主模型异常暂停] ${assistant.provider}/${assistant.model} 调用失败：${errMsg}`,
							"按架构策略不做跨厂商自动接管。已暂停后台摘要钩子，请检查网络/额度后重试，或运行 /doctor 诊断。",
						].join("\n"),
						"error",
					);
				}
			}
		}
	});

	pi.on("tool_call", (event) => {
		const verdict = duplicateDetector.check(event.toolName, event.input as Record<string, unknown>);
		if (verdict.tripped) {
			abnormalExit.markAbnormal(`工具 ${event.toolName} 连续 ${verdict.consecutiveFailures} 次同参数失败`);
			return {
				block: true,
				reason: `重复调用指纹熔断：工具 "${event.toolName}" 使用完全相同参数（fingerprint=${verdict.fingerprint}）已连续失败 ${verdict.consecutiveFailures} 次。请停止盲目重试，改换实现思路或向用户汇报障碍。`,
			};
		}
		return undefined;
	});

	pi.on("tool_result", (event) => {
		duplicateDetector.recordOutcome(event.toolName, event.input, event.isError);
	});

	pi.on("session_shutdown", () => {
		watchdog.stop();
	});

	return { watchdog, duplicateDetector, abnormalExit };
}
