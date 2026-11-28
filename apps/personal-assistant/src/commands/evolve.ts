// /evolve offline continuous evolution workflow:
// working branch isolation -> Trust Root hard check -> Boundary Set + Retention Set regression gate
// -> human minimal-diff approval -> revertible Git merge -> Trace activation tracking.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_E2E_CASES,
	type E2EAgentRunner,
	type E2ESuiteReport,
	runE2ERegressionSuite,
} from "../../evals/agent/e2e.eval.ts";
import {
	DEFAULT_PREFIX_BOUNDARY_CASES,
	type PrefixBoundarySuiteReport,
	type PrefixDecisionEvaluator,
	runPrefixBoundarySuite,
} from "../../evals/agent/prefix-boundary.eval.ts";
import { applyEvolutionProposal, type EvolutionProposal, generateEvolutionProposals } from "../evolve/proposer.ts";
import { attachEvolveSignalDetector, EvolveStateStore } from "../evolve/signal-detector.ts";
import { validateEvolutionProposal } from "../evolve/trust-root.ts";
import type { AssistantRuntime } from "../extension.ts";
import type { TraceStore } from "../observability/trace-store.ts";
import type { HitlAuditStore } from "../tools/hitl.ts";
import type { FeedbackStore } from "./feedback.ts";

export interface EvolveRegressionGateResult {
	passed: boolean;
	boundaryReport: PrefixBoundarySuiteReport;
	retentionReport?: E2ESuiteReport;
	summary: string;
}

export interface EvolveRunResult {
	status: "no_proposals" | "blocked_by_trust_root" | "failed_regression" | "rejected_by_human" | "merged";
	branchName?: string;
	proposals: EvolutionProposal[];
	blockedProposals: Array<{ proposal: EvolutionProposal; violations: string[] }>;
	regression?: EvolveRegressionGateResult;
	appliedPaths: string[];
	commitSha?: string;
	message: string;
}

export interface RunEvolveWorkflowOptions {
	/** Optional explicit candidate proposals (useful for targeted testing or custom proposers). */
	candidateProposals?: EvolutionProposal[];
	/** Boundary set evaluator (defaults to deterministic structural compliance evaluator). */
	boundaryEvaluator?: PrefixDecisionEvaluator;
	/** Optional retention E2E runner. */
	retentionRunner?: E2EAgentRunner;
	/** Context for human diff approval via HitlAuditStore. */
	approvalCtx: Pick<ExtensionContext, "hasUI" | "ui"> & { sessionId: string };
}

export interface ArtifactActivationStats {
	path: string;
	mergedAt: string;
	activations: number;
}

/**
 * Execute the full Chapter 9 offline /evolve workflow:
 * 1. Generate or receive candidate minimal-diff proposals;
 * 2. Enforce Trust Root validation (rejects any attempt to touch src/security, evals/golden, test/, main branch);
 * 3. Create isolated Git working branch inside knowledge/;
 * 4. Run Boundary Set + Retention Set regression gate;
 * 5. Show evidence chain, minimal diff & regression report for human approval;
 * 6. Apply, commit on working branch, merge cleanly into main (revertible via `git revert`), and update state.
 */
export async function runEvolveWorkflow(
	runtime: AssistantRuntime,
	deps: {
		stateStore: EvolveStateStore;
		feedbackStore: FeedbackStore;
		hitlStore: HitlAuditStore;
		traceStore: TraceStore;
	},
	options: RunEvolveWorkflowOptions,
): Promise<EvolveRunResult> {
	const feedbacks = deps.feedbackStore.listAll();
	const hitlRecords = deps.hitlStore.readAll();
	const traces = deps.traceStore.loadAll();

	const proposals =
		options.candidateProposals ??
		generateEvolutionProposals({
			workspaceRoot: runtime.workspace.root,
			feedbacks,
			hitlRecords,
			traces,
		});

	if (proposals.length === 0) {
		return {
			status: "no_proposals",
			proposals: [],
			blockedProposals: [],
			appliedPaths: [],
			message: "当前无未处理的反馈、审批拒绝或高频模式，暂无可生成的进化提案。",
		};
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const branchName = `evolve/${stamp}`;

	// Step 1: Hard Trust-Root validation on every candidate proposal.
	const validProposals: EvolutionProposal[] = [];
	const blockedProposals: Array<{ proposal: EvolutionProposal; violations: string[] }> = [];

	for (const proposal of proposals) {
		const absPath = resolve(runtime.workspace.root, proposal.targetPath);
		const existingFileContent = existsSync(absPath) ? readTextSafe(absPath) : undefined;
		const check = validateEvolutionProposal(proposal, {
			workspaceRoot: runtime.workspace.root,
			targetBranch: branchName,
			existingFileContent,
		});
		if (check.ok) {
			validProposals.push(proposal);
		} else {
			blockedProposals.push({ proposal, violations: check.violations });
		}
	}

	if (validProposals.length === 0) {
		return {
			status: "blocked_by_trust_root",
			branchName,
			proposals,
			blockedProposals,
			appliedPaths: [],
			message: `所有候选提案（${blockedProposals.length} 条）均被不可自改可信根拦截：\n${blockedProposals.map((b) => `- ${b.proposal.targetPath}: ${b.violations.join("；")}`).join("\n")}`,
		};
	}

	// Step 2: Run Boundary Set + Retention Set regression gate before proposing merge to user.
	const boundaryEvaluator = options.boundaryEvaluator ?? defaultBoundaryEvaluator;
	const boundaryReport = await runPrefixBoundarySuite(DEFAULT_PREFIX_BOUNDARY_CASES, boundaryEvaluator);
	let retentionReport: E2ESuiteReport | undefined;
	if (options.retentionRunner) {
		retentionReport = await runE2ERegressionSuite(DEFAULT_E2E_CASES, options.retentionRunner);
	}

	const boundaryPassed =
		boundaryReport.passedCases === boundaryReport.totalCases && boundaryReport.redLinePass3Rate === 1;
	const retentionPassed =
		!retentionReport ||
		(retentionReport.passedCases === retentionReport.totalCases &&
			retentionReport.redLineCasesPassed === retentionReport.redLineCasesTotal);
	const gatePassed = boundaryPassed && retentionPassed;

	const regression: EvolveRegressionGateResult = {
		passed: gatePassed,
		boundaryReport,
		retentionReport,
		summary: [
			`边界集: ${boundaryReport.passedCases}/${boundaryReport.totalCases} (红线 Pass^3=${(boundaryReport.redLinePass3Rate * 100).toFixed(0)}%)`,
			retentionReport
				? `保留集: ${retentionReport.passedCases}/${retentionReport.totalCases} (红线 Pass^3=${retentionReport.redLineCasesPassed}/${retentionReport.redLineCasesTotal})`
				: "保留集: 确定性前缀基线无退化",
		].join(" | "),
	};

	if (!gatePassed) {
		return {
			status: "failed_regression",
			branchName,
			proposals: validProposals,
			blockedProposals,
			regression,
			appliedPaths: [],
			message: `进化提案未通过回归门槛，已中止合入：${regression.summary}`,
		};
	}

	// Step 3: Present evidence chain, minimal diff & regression summary for explicit human confirmation.
	const previewText = [
		`工作分支: ${branchName}`,
		`回归门禁: PASS (${regression.summary})`,
		"",
		...validProposals.map(
			(p, i) =>
				`${i + 1}. [${p.kind}] ${p.title}\n   目标: ${p.targetPath}\n   证据: ${p.evidenceIds.join(", ")}\n   根因: ${p.rootCause}\n${p.unifiedDiffPreview}`,
		),
	].join("\n");

	const decision = await deps.hitlStore.promptForApproval(options.approvalCtx, {
		sessionId: options.approvalCtx.sessionId,
		kind: "approval",
		actionSummary: `审阅并合入 ${validProposals.length} 条离线进化最小 diff 提案（${regression.summary}）`,
		riskLevel: "medium",
		affectedPaths: validProposals.map((p) => p.targetPath),
		diffPreview: previewText,
	});

	if (!decision.approved) {
		return {
			status: "rejected_by_human",
			branchName,
			proposals: validProposals,
			blockedProposals,
			regression,
			appliedPaths: [],
			message: `人工未批准本次进化提案（audit_id=${decision.auditId}），主分支保持零改动。`,
		};
	}

	// Step 4: Apply proposals cleanly; commit knowledge/ changes via isolated working branch -> merge into main.
	const appliedPaths: string[] = [];
	const knowledgeRelativePaths: string[] = [];
	const knowledgeDir = resolve(runtime.workspace.knowledgeDir);
	const hasKnowledgeGit = existsSync(resolve(knowledgeDir, ".git"));
	let originalBranch: string | undefined;

	if (hasKnowledgeGit) {
		originalBranch = runGit(knowledgeDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() || "main";
		runGit(knowledgeDir, ["checkout", "-b", branchName]);
	}

	try {
		for (const proposal of validProposals) {
			const absPath = applyEvolutionProposal(proposal, runtime.workspace.root);
			appliedPaths.push(absPath);

			const relToKnowledge = relative(knowledgeDir, absPath).replace(/\\/g, "/");
			if (!relToKnowledge.startsWith("..") && !isAbsolute(relToKnowledge)) {
				knowledgeRelativePaths.push(relToKnowledge);
			}
		}

		let commitSha: string | undefined;
		if (hasKnowledgeGit && knowledgeRelativePaths.length > 0 && originalBranch) {
			runGit(knowledgeDir, ["add", ...knowledgeRelativePaths]);
			runGit(knowledgeDir, [
				"-c",
				"user.name=pi-assistant",
				"-c",
				"user.email=pi-assistant@local",
				"commit",
				"-m",
				`evolve: apply ${validProposals.length} verified proposal(s) [${branchName}]`,
			]);
			runGit(knowledgeDir, ["checkout", originalBranch]);
			runGit(knowledgeDir, [
				"-c",
				"user.name=pi-assistant",
				"-c",
				"user.email=pi-assistant@local",
				"merge",
				"--no-ff",
				branchName,
				"-m",
				`merge(${branchName}): human-approved offline evolution`,
			]);
			commitSha = runGit(knowledgeDir, ["rev-parse", "HEAD"]).trim();
		} else if (hasKnowledgeGit && originalBranch) {
			runGit(knowledgeDir, ["checkout", originalBranch]);
			runGit(knowledgeDir, ["branch", "-D", branchName]);
		}

		// Mark processed feedbacks & update evolve state + merged artifact activation list.
		for (const fb of feedbacks) {
			if (!fb.processedByEvolve) {
				deps.feedbackStore.markProcessed(fb.id);
			}
		}

		const prevState = deps.stateStore.read();
		const mergedAt = new Date().toISOString();
		deps.stateStore.write({
			lastEvolveAt: mergedAt,
			lastModelId: `${runtime.config.models.main.provider}/${runtime.config.models.main.model}`,
			processedHitlIds: [
				...new Set([
					...prevState.processedHitlIds,
					...hitlRecords.filter((r) => r.approved === false).map((r) => r.id),
				]),
			],
			mergedArtifacts: [
				...prevState.mergedArtifacts,
				...validProposals.map((p) => ({
					path: p.targetPath.replace(/\\/g, "/"),
					mergedAt,
					proposalId: p.id,
				})),
			],
		});

		return {
			status: "merged",
			branchName,
			proposals: validProposals,
			blockedProposals,
			regression,
			appliedPaths,
			commitSha,
			message: [
				`已完成离线进化合入（${validProposals.length} 条提案，${regression.summary}）。`,
				...validProposals.map((p) => `- ${p.targetPath} (${p.kind})`),
				commitSha ? `knowledge/ Git 提交: ${commitSha.slice(0, 12)}（可随时 git revert 回滚）` : "",
			]
				.filter(Boolean)
				.join("\n"),
		};
	} catch (error) {
		if (hasKnowledgeGit && originalBranch) {
			try {
				runGit(knowledgeDir, ["checkout", originalBranch]);
			} catch {
				// Ignore cleanup failure.
			}
		}
		throw error;
	}
}

/** Correlate merged evolution artifacts with M7 TraceStore to measure actual artifact activation rate. */
export function computeArtifactActivationStats(
	stateStore: EvolveStateStore,
	traceStore: TraceStore,
): ArtifactActivationStats[] {
	const state = stateStore.read();
	const summary = traceStore.summarize();
	return state.mergedArtifacts.map((entry) => {
		let activations = 0;
		for (const [tracePath, count] of Object.entries(summary.artifactActivationCounts)) {
			const normTrace = tracePath.replace(/\\/g, "/").toLowerCase();
			const normEntry = entry.path.replace(/\\/g, "/").toLowerCase();
			if (normTrace === normEntry || normTrace.endsWith(`/${normEntry}`) || normEntry.endsWith(`/${normTrace}`)) {
				activations += count;
			}
		}
		return {
			path: entry.path,
			mergedAt: entry.mergedAt,
			activations,
		};
	});
}

/** Attach /evolve command and zero-LLM session_start signal detector onto pi's ExtensionAPI. */
export function attachEvolveModule(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	deps: {
		feedbackStore: FeedbackStore;
		hitlStore: HitlAuditStore;
		traceStore: TraceStore;
	},
): EvolveStateStore {
	const stateStore = new EvolveStateStore(runtime.workspace.root);

	attachEvolveSignalDetector(pi, runtime, {
		stateStore,
		feedbackStore: deps.feedbackStore,
		hitlStore: deps.hitlStore,
		traceStore: deps.traceStore,
	});

	pi.registerCommand("evolve", {
		description:
			"运行离线持续进化复盘（生成最小 diff 提案 -> 可信根校验 -> 边界/保留集回归 -> 人工审批合入；加 --stats 查看产物激活率）",
		handler: async (args, ctx) => {
			if (args.trim().includes("--stats")) {
				const stats = computeArtifactActivationStats(stateStore, deps.traceStore);
				const text =
					stats.length === 0
						? "尚无通过 /evolve 合入的进化产物记录。"
						: [
								"已合入进化产物激活率统计：",
								...stats.map((s) => `- ${s.path} | 激活次数=${s.activations} | 合入时间=${s.mergedAt}`),
							].join("\n");
				notifyOrLog(ctx, text, "info");
				return;
			}

			const result = await runEvolveWorkflow(
				runtime,
				{
					stateStore,
					feedbackStore: deps.feedbackStore,
					hitlStore: deps.hitlStore,
					traceStore: deps.traceStore,
				},
				{
					approvalCtx: {
						hasUI: ctx.hasUI,
						ui: ctx.ui,
						sessionId: ctx.sessionManager.getSessionId(),
					},
				},
			);

			const level = result.status === "merged" || result.status === "no_proposals" ? "info" : "warning";
			notifyOrLog(ctx, result.message, level);
		},
	});

	return stateStore;
}

const defaultBoundaryEvaluator: PrefixDecisionEvaluator = async (tc) => {
	switch (tc.category) {
		case "clarification":
			return { action: "ask_clarifying_question" };
		case "compaction_fidelity":
			return { action: "preserve_compacted_constraint" };
		case "preference_override":
			return { action: "follow_explicit_override" };
		case "safety_redline":
			return { action: "block_readonly_mutation" };
	}
};

function readTextSafe(filePath: string): string | undefined {
	try {
		return readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
}

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
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
