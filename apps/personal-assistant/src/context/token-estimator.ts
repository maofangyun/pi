// Mixed CJK/ASCII token estimator and compaction window threshold helpers.

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

export interface ConversationTokenEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

/** L2 zero-LLM micro-compaction threshold (60%-65% of context window). */
export const L2_COMPACT_THRESHOLD_RATIO = 0.62;

/** L3 task-aware LLM compaction threshold (70%-75% of context window). */
export const L3_COMPACT_THRESHOLD_RATIO = 0.72;

const CJK_TOKEN_WEIGHT = 1.2;
const ASCII_TOKEN_WEIGHT = 0.25;
const OTHER_NON_ASCII_WEIGHT = 0.75;
const IMAGE_FALLBACK_TOKENS = 1200;
const MESSAGE_OVERHEAD_TOKENS = 8;

/** Estimate token count for mixed Chinese/English text using weighted character classes. */
export function estimateTextTokens(text: string): number {
	if (text.length === 0) return 0;
	let weight = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (code <= 0x7f) {
			weight += ASCII_TOKEN_WEIGHT;
		} else if (isCjkCodePoint(code)) {
			weight += CJK_TOKEN_WEIGHT;
		} else {
			weight += OTHER_NON_ASCII_WEIGHT;
		}
	}
	return Math.ceil(weight);
}

/** Estimate tokens for a single AgentMessage including tool calls, thinking, and custom entries. */
export function estimateMessageTokens(message: AgentMessage): number {
	switch (message.role) {
		case "user": {
			if (typeof message.content === "string") {
				return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.content);
			}
			return MESSAGE_OVERHEAD_TOKENS + estimateContentBlocks(message.content);
		}
		case "assistant": {
			let tokens = MESSAGE_OVERHEAD_TOKENS;
			for (const block of message.content) {
				if (block.type === "text") {
					tokens += estimateTextTokens(block.text);
				} else if (block.type === "thinking") {
					tokens += estimateTextTokens(block.thinking);
				} else if (block.type === "toolCall") {
					tokens += estimateTextTokens(block.name) + estimateTextTokens(JSON.stringify(block.arguments));
				}
			}
			return tokens;
		}
		case "toolResult": {
			return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.toolName) + estimateContentBlocks(message.content);
		}
		case "custom": {
			const contentTokens =
				typeof message.content === "string"
					? estimateTextTokens(message.content)
					: estimateContentBlocks(message.content);
			return MESSAGE_OVERHEAD_TOKENS + contentTokens;
		}
		case "compactionSummary":
		case "branchSummary": {
			return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.summary);
		}
		case "bashExecution": {
			return MESSAGE_OVERHEAD_TOKENS + estimateTextTokens(message.command) + estimateTextTokens(message.output);
		}
		default: {
			return MESSAGE_OVERHEAD_TOKENS;
		}
	}
}

/**
 * Estimate active conversation tokens by anchoring on the latest valid assistant usage
 * and adding CJK-weighted estimates for trailing messages since that usage.
 */
export function estimateConversationTokens(messages: readonly AgentMessage[]): ConversationTokenEstimate {
	let lastUsageIndex: number | null = null;
	let usageTokens = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const assistant = msg as AssistantMessage;
		if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
		const total = extractTotalTokens(assistant.usage);
		if (total > 0) {
			lastUsageIndex = i;
			usageTokens = total;
			break;
		}
	}

	const startIndex = lastUsageIndex === null ? 0 : lastUsageIndex + 1;
	let trailingTokens = 0;
	for (let i = startIndex; i < messages.length; i++) {
		trailingTokens += estimateMessageTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex,
	};
}

/** Compute context fill ratio clamped cleanly when contextWindow is invalid. */
export function computeUsageRatio(tokens: number, contextWindow: number): number {
	if (contextWindow <= 0 || tokens <= 0) return 0;
	return tokens / contextWindow;
}

function extractTotalTokens(usage: Usage | undefined): number {
	if (!usage) return 0;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function estimateContentBlocks(blocks: ReadonlyArray<{ type: string; text?: string }>): number {
	let tokens = 0;
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string") {
			tokens += estimateTextTokens(block.text);
		} else if (block.type === "image") {
			tokens += IMAGE_FALLBACK_TOKENS;
		}
	}
	return tokens;
}

function isCjkCodePoint(code: number): boolean {
	return (
		(code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
		(code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
		(code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
		(code >= 0x3040 && code <= 0x30ff) || // Hiragana & Katakana
		(code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
		(code >= 0xff00 && code <= 0xffef) || // Halfwidth & Fullwidth Forms
		(code >= 0x20000 && code <= 0x2a6df) // CJK Extension B
	);
}
