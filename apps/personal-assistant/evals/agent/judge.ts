// Non-DeepSeek heterogeneous LLM-as-a-Judge with 4-tier multi-dimension Rubric and Hallucination Veto.

import type { OptionalApiProviderConfig } from "../../src/config.ts";

export interface JudgeRubricScores {
	clarity: number; // 0..3
	completeness: number; // 0..3
	actionability: number; // 0..3
	provenanceAccuracy: number; // 0..3
}

export interface JudgeEvaluationInput {
	taskPrompt: string;
	candidateOutput: string;
	referenceFacts: string[];
	allowedSources?: string[];
}

export interface JudgeEvaluationResult {
	ok: boolean;
	judgeModel: string;
	rubric: JudgeRubricScores;
	hallucinationDetected: boolean;
	vetoTriggered: boolean;
	vetoReason?: string;
	finalScore: number; // 0..100, forced to 0 when vetoTriggered === true
	passed: boolean;
	rationale: string;
}

export interface JudgeOptions {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	passThreshold?: number;
	timeoutMs?: number;
}

export class HeterogeneousJudgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HeterogeneousJudgeError";
	}
}

/**
 * Enforce non-DeepSeek heterogeneous judge rule (Spec 7.2.3) to guard against same-family bias.
 * Throws HeterogeneousJudgeError if the judge configuration uses DeepSeek.
 */
export function assertHeterogeneousJudge(judgeConfig: OptionalApiProviderConfig | undefined): void {
	if (!judgeConfig || !judgeConfig.model || !judgeConfig.baseUrl) {
		throw new HeterogeneousJudgeError(
			"异源评估模型（models.judge）尚未配置。请在 assistant.config.json 中配置非 DeepSeek 的云端 Judge 模型。",
		);
	}
	const provider = (judgeConfig.provider ?? "").toLowerCase();
	const model = judgeConfig.model.toLowerCase();
	if (provider.includes("deepseek") || model.includes("deepseek")) {
		throw new HeterogeneousJudgeError(
			`禁止使用同源 DeepSeek 模型（${judgeConfig.provider}/${judgeConfig.model}）担任 LLM-as-a-Judge，请配置异源云端模型以防同源偏见。`,
		);
	}
}

/**
 * Deterministic provenance hallucination check: catches fabricated file paths or PDF page citations
 * that do not appear in the allowedSources evidence set.
 */
export function detectDeterministicCitationHallucination(
	candidateOutput: string,
	allowedSources: readonly string[] | undefined,
): string | undefined {
	if (!allowedSources || allowedSources.length === 0) return undefined;
	const normalizedAllowed = new Set(allowedSources.map((s) => s.replace(/\\/g, "/").toLowerCase()));

	const pdfRefs = candidateOutput.matchAll(/([^\s[\]()'":]+\.pdf#p\d+(?:-p?\d+)?)/gi);
	for (const match of pdfRefs) {
		const cited = match[1].replace(/\\/g, "/").toLowerCase();
		const matchesAny = [...normalizedAllowed].some((allowed) => allowed.endsWith(cited) || cited.endsWith(allowed));
		if (!matchesAny) {
			return `检测到未在证据集中出现的虚构 PDF 出处引用：${match[1]}`;
		}
	}
	return undefined;
}

/** Compute normalized 0..100 score from 4-tier rubric, enforcing hard 0-score Veto on hallucination. */
export function scoreWithHallucinationVeto(
	rubric: JudgeRubricScores,
	hallucinationDetected: boolean,
	vetoReason: string | undefined,
	passThreshold = 70,
): { finalScore: number; vetoTriggered: boolean; passed: boolean } {
	if (hallucinationDetected) {
		return {
			finalScore: 0,
			vetoTriggered: true,
			passed: false,
		};
	}
	const clamp = (v: number) => Math.max(0, Math.min(3, Math.round(v)));
	const sum =
		clamp(rubric.clarity) +
		clamp(rubric.completeness) +
		clamp(rubric.actionability) +
		clamp(rubric.provenanceAccuracy);
	const finalScore = Math.round((sum / 12) * 100);
	void vetoReason;
	return {
		finalScore,
		vetoTriggered: false,
		passed: finalScore >= passThreshold,
	};
}

/** Evaluate open-ended quality with a non-DeepSeek heterogeneous LLM-as-a-Judge + Hallucination Veto. */
export async function evaluateWithHeterogeneousJudge(
	judgeConfig: OptionalApiProviderConfig | undefined,
	input: JudgeEvaluationInput,
	options: JudgeOptions = {},
): Promise<JudgeEvaluationResult> {
	assertHeterogeneousJudge(judgeConfig);
	const cfg = judgeConfig!;
	const env = options.env ?? process.env;
	const apiKey = cfg.apiKeyEnv ? env[cfg.apiKeyEnv]?.trim() : undefined;
	if (cfg.apiKeyEnv && !apiKey) {
		throw new HeterogeneousJudgeError(`异源 Judge 缺少环境变量 ${cfg.apiKeyEnv}。`);
	}

	const passThreshold = options.passThreshold ?? 70;
	const detHallucination = detectDeterministicCitationHallucination(input.candidateOutput, input.allowedSources);
	if (detHallucination) {
		return {
			ok: true,
			judgeModel: `${cfg.provider ?? "custom"}/${cfg.model}`,
			rubric: { clarity: 0, completeness: 0, actionability: 0, provenanceAccuracy: 0 },
			hallucinationDetected: true,
			vetoTriggered: true,
			vetoReason: detHallucination,
			finalScore: 0,
			passed: false,
			rationale: `确定性出处核查直接触发幻觉一票否决（Veto）：${detHallucination}`,
		};
	}

	const prompt = [
		"你是严格的独立质量评估 Judge。请基于给定参考事实，按 4 档 Rubric（每项 0-3 分）评估候选输出，并严格检测是否存在任何虚构数字、虚构路径或与参考事实矛盾的幻觉。",
		"必须返回严格 JSON：",
		'{"clarity":0-3,"completeness":0-3,"actionability":0-3,"provenanceAccuracy":0-3,"hallucination_detected":true|false,"veto_reason":"如检测到幻觉填具体原因，否则空字符串","rationale":"简短评语"}',
		"",
		`任务需求：${input.taskPrompt}`,
		`参考事实：\n- ${input.referenceFacts.join("\n- ")}`,
		`候选输出：\n${input.candidateOutput}`,
	].join("\n");

	const fetchFn = options.fetchFn ?? fetch;
	const endpoint = cfg.baseUrl!.endsWith("/chat/completions")
		? cfg.baseUrl!
		: `${cfg.baseUrl!.replace(/\/+$/, "")}/chat/completions`;

	const res = await fetchFn(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: cfg.model,
			temperature: 0,
			messages: [{ role: "user", content: prompt }],
		}),
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
	});

	if (!res.ok) {
		throw new Error(`Judge API failed (HTTP ${res.status}): ${await res.text()}`);
	}

	const payload = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const rawText = payload.choices?.[0]?.message?.content?.trim() ?? "";
	const jsonBlock = extractJsonObject(rawText);
	const parsed = JSON.parse(jsonBlock) as {
		clarity?: number;
		completeness?: number;
		actionability?: number;
		provenanceAccuracy?: number;
		hallucination_detected?: boolean;
		veto_reason?: string;
		rationale?: string;
	};

	const rubric: JudgeRubricScores = {
		clarity: Number(parsed.clarity ?? 0),
		completeness: Number(parsed.completeness ?? 0),
		actionability: Number(parsed.actionability ?? 0),
		provenanceAccuracy: Number(parsed.provenanceAccuracy ?? 0),
	};
	const hallucinationDetected = Boolean(parsed.hallucination_detected);
	const vetoReason = hallucinationDetected ? parsed.veto_reason?.trim() || "Judge 检测到事实或出处幻觉" : undefined;
	const scored = scoreWithHallucinationVeto(rubric, hallucinationDetected, vetoReason, passThreshold);

	return {
		ok: true,
		judgeModel: `${cfg.provider ?? "custom"}/${cfg.model}`,
		rubric,
		hallucinationDetected,
		vetoTriggered: scored.vetoTriggered,
		vetoReason,
		finalScore: scored.finalScore,
		passed: scored.passed,
		rationale: parsed.rationale?.trim() ?? "",
	};
}

function extractJsonObject(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) return fenced[1].trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start !== -1 && end > start) {
		return text.slice(start, end + 1);
	}
	return text;
}
