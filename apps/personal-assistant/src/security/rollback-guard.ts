// Layer 2 execution security: pre-write reversible snapshots + /rollback command,
// and deterministic post-write auto-verification (Python, TS/JS, Markdown YAML frontmatter & wikilinks).

import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { AssistantRuntime } from "../extension.ts";
import { checkFileToolAccess, type PathBoundaryPolicy } from "./path-guard.ts";

export interface BackupSnapshotRecord {
	id: string;
	timestamp: string;
	sessionId: string;
	originalPath: string;
	backupPath: string | null;
	existedBefore: boolean;
}

export interface RollbackResult {
	ok: boolean;
	snapshotId?: string;
	restoredPath?: string;
	action?: "restored" | "deleted_new_file";
	message: string;
}

export interface VerificationIssue {
	line?: number;
	severity: "error" | "warning";
	message: string;
}

export interface PostWriteVerificationResult {
	filePath: string;
	kind: "markdown" | "python" | "typescript_js" | "skipped";
	ok: boolean;
	issues: VerificationIssue[];
}

export interface RollbackGuardOptions {
	policy?: PathBoundaryPolicy;
	/** Optional custom Python syntax checker (injectable for Docker/tests). */
	pythonSyntaxChecker?: (filePath: string) => VerificationIssue[];
}

/** Pre-write reversible backup store under .pi/backups/<session>/ supporting one-click /rollback. */
export class RollbackBackupStore {
	private readonly backupsRootDir: string;
	private seq = 0;

	constructor(backupsRootDir: string) {
		this.backupsRootDir = backupsRootDir;
	}

	/** Capture a pre-write backup snapshot for targetPath before write/edit executes. */
	captureBeforeWrite(sessionId: string, targetPath: string, now = new Date()): BackupSnapshotRecord {
		const resolvedTarget = resolve(targetPath);
		const safeSession = sanitizeSegment(sessionId);
		const sessionDir = join(this.backupsRootDir, safeSession);
		mkdirSync(sessionDir, { recursive: true });

		this.seq += 1;
		const tsTag = now.toISOString().replace(/[:.]/g, "-");
		const id = `snap-${tsTag}-${this.seq}`;
		const existedBefore = existsSync(resolvedTarget);
		let backupPath: string | null = null;

		if (existedBefore) {
			const snapDir = join(sessionDir, id);
			mkdirSync(snapDir, { recursive: true });
			backupPath = join(snapDir, basename(resolvedTarget));
			copyFileSync(resolvedTarget, backupPath);
		}

		const record: BackupSnapshotRecord = {
			id,
			timestamp: now.toISOString(),
			sessionId: safeSession,
			originalPath: resolvedTarget,
			backupPath,
			existedBefore,
		};

		appendFileSync(join(sessionDir, "manifest.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
		return record;
	}

	/** List recorded snapshots for a session in reverse chronological order (newest first). */
	listSnapshots(sessionId: string): BackupSnapshotRecord[] {
		const manifestPath = join(this.backupsRootDir, sanitizeSegment(sessionId), "manifest.jsonl");
		if (!existsSync(manifestPath)) return [];
		const lines = readFileSync(manifestPath, "utf8").split(/\r?\n/);
		const records: BackupSnapshotRecord[] = [];
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				records.push(JSON.parse(trimmed) as BackupSnapshotRecord);
			} catch {
				// Ignore malformed entries.
			}
		}
		return records.reverse();
	}

	/** Restore the latest snapshot (or a specific snapshotId) back to its original path. */
	rollback(sessionId: string, snapshotId?: string): RollbackResult {
		const snapshots = this.listSnapshots(sessionId);
		if (snapshots.length === 0) {
			return { ok: false, message: "当前会话暂无可回滚的写前快照。" };
		}

		const target = snapshotId && snapshotId !== "last" ? snapshots.find((s) => s.id === snapshotId) : snapshots[0];

		if (!target) {
			return { ok: false, message: `未找到快照 ID "${snapshotId}"。` };
		}

		if (target.existedBefore) {
			if (!target.backupPath || !existsSync(target.backupPath)) {
				return { ok: false, message: `快照备份文件丢失：${target.backupPath ?? "(none)"}` };
			}
			mkdirSync(dirname(target.originalPath), { recursive: true });
			copyFileSync(target.backupPath, target.originalPath);
			return {
				ok: true,
				snapshotId: target.id,
				restoredPath: target.originalPath,
				action: "restored",
				message: `已从快照 ${target.id} 完整恢复文件：${target.originalPath}`,
			};
		}

		if (existsSync(target.originalPath)) {
			rmSync(target.originalPath, { force: true });
		}
		return {
			ok: true,
			snapshotId: target.id,
			restoredPath: target.originalPath,
			action: "deleted_new_file",
			message: `已按快照 ${target.id} 回滚并删除新建文件：${target.originalPath}`,
		};
	}
}

/**
 * Deterministic post-write verification loop for Markdown (.md), Python (.py), and JS/TS files.
 * Structured errors with line numbers are attached directly to tool results for immediate model self-repair.
 */
export function verifyWrittenFile(
	filePath: string,
	options: { notesDir?: string; pythonSyntaxChecker?: (filePath: string) => VerificationIssue[] } = {},
): PostWriteVerificationResult {
	const resolved = resolve(filePath);
	if (!existsSync(resolved)) {
		return { filePath: resolved, kind: "skipped", ok: true, issues: [] };
	}

	const ext = extname(resolved).toLowerCase();
	if (ext === ".md" || ext === ".markdown") {
		const issues = verifyMarkdownFile(resolved, options.notesDir);
		return {
			filePath: resolved,
			kind: "markdown",
			ok: !issues.some((i) => i.severity === "error"),
			issues,
		};
	}

	if (ext === ".py") {
		const issues = options.pythonSyntaxChecker ? options.pythonSyntaxChecker(resolved) : verifyPythonSyntax(resolved);
		return {
			filePath: resolved,
			kind: "python",
			ok: !issues.some((i) => i.severity === "error"),
			issues,
		};
	}

	if (ext === ".js" || ext === ".mjs" || ext === ".cjs" || ext === ".ts" || ext === ".mts") {
		const issues = verifyJsTsSyntax(resolved, ext);
		return {
			filePath: resolved,
			kind: "typescript_js",
			ok: !issues.some((i) => i.severity === "error"),
			issues,
		};
	}

	return { filePath: resolved, kind: "skipped", ok: true, issues: [] };
}

/** Verify Markdown YAML frontmatter syntax (with line numbers) and [[wikilink]] targets. */
export function verifyMarkdownFile(filePath: string, notesDir?: string): VerificationIssue[] {
	const issues: VerificationIssue[] = [];
	const content = readFileSync(filePath, "utf8");

	if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
		const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		if (!fmMatch) {
			issues.push({
				line: 1,
				severity: "error",
				message: "YAML frontmatter 缺少结束分隔符 `---`。",
			});
		} else {
			try {
				const parsed: unknown = parseYaml(fmMatch[1]);
				if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
					issues.push({
						line: 2,
						severity: "error",
						message: "YAML frontmatter 必须是键值对对象。",
					});
				}
			} catch (error) {
				const errObj = error as { linePos?: Array<{ line?: number }>; message?: string };
				const rawLine = errObj.linePos?.[0]?.line;
				issues.push({
					line: rawLine !== undefined ? rawLine + 1 : 2,
					severity: "error",
					message: `YAML frontmatter 语法错误：${errObj.message ?? String(error)}`,
				});
			}
		}
	}

	// Validate [[wikilinks]] against known notes in notesDir when provided.
	if (notesDir && existsSync(notesDir)) {
		const existingNotes = collectNoteTargetSet(notesDir);
		const lines = content.split(/\r?\n/);
		let inCodeFence = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (/^\s*(?:```|~~~)/.test(line)) {
				inCodeFence = !inCodeFence;
				continue;
			}
			if (inCodeFence) continue;
			for (const match of line.matchAll(/\[\[([^[\]|#]+)(?:#[^[\]|]+)?(?:\|[^[\]]+)?\]\]/g)) {
				const target = match[1]?.trim();
				if (!target) continue;
				const normalized = target.replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
				if (!existingNotes.has(normalized)) {
					issues.push({
						line: i + 1,
						severity: "warning",
						message: `未找到双向链接目标 [[${target}]] 对应的笔记文件，请核对拼写或补充目标笔记。`,
					});
				}
			}
		}
	}

	return issues;
}

/** Format post-write verification issues as structured XML appended to tool results. */
export function formatVerificationFeedback(result: PostWriteVerificationResult): string {
	if (result.issues.length === 0) return "";
	const status = result.ok ? "warning" : "failed";
	const lines = [
		`<post_write_verification status="${status}" kind="${result.kind}" file="${result.filePath.replace(/\\/g, "/")}">`,
	];
	for (const issue of result.issues) {
		const linePart = issue.line !== undefined ? `L${issue.line} ` : "";
		lines.push(`- [${issue.severity}] ${linePart}${issue.message}`);
	}
	lines.push("</post_write_verification>");
	return lines.join("\n");
}

/** Attach Layer 2 pre-write snapshots, /rollback command, and post-write auto-verification onto pi. */
export function attachRollbackGuard(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options: RollbackGuardOptions = {},
): RollbackBackupStore {
	const backupStore = new RollbackBackupStore(runtime.workspace.backupsDir);

	// Capture reversible pre-write snapshot before write/edit runs.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}
		const input = event.input as Record<string, unknown>;
		if (typeof input.path !== "string" || input.path.trim().length === 0) {
			return undefined;
		}
		if (options.policy) {
			const access = checkFileToolAccess(event.toolName, input.path, ctx.cwd, options.policy);
			if (!access.allowed) return undefined;
		}

		const targetPath = resolve(ctx.cwd, input.path);
		backupStore.captureBeforeWrite(ctx.sessionManager.getSessionId(), targetPath);
		return undefined;
	});

	// Run deterministic post-write verification and attach structured diagnostics to tool result.
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return undefined;
		if (event.toolName !== "write" && event.toolName !== "edit") {
			return undefined;
		}
		const rawPath = event.input.path;
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
			return undefined;
		}

		const targetPath = resolve(ctx.cwd, rawPath);
		const verification = verifyWrittenFile(targetPath, {
			notesDir: runtime.workspace.notesDir,
			pythonSyntaxChecker: options.pythonSyntaxChecker,
		});
		if (verification.issues.length === 0) {
			return undefined;
		}

		const feedback = formatVerificationFeedback(verification);
		return {
			content: [...event.content, { type: "text", text: `\n${feedback}` }],
			isError: !verification.ok ? true : event.isError,
		};
	});

	pi.registerCommand("rollback", {
		description: "一键回滚最近一次（或指定快照 ID 的）本地文件修改（用法: /rollback [list | <snapshot-id>]）",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			const arg = args.trim();

			if (arg === "list") {
				const list = backupStore.listSnapshots(sessionId);
				const text =
					list.length === 0
						? "当前会话暂无写前快照记录。"
						: list
								.slice(0, 15)
								.map((s) => `- ${s.id} (${s.existedBefore ? "modify" : "create"}) ${s.originalPath}`)
								.join("\n");
				notifyOrLog(ctx, text, "info");
				return;
			}

			const result = backupStore.rollback(sessionId, arg || undefined);
			notifyOrLog(ctx, result.message, result.ok ? "info" : "warning");
		},
	});

	return backupStore;
}

function verifyPythonSyntax(filePath: string): VerificationIssue[] {
	const pythonBin = process.platform === "win32" ? "python" : "python3";
	try {
		execFileSync(pythonBin, ["-m", "py_compile", filePath], {
			encoding: "utf8",
			timeout: 15_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return [];
	} catch (error) {
		const err = error as { code?: string; stderr?: string; message?: string };
		if (err.code === "ENOENT") {
			return [];
		}
		const stderr = (err.stderr ?? err.message ?? "Python syntax error").trim();
		const lineMatch = stderr.match(/line\s+(\d+)/i);
		return [
			{
				line: lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined,
				severity: "error",
				message: `Python 语法校验失败：${stderr.split(/\r?\n/).slice(-3).join(" | ")}`,
			},
		];
	}
}

function verifyJsTsSyntax(filePath: string, ext: string): VerificationIssue[] {
	// Node 22 supports --check on JS/MJS/CJS and --experimental-strip-types --check on erasable TS.
	const args =
		ext === ".ts" || ext === ".mts"
			? ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", "--check", filePath]
			: ["--check", filePath];

	try {
		execFileSync(process.execPath, args, {
			encoding: "utf8",
			timeout: 15_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return [];
	} catch (error) {
		const err = error as { stderr?: string; message?: string };
		const stderr = (err.stderr ?? err.message ?? "Syntax error").trim();
		const lineMatch = stderr.match(/:(\d+)(?::\d+)?/);
		return [
			{
				line: lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined,
				severity: "error",
				message: `JS/TS 语法校验失败：${stderr.split(/\r?\n/).slice(0, 4).join(" | ")}`,
			},
		];
	}
}

function collectNoteTargetSet(notesDir: string): Set<string> {
	const set = new Set<string>();
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
			} else if (entry.isFile() && /\.(?:md|markdown)$/i.test(entry.name)) {
				const stem = entry.name.replace(/\.(?:md|markdown)$/i, "").toLowerCase();
				set.add(stem);
				if (prefix) {
					set.add(`${prefix}/${stem}`.toLowerCase());
				}
			}
		}
	};
	walk(notesDir, "");
	return set;
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

function notifyOrLog(
	ctx: { hasUI: boolean; ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
	message: string,
	type: "info" | "warning" | "error",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		console.log(message);
	}
}
