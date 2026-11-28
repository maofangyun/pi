// Immutable Trust Root hard validator for Chapter 9 offline evolution.
// Deterministically blocks any proposal attempting to modify security guards, golden evals,
// regression assertions, trust-root itself, read-only evidence, or commit directly to main branch.

import { isAbsolute, normalize, relative, resolve } from "node:path";
import type { EvolutionProposal } from "./proposer.ts";

export interface TrustRootCheckContext {
	workspaceRoot: string;
	targetBranch: string;
	existingFileContent?: string;
}

export interface TrustRootValidationResult {
	ok: boolean;
	violations: string[];
}

const IMMUTABLE_TRUST_ROOT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
	{ pattern: /(?:^|\/)src\/security(?:\/|$)/i, label: "src/security/（四层安全护栏与 Sidecar 规则）" },
	{ pattern: /(?:^|\/)src\/evolve\/trust-root/i, label: "src/evolve/trust-root（不可自改可信根校验器）" },
	{ pattern: /(?:^|\/)evals\/golden(?:\/|$)/i, label: "evals/golden/（第 7 章黄金评估集）" },
	{ pattern: /(?:^|\/)evals\/(?:agent|rag)(?:\/|$)/i, label: "evals/（评估断言与评判脚本）" },
	{ pattern: /(?:^|\/)test(?:\/|$)/i, label: "test/（回归断言与契约测试）" },
	{ pattern: /(?:^|\/)evidence\/(?:raw_pdfs|sessions)(?:\/|$)/i, label: "evidence/（只读原始证据层）" },
	{ pattern: /(?:^|\/)packages(?:\/|$)/i, label: "packages/（pi 核心源码零侵入红线）" },
];

const ALLOWED_EVOLUTION_PATH_PATTERNS: ReadonlyArray<{ kind: EvolutionProposal["kind"]; pattern: RegExp }> = [
	{ kind: "experience_doc", pattern: /^knowledge\/experience\/[a-z0-9._-]+\.md$/i },
	{ kind: "skill_patch", pattern: /^skills\/[a-z0-9-]+\/SKILL\.md$/i },
	{ kind: "deterministic_script", pattern: /^skills\/[a-z0-9-]+\/scripts\/[a-z0-9._-]+\.(?:py|ts|mjs|sh)$/i },
];

const PROTECTED_BRANCHES = new Set(["main", "master"]);
const MAX_MINIMAL_DIFF_REWRITE_RATIO = 0.7;

/**
 * Validate an evolution proposal against the immutable trust root and safety red lines.
 * Returns ok=false with explicit violation reasons if any invariant is breached.
 */
export function validateEvolutionProposal(
	proposal: EvolutionProposal,
	context: TrustRootCheckContext,
): TrustRootValidationResult {
	const violations: string[] = [];

	// 1. Target branch must never be main/master directly.
	const branch = context.targetBranch.trim();
	if (!branch || PROTECTED_BRANCHES.has(branch.toLowerCase())) {
		violations.push(
			`禁止直接在受保护主分支 "${branch || "(empty)"}" 提交进化提案，必须在独立工作分支（evolve/*）操作。`,
		);
	}

	// 2. Path normalization & traversal escape check.
	const rawRel = proposal.targetPath.replace(/\\/g, "/").trim();
	if (rawRel.includes("\0") || rawRel.length === 0) {
		violations.push("提案目标路径为空或包含非法空字节。");
	}

	const resolvedAbs = resolve(context.workspaceRoot, rawRel);
	const relFromWorkspace = relative(resolve(context.workspaceRoot), resolvedAbs).replace(/\\/g, "/");
	const normalizedCheckTarget = normalize(rawRel).replace(/\\/g, "/");

	// 3. Reject any path touching immutable trust-root zones (checked against raw, normalized, AND resolved paths!).
	for (const candidate of [rawRel, normalizedCheckTarget, relFromWorkspace, resolvedAbs.replace(/\\/g, "/")]) {
		for (const rule of IMMUTABLE_TRUST_ROOT_PATTERNS) {
			if (rule.pattern.test(candidate)) {
				violations.push(`可信根拦截：进化模块严禁修改 ${rule.label}（目标路径: ${proposal.targetPath}）。`);
				break;
			}
		}
	}

	if (relFromWorkspace.startsWith("..") || isAbsolute(relFromWorkspace)) {
		violations.push(`可信根拦截：提案路径 "${proposal.targetPath}" 逃逸出工作区根目录。`);
	}

	// 4. Target path must match one of the 3 allowed external evolution carriers.
	const carrierRule = ALLOWED_EVOLUTION_PATH_PATTERNS.find((r) => r.kind === proposal.kind);
	if (!carrierRule || !carrierRule.pattern.test(relFromWorkspace)) {
		violations.push(
			`载体路径不合规：类型 "${proposal.kind}" 仅允许写入指定进化载体目录，拒绝路径 "${relFromWorkspace}"。`,
		);
	}

	// 5. Evidence chain mandatory (must trace back to real trajectory/feedback/HITL evidence).
	if (!Array.isArray(proposal.evidenceIds) || proposal.evidenceIds.length === 0) {
		violations.push("进化提案必须附带至少一条证据轨迹/反馈 ID（evidenceIds）。");
	}

	// 6. Block unreviewed external web/document content injection into instructions.
	const combinedText = [proposal.content ?? "", ...(proposal.patchHunks ?? []).map((h) => h.replacement)].join("\n");
	if (/<external_content\b/i.test(combinedText)) {
		violations.push("安全红线拦截：检测到未审脱敏的 <external_content> 外部原文试图直接写入进化指令/Skill。");
	}

	// 7. Enforce minimal-diff discipline when patching an existing Skill (never wholesale rewrite).
	if (proposal.kind === "skill_patch" && proposal.mode === "patch") {
		if (!proposal.patchHunks || proposal.patchHunks.length === 0) {
			violations.push("Skill 补丁模式（mode=patch）必须提供明确的最小 diff patchHunks，严禁空补丁或整篇覆写。");
		} else if (context.existingFileContent && context.existingFileContent.length > 0) {
			const replacedChars = proposal.patchHunks.reduce((sum, h) => sum + h.target.length, 0);
			const ratio = replacedChars / context.existingFileContent.length;
			if (ratio > MAX_MINIMAL_DIFF_REWRITE_RATIO) {
				violations.push(
					`违背最小 diff 原则：本次 Skill 补丁替换了原文件 ${(ratio * 100).toFixed(0)}% 内容（上限 ${MAX_MINIMAL_DIFF_REWRITE_RATIO * 100}%），存在流失历史细节风险。`,
				);
			}
		}
	}

	// 8. Deterministic scripts must specify pre-check, post-check, and fallback-to-Agent rules.
	if (proposal.kind === "deterministic_script") {
		if (
			!proposal.prePostChecks?.preCheck?.trim() ||
			!proposal.prePostChecks?.postCheck?.trim() ||
			!proposal.prePostChecks?.fallbackRule?.trim()
		) {
			violations.push(
				"确定性脚本提案必须包含明确的前置检查（preCheck）、后置断言（postCheck）与失败回退 Agent 规则（fallbackRule）。",
			);
		}
	}

	return {
		ok: violations.length === 0,
		violations: [...new Set(violations)],
	};
}
