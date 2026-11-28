// Layer 1 execution security: path normalization, traversal defense, and strict 3-zone directory boundaries
// (read_only evidence, controlled_rw knowledge/task dirs, unauthorized host paths denied by default).

import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantRuntime } from "../extension.ts";
import type { WorkspacePaths } from "../workspace.ts";

export type PathZone =
	| { kind: "read_only"; zoneName: string; resolvedPath: string }
	| { kind: "controlled_rw"; scope: "knowledge" | "notes" | "artifacts" | "skills" | "task_dir"; resolvedPath: string }
	| { kind: "unauthorized"; reason: string; resolvedPath: string };

export interface PathBoundaryPolicy {
	readOnlyDirs: Array<{ name: string; path: string }>;
	controlledRwDirs: Array<{ scope: "knowledge" | "notes" | "artifacts" | "skills" | "task_dir"; path: string }>;
}

export type PathAccessDecision = { allowed: true; zone: PathZone } | { allowed: false; zone: PathZone; reason: string };

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "analyze_visual"]);
const MUTATION_TOOLS = new Set(["write", "edit"]);

/** Build the default 3-zone path boundary policy from WorkspacePaths and optional authorized task directories. */
export function createPathBoundaryPolicy(
	workspace: WorkspacePaths,
	authorizedTaskDirs: readonly string[] = [],
): PathBoundaryPolicy {
	return {
		readOnlyDirs: [
			{ name: "evidence/raw_pdfs", path: resolve(workspace.rawPdfsDir) },
			{ name: "evidence/sessions", path: resolve(workspace.sessionsDir) },
			{ name: "evidence/traces", path: resolve(workspace.tracesDir) },
			{ name: "evidence/feedback", path: resolve(workspace.feedbackDir) },
		],
		controlledRwDirs: [
			{ scope: "knowledge", path: resolve(workspace.knowledgeDir) },
			{ scope: "notes", path: resolve(workspace.notesDir) },
			{ scope: "artifacts", path: resolve(workspace.artifactsDir) },
			{ scope: "skills", path: resolve(workspace.skillsDir) },
			...authorizedTaskDirs.map((dir) => ({ scope: "task_dir" as const, path: resolve(dir) })),
		],
	};
}

/** Normalize a raw path relative to cwd and classify it into read_only, controlled_rw, or unauthorized. */
export function classifyPath(rawPath: string, cwd: string, policy: PathBoundaryPolicy): PathZone {
	if (rawPath.includes("\0")) {
		return { kind: "unauthorized", reason: "路径包含非法空字节 (\\0)", resolvedPath: rawPath };
	}

	const trimmed = rawPath.trim();
	const resolvedPath = normalize(isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed));

	// Read-only evidence zones take strict precedence even if nested under workspace root.
	for (const ro of policy.readOnlyDirs) {
		if (isPathWithin(resolvedPath, ro.path)) {
			return { kind: "read_only", zoneName: ro.name, resolvedPath };
		}
	}

	for (const rw of policy.controlledRwDirs) {
		if (isPathWithin(resolvedPath, rw.path)) {
			return { kind: "controlled_rw", scope: rw.scope, resolvedPath };
		}
	}

	return {
		kind: "unauthorized",
		reason: `目标路径 "${resolvedPath}" 不在已授权工作区或任务目录边界内（默认拒绝宿主机未授权区域）`,
		resolvedPath,
	};
}

/** Evaluate whether a specific tool is permitted to access rawPath under the 3-zone boundary policy. */
export function checkFileToolAccess(
	toolName: string,
	rawPath: string,
	cwd: string,
	policy: PathBoundaryPolicy,
): PathAccessDecision {
	const zone = classifyPath(rawPath, cwd, policy);

	if (MUTATION_TOOLS.has(toolName)) {
		if (zone.kind === "read_only") {
			return {
				allowed: false,
				zone,
				reason: `层 1 安全拦截：禁止工具 "${toolName}" 修改只读证据区 "${zone.zoneName}"（${zone.resolvedPath}）。`,
			};
		}
		if (zone.kind === "unauthorized") {
			return {
				allowed: false,
				zone,
				reason: `层 1 安全拦截：禁止工具 "${toolName}" 写入未授权宿主机路径（${zone.reason}）。`,
			};
		}
		return { allowed: true, zone };
	}

	if (READ_TOOLS.has(toolName)) {
		if (zone.kind === "unauthorized") {
			return {
				allowed: false,
				zone,
				reason: `层 1 安全拦截：禁止工具 "${toolName}" 读取未授权路径（${zone.reason}）。`,
			};
		}
		return { allowed: true, zone };
	}

	return { allowed: true, zone };
}

/** Extract the target path argument from a file/visual tool call input, if any. */
export function extractToolTargetPath(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "analyze_visual" && typeof input.file_path === "string") {
		return input.file_path;
	}
	if (typeof input.path === "string" && input.path.trim().length > 0) {
		return input.path;
	}
	// For ls/find/grep with omitted path, default to cwd (".").
	if (toolName === "ls" || toolName === "find" || toolName === "grep") {
		return ".";
	}
	return undefined;
}

/** Attach Layer 1 path boundary enforcement onto pi's tool_call hook. */
export function attachPathGuard(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	authorizedTaskDirs: readonly string[] = [],
): PathBoundaryPolicy {
	const policy = createPathBoundaryPolicy(runtime.workspace, authorizedTaskDirs);

	pi.on("tool_call", (event, ctx) => {
		if (!READ_TOOLS.has(event.toolName) && !MUTATION_TOOLS.has(event.toolName)) {
			return undefined;
		}
		const targetPath = extractToolTargetPath(event.toolName, event.input as Record<string, unknown>);
		if (!targetPath) return undefined;

		const decision = checkFileToolAccess(event.toolName, targetPath, ctx.cwd, policy);
		if (!decision.allowed) {
			return {
				block: true,
				reason: decision.reason,
			};
		}
		return undefined;
	});

	return policy;
}

/** Windows-safe (case-insensitive) containment check preventing ../ prefix bypasses. */
export function isPathWithin(targetPath: string, parentDir: string): boolean {
	const normTarget = process.platform === "win32" ? resolve(targetPath).toLowerCase() : resolve(targetPath);
	const normParent = process.platform === "win32" ? resolve(parentDir).toLowerCase() : resolve(parentDir);
	const rel = relative(normParent, normTarget);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
