// Deterministic <agent_status> tail injection for side-channel time, environment, tool counters, and TODOs.

import { execFileSync } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantRuntime } from "../extension.ts";
import type { TodoStore } from "./todo.ts";

export interface ToolStatsEntry {
	calls: number;
	failures: number;
	consecutiveFailures: number;
	lastError?: string;
}

export interface KnowledgeGitSummary {
	branch: string;
	dirtyCount: number;
}

export interface AgentStatusInput {
	now: Date;
	lastUserInteractionAt: Date | undefined;
	cwd: string;
	platform: string;
	shell: string;
	dockerSandboxEnabled: boolean;
	knowledgeGit: KnowledgeGitSummary | undefined;
	toolStats: ReadonlyMap<string, ToolStatsEntry>;
	todoSummary: string;
}

const AGENT_STATUS_OPEN_TAG = "<agent_status>";
const AGENT_STATUS_CLOSE_TAG = "</agent_status>";
const FAILURE_ALERT_THRESHOLD = 2;

/** Deterministic session-scoped counter for tool invocations and consecutive failure alerts. */
export class ToolStatsTracker {
	private readonly stats = new Map<string, ToolStatsEntry>();

	/** Record one completed tool execution result. */
	record(toolName: string, isError: boolean, errorSummary?: string): void {
		const existing = this.stats.get(toolName) ?? {
			calls: 0,
			failures: 0,
			consecutiveFailures: 0,
		};
		existing.calls += 1;
		if (isError) {
			existing.failures += 1;
			existing.consecutiveFailures += 1;
			existing.lastError = errorSummary ? truncateSingleLine(errorSummary, 120) : "unknown error";
		} else {
			existing.consecutiveFailures = 0;
			existing.lastError = undefined;
		}
		this.stats.set(toolName, existing);
	}

	/** Reset all counters (e.g. when starting or switching a session). */
	reset(): void {
		this.stats.clear();
	}

	/** Read-only view of accumulated per-tool stats. */
	getAll(): ReadonlyMap<string, ToolStatsEntry> {
		return this.stats;
	}
}

/** Render the deterministic <agent_status> block appended at the tail of LLM context. */
export function buildAgentStatusBlock(input: AgentStatusInput): string {
	const elapsed =
		input.lastUserInteractionAt === undefined
			? "首次交互"
			: formatDuration(Math.max(0, input.now.getTime() - input.lastUserInteractionAt.getTime()));

	const gitInfo = input.knowledgeGit
		? `branch=${input.knowledgeGit.branch}, uncommitted=${input.knowledgeGit.dirtyCount}`
		: "未初始化";

	const toolSummaryLines: string[] = [];
	const alerts: string[] = [];

	const sortedTools = [...input.toolStats.entries()].sort(([a], [b]) => a.localeCompare(b));
	if (sortedTools.length === 0) {
		toolSummaryLines.push("(本会话尚未调用工具)");
	} else {
		const counts = sortedTools.map(([name, s]) =>
			s.failures > 0 ? `${name}:${s.calls}(fail=${s.failures})` : `${name}:${s.calls}`,
		);
		toolSummaryLines.push(counts.join(", "));
		for (const [name, s] of sortedTools) {
			if (s.consecutiveFailures >= FAILURE_ALERT_THRESHOLD) {
				alerts.push(
					`[告警] 工具 ${name} 已连续失败 ${s.consecutiveFailures} 次（最近错误: ${s.lastError ?? "unknown"}），请更换策略而非盲目重试。`,
				);
			}
		}
	}

	const sections = [
		AGENT_STATUS_OPEN_TAG,
		`time: ${formatLocalDateTime(input.now)} | since_last_user_input: ${elapsed}`,
		`env: cwd=${input.cwd.replace(/\\/g, "/")} | os=${input.platform} | shell=${input.shell} | docker_sandbox=${input.dockerSandboxEnabled ? "on" : "off"}`,
		`knowledge_git: ${gitInfo}`,
		`tool_calls: ${toolSummaryLines.join(" ")}`,
	];

	if (alerts.length > 0) {
		sections.push("alerts:");
		for (const alert of alerts) {
			sections.push(`  ${alert}`);
		}
	}

	sections.push("todos:");
	for (const line of input.todoSummary.split("\n")) {
		sections.push(`  ${line}`);
	}
	sections.push(AGENT_STATUS_CLOSE_TAG);

	return sections.join("\n");
}

/** Create a user-role context message carrying the deterministic <agent_status> tail block. */
export function createAgentStatusMessage(statusText: string, timestamp = Date.now()): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text: statusText }],
		timestamp,
	};
}

/** Check whether a message is an ephemeral <agent_status> block injected at context tail. */
export function isAgentStatusMessage(message: AgentMessage): boolean {
	if (message.role !== "user") return false;
	if (typeof message.content === "string") {
		return message.content.startsWith(AGENT_STATUS_OPEN_TAG) && message.content.endsWith(AGENT_STATUS_CLOSE_TAG);
	}
	if (message.content.length !== 1 || message.content[0].type !== "text") return false;
	const text = message.content[0].text;
	return text.startsWith(AGENT_STATUS_OPEN_TAG) && text.endsWith(AGENT_STATUS_CLOSE_TAG);
}

/** Read branch and uncommitted count for knowledge/ Git repository without throwing. */
export function readKnowledgeGitSummary(knowledgeDir: string): KnowledgeGitSummary | undefined {
	try {
		const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: knowledgeDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const statusOut = execFileSync("git", ["status", "--porcelain"], {
			cwd: knowledgeDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const dirtyCount = statusOut
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0).length;
		return { branch: branch || "HEAD", dirtyCount };
	} catch {
		return undefined;
	}
}

/** Attach deterministic <agent_status> tail injection onto pi's context and tool_result hooks. */
export function attachStatusBarModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	todoStore: TodoStore,
	nowFn: () => Date = () => new Date(),
): ToolStatsTracker {
	const tracker = new ToolStatsTracker();
	let lastUserInteractionAt: Date | undefined;

	pi.on("session_start", () => {
		tracker.reset();
		lastUserInteractionAt = undefined;
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user") {
			lastUserInteractionAt = nowFn();
		}
	});

	pi.on("tool_result", (event) => {
		const errorText = event.isError ? extractFirstText(event.content) : undefined;
		tracker.record(event.toolName, event.isError, errorText);
	});

	pi.on("context", (event, ctx) => {
		if (!runtime.config.features.statusBar) {
			return undefined;
		}
		const baseMessages = event.messages.filter((msg) => !isAgentStatusMessage(msg));
		const now = nowFn();
		const statusText = buildAgentStatusBlock({
			now,
			lastUserInteractionAt,
			cwd: ctx.cwd,
			platform: process.platform,
			shell: detectShellName(),
			dockerSandboxEnabled: runtime.config.features.dockerSandbox,
			knowledgeGit: readKnowledgeGitSummary(runtime.workspace.knowledgeDir),
			toolStats: tracker.getAll(),
			todoSummary: todoStore.formatForContext(),
		});

		return {
			messages: [...baseMessages, createAgentStatusMessage(statusText, now.getTime())],
		};
	});

	return tracker;
}

function detectShellName(): string {
	if (process.platform === "win32") {
		return process.env.ComSpec?.toLowerCase().includes("pwsh") ? "pwsh" : "powershell";
	}
	return process.env.SHELL?.split("/").pop() || "sh";
}

function formatLocalDateTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m${seconds}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

function extractFirstText(blocks: ReadonlyArray<{ type: string; text?: string }>): string | undefined {
	for (const block of blocks) {
		if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
			return block.text.trim();
		}
	}
	return undefined;
}

function truncateSingleLine(text: string, maxLen: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length <= maxLen ? single : `${single.slice(0, maxLen - 3)}...`;
}
