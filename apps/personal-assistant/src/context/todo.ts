// Dedicated todo tool, externalized session persistence, and real-time TUI TODO widget.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	title: string;
	status: TodoStatus;
	updatedAt: string;
}

export interface TodoRewriteInputItem {
	id?: string;
	title: string;
	status?: TodoStatus;
}

const VALID_TODO_STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed", "cancelled"];
const TODO_WIDGET_KEY = "assistant-todos";
const TODO_ENTRY_TYPE = "assistant-todo-state";

const TodoItemInputSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "任务 ID，省略时自动分配 t1/t2/..." })),
	title: Type.String({ description: "简短明确的任务描述" }),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
			Type.Literal("cancelled"),
		]),
	),
});

const TodoToolParams = Type.Object({
	action: Type.Union([Type.Literal("rewrite"), Type.Literal("update_status")], {
		description: "rewrite 整体重建任务列表；update_status 更新单条任务状态",
	}),
	items: Type.Optional(Type.Array(TodoItemInputSchema, { description: "action=rewrite 时必填的完整任务列表" })),
	id: Type.Optional(Type.String({ description: "action=update_status 时必填的目标任务 ID" })),
	status: Type.Optional(
		Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("completed"),
			Type.Literal("cancelled"),
		]),
	),
});

/** Externalized TODO store persisted per session so compaction never rewrites or drops task progress. */
export class TodoStore {
	private readonly artifactsDir: string;
	private sessionId: string;
	private items: TodoItem[];

	constructor(artifactsDir: string, sessionId = "default") {
		this.artifactsDir = artifactsDir;
		this.sessionId = sanitizeSegment(sessionId);
		this.items = [];
	}

	/** Switch active session and load persisted TODO items if present. */
	loadSession(sessionId: string): TodoItem[] {
		this.sessionId = sanitizeSegment(sessionId);
		const filePath = this.getStateFilePath();
		if (!existsSync(filePath)) {
			this.items = [];
			return this.getItems();
		}
		try {
			const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
			if (Array.isArray(parsed)) {
				this.items = parsed.filter(isValidTodoItem);
			} else {
				this.items = [];
			}
		} catch {
			this.items = [];
		}
		return this.getItems();
	}

	/** Return a shallow copy of current TODO items. */
	getItems(): TodoItem[] {
		return this.items.map((item) => ({ ...item }));
	}

	/** Replace the full TODO list and persist to disk. */
	rewrite(inputItems: readonly TodoRewriteInputItem[], now = new Date()): TodoItem[] {
		const timestamp = now.toISOString();
		const usedIds = new Set<string>();
		const next: TodoItem[] = [];

		for (let i = 0; i < inputItems.length; i++) {
			const raw = inputItems[i];
			const title = raw.title.trim();
			if (title.length === 0) continue;
			let id = raw.id?.trim() || `t${i + 1}`;
			while (usedIds.has(id)) {
				id = `${id}_${i + 1}`;
			}
			usedIds.add(id);
			const status: TodoStatus = raw.status && isTodoStatus(raw.status) ? raw.status : "pending";
			next.push({ id, title, status, updatedAt: timestamp });
		}

		this.items = next;
		this.persist();
		return this.getItems();
	}

	/** Update status of a single TODO item by ID. Returns updated item or undefined if not found. */
	updateStatus(id: string, status: TodoStatus, now = new Date()): TodoItem | undefined {
		const target = this.items.find((item) => item.id === id);
		if (!target) return undefined;
		target.status = status;
		target.updatedAt = now.toISOString();
		this.persist();
		return { ...target };
	}

	/** Format compact lines for pi's TUI widget panel. */
	formatWidgetLines(): string[] | undefined {
		if (this.items.length === 0) return undefined;
		const completed = this.items.filter((item) => item.status === "completed").length;
		const header = `TODO (${completed}/${this.items.length})`;
		const rows = this.items.map((item) => `  ${statusIcon(item.status)} [${item.id}] ${item.title}`);
		return [header, ...rows];
	}

	/** Format structured lines for <agent_status> and L3 compaction externalized state. */
	formatForContext(): string {
		if (this.items.length === 0) return "(暂无 TODO 任务)";
		return this.items.map((item) => `- [${item.status}] (${item.id}) ${item.title}`).join("\n");
	}

	/** Path of the externalized JSON state file for the active session. */
	getStateFilePath(): string {
		return join(this.artifactsDir, this.sessionId, "todos.json");
	}

	private persist(): void {
		const filePath = this.getStateFilePath();
		mkdirSync(join(this.artifactsDir, this.sessionId), { recursive: true });
		writeFileSync(filePath, JSON.stringify(this.items, null, 2), "utf8");
	}
}

/** Register the todo tool and keep the TUI TODO widget synchronized across session lifecycle. */
export function attachTodoModule(pi: ExtensionAPI, runtime: AssistantRuntime): TodoStore {
	const store = new TodoStore(runtime.workspace.artifactsDir);

	const syncWidget = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(TODO_WIDGET_KEY, store.formatWidgetLines(), { placement: "aboveEditor" });
	};

	pi.on("session_start", (_event, ctx) => {
		store.loadSession(ctx.sessionManager.getSessionId());
		syncWidget(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "TODO",
		description:
			"维护当前多步任务的可视化进度清单（支持 rewrite 重建列表与 update_status 更新单条状态），并在终端 TUI 实时向用户展示。",
		promptSnippet: "维护多步任务的显式 TODO 清单并实时展示给用户",
		parameters: TodoToolParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (store.getItems().length === 0) {
				store.loadSession(sessionId);
			}

			if (params.action === "rewrite") {
				const items = params.items ?? [];
				const updated = store.rewrite(items);
				pi.appendEntry(TODO_ENTRY_TYPE, { items: updated });
				syncWidget(ctx);
				return {
					content: [
						{ type: "text", text: `已更新 TODO 清单（共 ${updated.length} 项）：\n${store.formatForContext()}` },
					],
					details: { action: "rewrite", items: updated },
				};
			}

			const targetId = params.id?.trim();
			const targetStatus = params.status;
			if (!targetId || !targetStatus) {
				return {
					content: [{ type: "text", text: "错误：action=update_status 时必须同时提供 id 与 status。" }],
					details: { action: "update_status", error: "missing_params" },
				};
			}

			const item = store.updateStatus(targetId, targetStatus);
			if (!item) {
				return {
					content: [{ type: "text", text: `错误：未找到 ID 为 "${targetId}" 的 TODO 任务。` }],
					details: { action: "update_status", error: "not_found", id: targetId },
				};
			}

			pi.appendEntry(TODO_ENTRY_TYPE, { items: store.getItems() });
			syncWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text: `已将任务 [${item.id}] "${item.title}" 状态更新为 ${item.status}。\n当前清单：\n${store.formatForContext()}`,
					},
				],
				details: { action: "update_status", item, items: store.getItems() },
			};
		},
	});

	return store;
}

function statusIcon(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[>]";
		case "cancelled":
			return "[-]";
		case "pending":
			return "[ ]";
	}
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && VALID_TODO_STATUSES.includes(value as TodoStatus);
}

function isValidTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.title === "string" &&
		isTodoStatus(record.status) &&
		typeof record.updatedAt === "string"
	);
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}
