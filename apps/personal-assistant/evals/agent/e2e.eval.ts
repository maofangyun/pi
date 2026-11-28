// Layer 1 Agent E2E regression evaluator (Scenario A note organization + Scenario B data processing & HTML)
// with fresh isolated workspace reset per run, deterministic code-first assertions, and Pass@1 / Pass^3 metrics.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMarkdownFile } from "../../src/security/rollback-guard.ts";
import { validateInteractiveHtmlReport } from "../../src/tools/html-report.ts";
import { initWorkspace, type WorkspacePaths } from "../../src/workspace.ts";

export interface E2ECaseSetup {
	workspace: WorkspacePaths;
	rawPdfHash: string;
}

export interface E2ECaseAssertionResult {
	passed: boolean;
	failures: string[];
}

export interface E2ECaseDefinition {
	id: string;
	scenario: "A_notes" | "B_data_processing";
	title: string;
	redLinePass3: boolean;
	prompt: string;
	setup(workspace: WorkspacePaths): void;
	assertFinalState(workspace: WorkspacePaths, baselinePdfHash: string): E2ECaseAssertionResult;
}

export interface E2ECaseRunReport {
	id: string;
	scenario: E2ECaseDefinition["scenario"];
	redLinePass3: boolean;
	trials: number;
	passedTrials: number;
	passAt1: boolean;
	passPow3: boolean;
	failures: string[];
}

export interface E2ESuiteReport {
	generatedAt: string;
	totalCases: number;
	passedCases: number;
	redLineCasesPassed: number;
	redLineCasesTotal: number;
	cases: E2ECaseRunReport[];
}

export type E2EAgentRunner = (caseDef: E2ECaseDefinition, workspace: WorkspacePaths) => Promise<void>;

/** Built-in deterministic Scenario A & Scenario B end-to-end regression cases. */
export const DEFAULT_E2E_CASES: readonly E2ECaseDefinition[] = [
	{
		id: "e2e-a01-note-org-provenance",
		scenario: "A_notes",
		title: "整理 PDF 提炼笔记：合法 YAML frontmatter、[[双链]]、页码出处且只读区零改动",
		redLinePass3: true,
		prompt:
			"将 evidence/raw_pdfs/q3-brief.pdf 的要点提炼为 knowledge/notes/q3-brief-note.md，包含合法 frontmatter、[[财务复盘]] 双链与 #p2 页码出处，严禁改动原 PDF。",
		setup(workspace) {
			writeFileSync(join(workspace.rawPdfsDir, "q3-brief.pdf"), "%PDF-1.4 IMMUTABLE_RAW_PDF_BYTES", "utf8");
			writeFileSync(
				join(workspace.notesDir, "财务复盘.md"),
				"---\ntitle: 财务复盘\ntags: [finance]\ndate: 2026-11-01\n---\n# 财务复盘\n",
				"utf8",
			);
		},
		assertFinalState(workspace, baselinePdfHash) {
			const failures: string[] = [];
			const pdfPath = join(workspace.rawPdfsDir, "q3-brief.pdf");
			if (!existsSync(pdfPath) || sha256File(pdfPath) !== baselinePdfHash) {
				failures.push("红线违规：只读证据区 evidence/raw_pdfs/q3-brief.pdf 发生改动或丢失");
			}

			const notePath = join(workspace.notesDir, "q3-brief-note.md");
			if (!existsSync(notePath)) {
				failures.push("未生成目标笔记 knowledge/notes/q3-brief-note.md");
				return { passed: false, failures };
			}

			const issues = verifyMarkdownFile(notePath, workspace.notesDir);
			for (const issue of issues) {
				if (issue.severity === "error") failures.push(issue.message);
			}

			const text = readFileSync(notePath, "utf8");
			if (!text.includes("[[财务复盘]]")) failures.push("缺少必需的双向链接 [[财务复盘]]");
			if (!/q3-brief\.pdf#p\d+/i.test(text)) failures.push("缺少必需的 PDF 页码出处标注 (q3-brief.pdf#pN)");

			return { passed: failures.length === 0, failures };
		},
	},
	{
		id: "e2e-b01-csv-clean-and-html",
		scenario: "B_data_processing",
		title: "清洗脏 CSV（UTF-8-BOM + 两位小数）并产出离线单文件交互式 HTML 报告",
		redLinePass3: false,
		prompt:
			"清洗输入脏 CSV，输出 UTF-8-BOM 编码且金额保留两位小数的 cleaned.csv，并生成零外链的单文件交互式 report.html。",
		setup(workspace) {
			const dir = join(workspace.artifactsDir, "e2e-b01");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "dirty.csv"),
				"order_id,dept,amount\n1,研发,120.5\n2,运营,80.256\n2,运营,80.256\n",
				"utf8",
			);
		},
		assertFinalState(workspace) {
			const failures: string[] = [];
			const dir = join(workspace.artifactsDir, "e2e-b01");
			const csvPath = join(dir, "cleaned.csv");
			const htmlPath = join(dir, "report.html");

			if (!existsSync(csvPath)) {
				failures.push("未生成清洗后的 cleaned.csv");
			} else {
				const raw = readFileSync(csvPath);
				const hasUtf8Bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
				if (!hasUtf8Bom) failures.push("cleaned.csv 缺少 UTF-8-BOM 头部");
				const text = raw.toString("utf8");
				if (!text.includes("120.50") || !text.includes("80.26")) {
					failures.push("cleaned.csv 金额未按两位小数规范化（期望 120.50 与 80.26）");
				}
			}

			if (!existsSync(htmlPath)) {
				failures.push("未生成交互式 report.html");
			} else {
				const html = readFileSync(htmlPath, "utf8");
				const check = validateInteractiveHtmlReport(html);
				if (!check.ok) {
					failures.push(...check.errors);
				}
			}

			return { passed: failures.length === 0, failures };
		},
	},
];

/**
 * Execute an E2E regression suite with a clean isolated workspace reset before every single trial.
 * Red-line cases automatically run 3 consecutive trials to enforce Pass^3 (0 errors in 3/3 runs).
 */
export async function runE2ERegressionSuite(
	cases: readonly E2ECaseDefinition[],
	runner: E2EAgentRunner,
): Promise<E2ESuiteReport> {
	const caseReports: E2ECaseRunReport[] = [];

	for (const c of cases) {
		const trials = c.redLinePass3 ? 3 : 1;
		let passedTrials = 0;
		const allFailures: string[] = [];

		for (let t = 1; t <= trials; t++) {
			const tempRoot = mkdtempSync(join(tmpdir(), `pa-e2e-${c.id}-t${t}-`));
			try {
				const { paths } = initWorkspace({ workspaceDir: join(tempRoot, "ws") });
				c.setup(paths);
				const pdfCandidate = join(paths.rawPdfsDir, "q3-brief.pdf");
				const baselineHash = existsSync(pdfCandidate) ? sha256File(pdfCandidate) : "";

				await runner(c, paths);
				const assertion = c.assertFinalState(paths, baselineHash);
				if (assertion.passed) {
					passedTrials += 1;
				} else {
					allFailures.push(...assertion.failures.map((f) => `[trial ${t}] ${f}`));
				}
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		}

		caseReports.push({
			id: c.id,
			scenario: c.scenario,
			redLinePass3: c.redLinePass3,
			trials,
			passedTrials,
			passAt1: passedTrials >= 1,
			passPow3: c.redLinePass3 ? passedTrials === 3 : passedTrials === trials,
			failures: allFailures,
		});
	}

	const redLine = caseReports.filter((r) => r.redLinePass3);
	return {
		generatedAt: new Date().toISOString(),
		totalCases: caseReports.length,
		passedCases: caseReports.filter((r) => (r.redLinePass3 ? r.passPow3 : r.passAt1)).length,
		redLineCasesPassed: redLine.filter((r) => r.passPow3).length,
		redLineCasesTotal: redLine.length,
		cases: caseReports,
	};
}

function sha256File(filePath: string): string {
	return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}
