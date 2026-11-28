// Offline cross-trajectory comparative proposer generating minimal-diff candidates routed to 3 carriers:
// 1. knowledge/experience/*.md (actionable experience docs with provenance);
// 2. skills/*/SKILL.md (minimal diff patch or new Skill);
// 3. skills/*/scripts/*.py (deterministic parameterized scripts with pre/post checks & Agent fallback).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FeedbackRecord } from "../commands/feedback.ts";
import type { TraceTurnRecord } from "../observability/trace-store.ts";
import type { HitlAuditRecord } from "../tools/hitl.ts";

export type EvolutionCarrierKind = "experience_doc" | "skill_patch" | "deterministic_script";

export interface EvolutionDiffHunk {
	target: string;
	replacement: string;
}

export interface EvolutionProposal {
	id: string;
	kind: EvolutionCarrierKind;
	title: string;
	targetPath: string;
	rootCause: string;
	expectedImpact: string;
	evidenceIds: string[];
	createdAt: string;
	mode: "create" | "patch";
	content?: string;
	patchHunks?: EvolutionDiffHunk[];
	unifiedDiffPreview: string;
	prePostChecks?: {
		preCheck: string;
		postCheck: string;
		fallbackRule: string;
	};
}

export interface GenerateProposalsInput {
	workspaceRoot: string;
	feedbacks: readonly FeedbackRecord[];
	hitlRecords: readonly HitlAuditRecord[];
	traces: readonly TraceTurnRecord[];
	now?: Date;
}

/**
 * Cross-compare recent unprocessed feedbacks, HITL rejections, and successful traces
 * to synthesize minimal-diff candidate proposals across the 3 external evolution carriers.
 */
export function generateEvolutionProposals(input: GenerateProposalsInput): EvolutionProposal[] {
	const now = input.now ?? new Date();
	const nowIso = now.toISOString();
	const proposals: EvolutionProposal[] = [];

	const pendingFeedbacks = input.feedbacks.filter((fb) => !fb.processedByEvolve);
	const hitlRejections = input.hitlRecords.filter((rec) => rec.approved === false);

	// Group pending feedbacks by errorCategory for cross-trajectory induction.
	const byCategory = new Map<string, FeedbackRecord[]>();
	for (const fb of pendingFeedbacks) {
		const list = byCategory.get(fb.errorCategory) ?? [];
		list.push(fb);
		byCategory.set(fb.errorCategory, list);
	}

	let seq = 0;
	for (const [category, group] of byCategory) {
		seq += 1;
		const evidenceIds = group.map((fb) => `${fb.id} (session=${fb.sessionId})`);
		const descriptions = group.map((fb) => fb.description);
		const combinedDesc = descriptions.join("；");

		// Route 1: Recurring domain workflow issues (>= 2 feedbacks) -> Minimal-diff Skill patch.
		if (group.length >= 2) {
			const domain = inferSkillDomain(combinedDesc);
			const targetRelPath = `skills/${domain.skillName}/SKILL.md`;
			const targetAbsPath = resolve(input.workspaceRoot, targetRelPath);
			const ruleBullet = `- [${nowIso.slice(0, 10)} 复盘固化 | 证据: ${group.map((g) => g.id).join(", ")}] 针对高频问题（${category}）：${summarizeRecurringRule(descriptions)}。`;

			if (existsSync(targetAbsPath)) {
				const existing = readFileSync(targetAbsPath, "utf8");
				const lines = existing.trimEnd().split(/\r?\n/);
				const anchorLine = lines[lines.length - 1] ?? "";
				const replacement = `${anchorLine}\n${ruleBullet}`;
				proposals.push({
					id: `prop-skill-${seq}`,
					kind: "skill_patch",
					title: `为 ${domain.skillName} 追加最小 diff 约束补丁（${group.length} 条同类反馈）`,
					targetPath: targetRelPath,
					rootCause: `在 ${group.length} 条独立轨迹中重复出现 "${category}" 类问题：${combinedDesc}`,
					expectedImpact: `按需加载 ${domain.skillName} 时直接提醒该高频约束，避免同类错误再次发生且不改动原有条款。`,
					evidenceIds,
					createdAt: nowIso,
					mode: "patch",
					patchHunks: [{ target: anchorLine, replacement }],
					unifiedDiffPreview: `--- a/${targetRelPath}\n+++ b/${targetRelPath}\n@@ -${lines.length},1 +${lines.length},2 @@\n ${anchorLine}\n+${ruleBullet}`,
				});
			} else {
				const newSkillContent = [
					"---",
					`name: ${domain.skillName}`,
					`description: ${JSON.stringify(domain.description)}`,
					"---",
					"",
					`# ${domain.skillName}`,
					"",
					"## 复盘沉淀规则",
					"",
					ruleBullet,
					"",
				].join("\n");
				proposals.push({
					id: `prop-skill-${seq}`,
					kind: "skill_patch",
					title: `新建领域 Skill "${domain.skillName}" 固化 ${group.length} 条同类反馈`,
					targetPath: targetRelPath,
					rootCause: `在 ${group.length} 条独立轨迹中重复出现 "${category}" 类问题：${combinedDesc}`,
					expectedImpact: `将分散的纠正经验沉淀为渐进式披露 Skill，保持静态前缀精简。`,
					evidenceIds,
					createdAt: nowIso,
					mode: "create",
					content: newSkillContent,
					unifiedDiffPreview: `--- /dev/null\n+++ b/${targetRelPath}\n${newSkillContent
						.split("\n")
						.map((l) => `+${l}`)
						.join("\n")}`,
				});
			}
			continue;
		}

		// Route 2: Single non-recurring feedback -> Actionable experience doc in knowledge/experience/.
		const slug = `exp-${category.replace(/[^a-z0-9]+/gi, "-")}-${nowIso.slice(0, 10)}`;
		const targetRelPath = `knowledge/experience/${slug}.md`;
		const expContent = [
			"---",
			`title: "行动经验：${category}"`,
			`category: "${category}"`,
			`verified_at: "${nowIso}"`,
			"evidence_ids:",
			...group.map((fb) => `  - "${fb.id}"`),
			"---",
			"",
			`# 行动经验：${category}`,
			"",
			"## 适用条件",
			`- 当执行与以下场景相关的任务时适用：${combinedDesc}`,
			"",
			"## 推荐做法与避坑要点",
			...descriptions.map((d) => `- 明确核查并避免：${d}`),
			"",
			"## 例外与边界",
			"- 若当前轮用户给出更具体的显式指令，以当前轮指令为准；严禁越权修改只读证据区。",
			"",
			"## 证据轨迹",
			...evidenceIds.map((id) => `- ${id}`),
			"",
		].join("\n");

		proposals.push({
			id: `prop-exp-${seq}`,
			kind: "experience_doc",
			title: `沉淀行动经验文档 ${slug}.md`,
			targetPath: targetRelPath,
			rootCause: `轨迹 ${group[0].sessionId} 出现 ${category} 问题：${group[0].description}`,
			expectedImpact: "后续同类任务可通过知识库检索或按需读取避开相同踩坑。",
			evidenceIds,
			createdAt: nowIso,
			mode: "create",
			content: expContent,
			unifiedDiffPreview: `--- /dev/null\n+++ b/${targetRelPath}\n${expContent
				.split("\n")
				.slice(0, 20)
				.map((l) => `+${l}`)
				.join("\n")}`,
		});
	}

	// Route 3: Repeated successful data-processing traces (>= 3) -> Deterministic parameterized validator script.
	const dataToolSuccessTraces = input.traces.filter((tr) =>
		tr.toolCalls.some((tc) => tc.ok && (tc.name === "bash" || tc.name === "generate_html_report")),
	);
	if (dataToolSuccessTraces.length >= 3) {
		const targetRelPath = "skills/local-data-processing/scripts/validate_csv_gate.py";
		const scriptContent = [
			"#!/usr/bin/env python3",
			'"""Deterministic CSV encoding & 2-decimal monetary precision gate generated by /evolve."""',
			"",
			"import csv",
			"import re",
			"import sys",
			"from pathlib import Path",
			"",
			"MONEY_RE = re.compile(r'^-?\\d+\\.\\d{2}$')",
			"",
			"def pre_check(csv_path: Path) -> None:",
			"    if not csv_path.is_file():",
			"        raise RuntimeError(f'PRE_CHECK_FAILED: missing file {csv_path} — fallback to full Agent')",
			"    raw = csv_path.read_bytes()",
			"    if not raw.startswith(b'\\xef\\xbb\\xbf'):",
			"        raise RuntimeError('PRE_CHECK_FAILED: CSV missing UTF-8-BOM header — fallback to full Agent')",
			"",
			"def post_check(csv_path: Path, amount_col: str) -> int:",
			"    with csv_path.open('r', encoding='utf-8-sig', newline='') as f:",
			"        reader = csv.DictReader(f)",
			"        if not reader.fieldnames or amount_col not in reader.fieldnames:",
			"            raise RuntimeError(f'POST_CHECK_FAILED: column {amount_col} missing — fallback to full Agent')",
			"        rows = 0",
			"        for idx, row in enumerate(reader, start=2):",
			"            rows += 1",
			"            val = (row.get(amount_col) or '').strip()",
			"            if val and not MONEY_RE.match(val):",
			"                raise RuntimeError(f'POST_CHECK_FAILED: line {idx} invalid 2-decimal amount: {val}')",
			"    return rows",
			"",
			"if __name__ == '__main__':",
			"    target = Path(sys.argv[1])",
			"    col = sys.argv[2] if len(sys.argv) > 2 else 'amount'",
			"    pre_check(target)",
			"    total = post_check(target, col)",
			"    print(f'OK: validated {total} rows in {target}')",
			"",
		].join("\n");

		proposals.push({
			id: `prop-script-${proposals.length + 1}`,
			kind: "deterministic_script",
			title: "编译高频 CSV UTF-8-BOM 与两位小数确定性守门脚本",
			targetPath: targetRelPath,
			rootCause: `已在 ${dataToolSuccessTraces.length} 个轮次中稳定跑通本地数据处理流程，适合将硬规则编译为确定性守门脚本。`,
			expectedImpact: "在最终交付前用零 token 确定性脚本守门 CSV 编码与金额精度，前置失败时自动回退给完整 Agent。",
			evidenceIds: dataToolSuccessTraces.slice(0, 5).map((t) => `${t.id} (session=${t.sessionId})`),
			createdAt: nowIso,
			mode: "create",
			content: scriptContent,
			prePostChecks: {
				preCheck: "检查目标 CSV 文件存在且携带 UTF-8-BOM 文件头",
				postCheck: "逐行校验指定金额列严格符合两位小数格式且统计总行数",
				fallbackRule: "任一前置/后置检查抛错时立即停止脚本并回退给完整 Agent 重新分析处理",
			},
			unifiedDiffPreview: `--- /dev/null\n+++ b/${targetRelPath}\n+def pre_check(csv_path: Path) -> None: ...\n+def post_check(csv_path: Path, amount_col: str) -> int: ...`,
		});
	}

	// If no feedbacks yet but repeated HITL rejections exist (>= 2), emit an experience doc capturing human boundaries.
	if (proposals.length === 0 && hitlRejections.length >= 2) {
		const targetRelPath = `knowledge/experience/exp-hitl-boundaries-${nowIso.slice(0, 10)}.md`;
		const content = [
			"---",
			'title: "行动经验：人工审批边界习惯"',
			'category: "hitl_boundary"',
			`verified_at: "${nowIso}"`,
			"evidence_ids:",
			...hitlRejections.map((r) => `  - "${r.id}"`),
			"---",
			"",
			"# 行动经验：人工审批边界习惯",
			"",
			"## 用户曾拒绝的操作与原因",
			...hitlRejections.map((r) => `- 操作「${r.actionSummary}」被拒绝，原因：${r.reason ?? "未说明"}（${r.id}）`),
			"",
		].join("\n");
		proposals.push({
			id: "prop-exp-hitl",
			kind: "experience_doc",
			title: "沉淀人工审批拒绝边界经验文档",
			targetPath: targetRelPath,
			rootCause: `近期累计出现 ${hitlRejections.length} 次 HITL 拒绝记录。`,
			expectedImpact: "提前规避用户明确拒绝的高风险操作模式，减少无效打扰。",
			evidenceIds: hitlRejections.map((r) => r.id),
			createdAt: nowIso,
			mode: "create",
			content,
			unifiedDiffPreview: `--- /dev/null\n+++ b/${targetRelPath}\n${content
				.split("\n")
				.slice(0, 12)
				.map((l) => `+${l}`)
				.join("\n")}`,
		});
	}

	return proposals;
}

/** Apply a validated EvolutionProposal cleanly using create or exact minimal-diff patchHunks. */
export function applyEvolutionProposal(proposal: EvolutionProposal, workspaceRoot: string): string {
	const absPath = resolve(workspaceRoot, proposal.targetPath);
	mkdirSync(dirname(absPath), { recursive: true });

	if (proposal.mode === "create") {
		if (proposal.content === undefined) {
			throw new Error(`Proposal ${proposal.id} (mode=create) is missing content.`);
		}
		writeFileSync(absPath, proposal.content, "utf8");
		return absPath;
	}

	if (!existsSync(absPath)) {
		throw new Error(`Proposal ${proposal.id} (mode=patch) target file does not exist: ${absPath}`);
	}
	if (!proposal.patchHunks || proposal.patchHunks.length === 0) {
		throw new Error(`Proposal ${proposal.id} (mode=patch) has no patchHunks.`);
	}

	let content = readFileSync(absPath, "utf8");
	for (const hunk of proposal.patchHunks) {
		if (!content.includes(hunk.target)) {
			throw new Error(`Minimal diff hunk target not found in ${proposal.targetPath}: ${hunk.target.slice(0, 80)}`);
		}
		content = content.replace(hunk.target, hunk.replacement);
	}
	writeFileSync(absPath, content, "utf8");
	return absPath;
}

function inferSkillDomain(combinedDesc: string): { skillName: string; description: string } {
	if (/(?:笔记|markdown|frontmatter|双链|pdf|页码|归档)/i.test(combinedDesc)) {
		return {
			skillName: "note-organization",
			description: "个人 Markdown 笔记整理、YAML frontmatter 与 PDF 页码出处规范（含复盘补丁）。",
		};
	}
	return {
		skillName: "local-data-processing",
		description:
			"本地 CSV/Excel/JSON 数据清洗、UTF-8-BOM 编码、两位小数精度校验与交互式 HTML 报告交付（含复盘补丁）。",
	};
}

function summarizeRecurringRule(descriptions: readonly string[]): string {
	const unique = [...new Set(descriptions.map((d) => d.trim()).filter(Boolean))];
	return unique.slice(0, 3).join("；");
}
