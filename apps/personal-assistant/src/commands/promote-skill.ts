// /promote-skill command: crystallize a verified data-processing script into a parameterized script + SKILL.md
// inside workspace skills/ after explicit human confirmation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantRuntime } from "../extension.ts";
import type { HitlAuditStore } from "../tools/hitl.ts";

export interface PromoteSkillDraft {
	skillName: string;
	description: string;
	scriptFileName: string;
	scriptContent: string;
	skillMarkdown: string;
	targetSkillDir: string;
	targetSkillMdPath: string;
	targetScriptPath: string;
}

export interface PromoteSkillInput {
	skillName: string;
	description: string;
	sourceScriptPath: string;
	skillsRootDir: string;
	parametersHint?: string[];
}

const VALID_SKILL_NAME_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Normalize arbitrary input text into a valid Agent Skills directory/name slug. */
export function normalizeSkillName(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

/** Build a parameterized script + Agent Skills-compliant SKILL.md draft with pre/post check template. */
export function buildPromoteSkillDraft(input: PromoteSkillInput): PromoteSkillDraft {
	const skillName = normalizeSkillName(input.skillName);
	if (!VALID_SKILL_NAME_REGEX.test(skillName)) {
		throw new Error(
			`Invalid skill name "${input.skillName}". Use lowercase letters, digits, and hyphens (2-63 chars).`,
		);
	}

	const resolvedSource = resolve(input.sourceScriptPath);
	if (!existsSync(resolvedSource)) {
		throw new Error(`Source script not found: ${resolvedSource}`);
	}

	const originalScript = readFileSync(resolvedSource, "utf8");
	const ext = extname(resolvedSource).toLowerCase() || ".py";
	const scriptFileName = basename(resolvedSource);
	const targetSkillDir = join(resolve(input.skillsRootDir), skillName);
	const targetSkillMdPath = join(targetSkillDir, "SKILL.md");
	const targetScriptPath = join(targetSkillDir, "scripts", scriptFileName);

	const description = input.description.trim() || `由已验证脚本 ${scriptFileName} 沉淀的确定性本地处理流程。`;
	const paramBullets =
		input.parametersHint && input.parametersHint.length > 0
			? input.parametersHint.map((p) => `- \`${p}\``).join("\n")
			: "- `--input <path>`: 输入文件路径（只读）\n- `--output <path>`: 输出结果路径";

	const runCmd =
		ext === ".py"
			? `python scripts/${scriptFileName} --input <input_path> --output <output_path>`
			: `node scripts/${scriptFileName} --input <input_path> --output <output_path>`;

	const skillMarkdown = [
		"---",
		`name: ${skillName}`,
		`description: ${JSON.stringify(description)}`,
		"---",
		"",
		`# ${skillName}`,
		"",
		description,
		"",
		"## 适用条件与前置检查",
		"",
		"- 在运行脚本前先核对输入文件存在、编码可读且列名/格式符合预期；",
		"- 若前置检查不通过（如表头结构变化或新异常格式），**立即回退给完整 Agent 重新分析处理**，严禁强行跑脚本。",
		"",
		"## 参数说明",
		"",
		paramBullets,
		"",
		"## 执行方式（Docker 沙箱内运行）",
		"",
		"```bash",
		runCmd,
		"```",
		"",
		"## 后置核对断言",
		"",
		"- 核对输出行数、金额合计与空值率；",
		"- 确认中文 CSV 为 UTF-8-BOM 编码，或交互式 HTML 报告通过确定性离线校验。",
		"",
	].join("\n");

	return {
		skillName,
		description,
		scriptFileName,
		scriptContent: originalScript,
		skillMarkdown,
		targetSkillDir,
		targetSkillMdPath,
		targetScriptPath,
	};
}

/** Write an approved PromoteSkillDraft into the workspace skills directory. */
export function writeApprovedSkillDraft(draft: PromoteSkillDraft): void {
	mkdirSync(join(draft.targetSkillDir, "scripts"), { recursive: true });
	writeFileSync(draft.targetSkillMdPath, draft.skillMarkdown, "utf8");
	writeFileSync(draft.targetScriptPath, draft.scriptContent, "utf8");
}

/** Register /promote-skill command onto pi's ExtensionAPI with mandatory HITL approval. */
export function attachPromoteSkillCommand(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	hitlStore: HitlAuditStore,
): void {
	pi.registerCommand("promote-skill", {
		description:
			"将已跑通的本地脚本沉淀为参数化脚本 + SKILL.md（用法: /promote-skill <skill-name> <script-path> [描述]）",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length < 2) {
				notifyOrLog(
					ctx,
					"用法：/promote-skill <skill-name> <script-path> [简短描述]\n示例：/promote-skill finance-csv-clean ./clean_csv.py 清洗月度财务 CSV 并导出 HTML 报表",
					"warning",
				);
				return;
			}

			const [rawName, rawScriptPath, ...descParts] = parts;
			const sourceScriptPath = resolve(ctx.cwd, rawScriptPath);
			let draft: PromoteSkillDraft;
			try {
				draft = buildPromoteSkillDraft({
					skillName: rawName,
					sourceScriptPath,
					description: descParts.join(" "),
					skillsRootDir: runtime.workspace.skillsDir,
				});
			} catch (error) {
				notifyOrLog(ctx, `生成 Skill 草案失败：${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const decision = await hitlStore.promptForApproval(ctx, {
				sessionId: ctx.sessionManager.getSessionId(),
				kind: "approval",
				actionSummary: `确认将脚本 ${draft.scriptFileName} 沉淀为工作区 Skill "${draft.skillName}"`,
				riskLevel: "medium",
				affectedPaths: [draft.targetSkillMdPath, draft.targetScriptPath],
				diffPreview: draft.skillMarkdown,
			});

			if (!decision.approved) {
				notifyOrLog(ctx, `已取消 Skill 沉淀（audit_id=${decision.auditId}）。`, "info");
				return;
			}

			writeApprovedSkillDraft(draft);
			notifyOrLog(
				ctx,
				`Skill "${draft.skillName}" 已写入：\n- ${draft.targetSkillMdPath}\n- ${draft.targetScriptPath}`,
				"info",
			);
		},
	});
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
