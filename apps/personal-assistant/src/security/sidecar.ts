// Layer 3 (two-stage human confirmation) + Layer 4 (context-isolated local Ollama Sidecar risk control)
// with deformed shell command semantic analysis and 3-rejection circuit breaker.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OllamaConfig } from "../config.ts";
import type { AssistantRuntime } from "../extension.ts";
import type { HitlAuditStore } from "../tools/hitl.ts";
import type { WorkspacePaths } from "../workspace.ts";

export interface CommandSemanticAnalysis {
	risk: "low" | "high";
	reasons: string[];
	requiresConfirmation: boolean;
}

/**
 * Strictly isolated Sidecar review input: ONLY structured { tool, args, target_scope }.
 * NEVER includes conversation history, assistant thoughts, or external web/document text.
 */
export interface SidecarReviewPayload {
	tool: string;
	args: Record<string, unknown>;
	target_scope: {
		cwd: string;
		workspaceRoot: string;
		readOnlyZones: string[];
	};
}

export interface SidecarReviewResult {
	decision: "allow" | "confirm" | "block";
	risk: "low" | "medium" | "high";
	reason: string;
}

export type SidecarReviewerFn = (payload: SidecarReviewPayload) => Promise<SidecarReviewResult>;

export interface AttachSidecarOptions {
	reviewer?: SidecarReviewerFn;
	fetchFn?: typeof fetch;
	maxConsecutiveRejections?: number;
}

const DEFAULT_MAX_SIDECAR_REJECTIONS = 3;

const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
	{ regex: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--force\b|--recursive\b)/i, reason: "检测到强制/递归删除命令 rm" },
	{ regex: /\b(?:del|erase)\s+\/[fqas]/i, reason: "检测到 Windows 强制删除命令 del" },
	{ regex: /\b(?:rmdir|rd)\s+\/[sq]/i, reason: "检测到 Windows 递归删除目录命令 rmdir" },
	{ regex: /\bRemove-Item\b[^\n]*(?:-Recurse|-Force)/i, reason: "检测到 PowerShell 递归/强制删除 Remove-Item" },
	{
		regex: /\bfind\b[^\n]*-(?:exec|execdir|ok)\b[^\n]*\b(?:rm|del|shred|unlink|mv)\b/i,
		reason: "检测到变形危险命令 find -exec 删除/移动",
	},
	{ regex: /\bfind\b[^\n]*-delete\b/i, reason: "检测到变形危险命令 find -delete" },
	{ regex: /\bxargs\b[^\n]*\b(?:rm|del|unlink|shred)\b/i, reason: "检测到管道变形删除命令 xargs rm" },
	{ regex: /\$\([^)]*\b(?:rm|del|curl|wget|sh|bash|iex)\b[^)]*\)/i, reason: "检测到命令替换混淆执行 $(...)" },
	{ regex: /`[^`]*\b(?:rm|del|curl|wget|sh|bash)\b[^`]*`/i, reason: "检测到反引号命令混淆执行" },
	{ regex: /\beval\s+/i, reason: "检测到动态求值命令 eval" },
	{
		regex: /\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:sh|bash|pwsh|powershell|python)/i,
		reason: "检测到 base64 编码混淆管道执行",
	},
	{
		regex: /\b(?:curl|wget)\b[^\n]*(?:-o\b|-O\b|--output\b|\|\s*(?:sh|bash|zsh|pwsh|powershell))/i,
		reason: "检测到外部下载落盘或管道执行 curl/wget",
	},
	{
		regex: /\b(?:Invoke-WebRequest|iwr|irm|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)/i,
		reason: "检测到 PowerShell 远程下载管道执行",
	},
	{
		regex: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+(?:--force|-f))\b/i,
		reason: "检测到破坏性 Git 命令",
	},
	{ regex: /\b(?:mkfs|format\s+[a-z]:|dd\s+if=)/i, reason: "检测到磁盘底层格式化/覆写命令" },
	{ regex: /(?:~\/\.ssh|\/\.ssh\\|id_rsa|id_ed25519)/i, reason: "检测到访问宿主机 SSH 密钥目录" },
];

const SHELL_WRITE_OR_DELETE_HINT =
	/(?:>|>>|\brm\b|\bdel\b|\bmv\b|\bcp\b|\bRemove-Item\b|\bSet-Content\b|\bOut-File\b|\bsed\s+-i\b)/i;

/** Deterministic command semantic analyzer catching direct and deformed dangerous shell commands. */
export function analyzeCommandSemantics(command: string, workspace: WorkspacePaths): CommandSemanticAnalysis {
	const reasons: string[] = [];

	for (const rule of DANGEROUS_COMMAND_PATTERNS) {
		if (rule.regex.test(command)) {
			reasons.push(rule.reason);
		}
	}

	// Detect shell attempts to write/delete read-only evidence zones.
	const normalizedCmd = command.replace(/\\/g, "/").toLowerCase();
	const readOnlyFragments = [
		"evidence/raw_pdfs",
		"evidence/sessions",
		workspace.rawPdfsDir.replace(/\\/g, "/").toLowerCase(),
		workspace.sessionsDir.replace(/\\/g, "/").toLowerCase(),
	];
	if (SHELL_WRITE_OR_DELETE_HINT.test(command)) {
		for (const frag of readOnlyFragments) {
			if (frag && normalizedCmd.includes(frag)) {
				reasons.push(`检测到 Shell 命令尝试修改只读证据区 (${frag})`);
				break;
			}
		}
	}

	const unique = [...new Set(reasons)];
	return {
		risk: unique.length > 0 ? "high" : "low",
		reasons: unique,
		requiresConfirmation: unique.length > 0,
	};
}

/**
 * Construct the strictly isolated Sidecar review payload containing ONLY { tool, args, target_scope }.
 * Deliberately strips any conversation history, user prompts, or external web content.
 */
export function buildSidecarPayload(
	toolName: string,
	args: Record<string, unknown>,
	cwd: string,
	workspace: WorkspacePaths,
): SidecarReviewPayload {
	// Deep-clone only primitive/plain JSON arguments of the tool call itself.
	const sanitizedArgs: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			value === null ||
			Array.isArray(value)
		) {
			sanitizedArgs[key] = typeof value === "string" ? value.slice(0, 2000) : value;
		}
	}

	return {
		tool: toolName,
		args: sanitizedArgs,
		target_scope: {
			cwd: cwd.replace(/\\/g, "/"),
			workspaceRoot: workspace.root.replace(/\\/g, "/"),
			readOnlyZones: [
				workspace.rawPdfsDir.replace(/\\/g, "/"),
				workspace.sessionsDir.replace(/\\/g, "/"),
				workspace.tracesDir.replace(/\\/g, "/"),
				workspace.feedbackDir.replace(/\\/g, "/"),
			],
		},
	};
}

/** Circuit breaker halting risky actions after 3 consecutive Sidecar rejections until human intervention. */
export class SidecarCircuitBreaker {
	private readonly maxRejections: number;
	private consecutiveRejections = 0;

	constructor(maxRejections = DEFAULT_MAX_SIDECAR_REJECTIONS) {
		this.maxRejections = maxRejections;
	}

	/** Record an approved/allowed execution and reset consecutive rejections. */
	recordAllow(): void {
		this.consecutiveRejections = 0;
	}

	/** Record a Sidecar rejection; returns true when circuit breaker trips (>= 3). */
	recordRejection(): boolean {
		this.consecutiveRejections += 1;
		return this.isTripped();
	}

	/** Whether consecutive rejections reached the trip threshold. */
	isTripped(): boolean {
		return this.consecutiveRejections >= this.maxRejections;
	}

	/** Current consecutive rejection count. */
	getConsecutiveRejections(): number {
		return this.consecutiveRejections;
	}

	/** Reset breaker state (e.g. on new session or manual reset). */
	reset(): void {
		this.consecutiveRejections = 0;
	}
}

/** Create the default local Ollama Sidecar reviewer using ONLY the isolated JSON payload. */
export function createOllamaSidecarReviewer(
	ollamaConfig: OllamaConfig,
	fetchFn: typeof fetch = fetch,
): SidecarReviewerFn {
	return async (payload: SidecarReviewPayload): Promise<SidecarReviewResult> => {
		const endpoint = `${ollamaConfig.baseUrl.replace(/\/+$/, "")}/api/generate`;
		const prompt = [
			"你是独立的安全旁路审查器（Sidecar）。请仅根据下方结构化工具调用数据进行风险判定，绝不假设任何对话背景。",
			'输出严格 JSON：{"decision":"allow"|"confirm"|"block","risk":"low"|"medium"|"high","reason":"简短中文理由"}。',
			"规则：删除文件、覆写原始只读证据区、越界访问宿主机敏感目录、变形/混淆 Shell 命令或外传本地数据必须判定为 confirm 或 block。",
			"",
			JSON.stringify(payload),
		].join("\n");

		try {
			const res = await fetchFn(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: ollamaConfig.sidecarModel,
					prompt,
					format: "json",
					stream: false,
					think: false,
					options: {
						temperature: 0,
						num_predict: 180,
					},
				}),
				signal: AbortSignal.timeout(15_000),
			});

			if (!res.ok) {
				return {
					decision: "confirm",
					risk: "medium",
					reason: `本地 Ollama Sidecar 返回 HTTP ${res.status}，降级请求人工确认`,
				};
			}

			const body = (await res.json()) as { response?: string };
			const parsed = JSON.parse(body.response ?? "{}") as Partial<SidecarReviewResult>;
			const decision =
				parsed.decision === "allow" || parsed.decision === "confirm" || parsed.decision === "block"
					? parsed.decision
					: "confirm";
			const risk =
				parsed.risk === "low" || parsed.risk === "medium" || parsed.risk === "high"
					? parsed.risk
					: decision === "allow"
						? "low"
						: "high";

			return {
				decision,
				risk,
				reason:
					typeof parsed.reason === "string" && parsed.reason.trim().length > 0
						? parsed.reason.trim()
						: "Sidecar 风险提示",
			};
		} catch (error) {
			return {
				decision: "confirm",
				risk: "medium",
				reason: `本地 Ollama Sidecar 不可用（${error instanceof Error ? error.message : String(error)}），降级人工确认`,
			};
		}
	};
}

/** Attach Layer 3 two-stage confirmation and Layer 4 context-isolated Ollama Sidecar onto tool_call. */
export function attachSidecarSecurityGuard(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	hitlStore: HitlAuditStore,
	options: AttachSidecarOptions = {},
): SidecarCircuitBreaker {
	const breaker = new SidecarCircuitBreaker(options.maxConsecutiveRejections ?? DEFAULT_MAX_SIDECAR_REJECTIONS);
	const reviewer = options.reviewer ?? createOllamaSidecarReviewer(runtime.config.ollama, options.fetchFn);

	pi.on("session_start", () => {
		breaker.reset();
	});

	pi.on("tool_call", async (event, ctx) => {
		const isShellTool = event.toolName === "bash" || event.toolName === "powershell";
		const isMutationTool = event.toolName === "write" || event.toolName === "edit";
		if (!isShellTool && !isMutationTool) {
			return undefined;
		}

		const input = event.input as Record<string, unknown>;
		const commandText = typeof input.command === "string" ? input.command : undefined;
		const reasons: string[] = [];
		let needsConfirmation = false;
		let sidecarBlocked = false;

		// 1. Layer 3 deterministic command semantic analysis (always on for shell tools).
		if (isShellTool && commandText) {
			const semantic = analyzeCommandSemantics(commandText, runtime.workspace);
			if (semantic.requiresConfirmation) {
				needsConfirmation = true;
				reasons.push(...semantic.reasons);
			}
		}

		// 2. Layer 4 context-isolated Ollama Sidecar review (controlled by ablation flag features.sidecar).
		if (runtime.config.features.sidecar && isShellTool) {
			if (breaker.isTripped()) {
				return {
					block: true,
					reason: `层 4 Sidecar 熔断器已触发（连续拒绝达 ${breaker.getConsecutiveRejections()} 次），已停止自动执行高风险命令，请人工检查后介入。`,
				};
			}

			const payload = buildSidecarPayload(event.toolName, input, ctx.cwd, runtime.workspace);
			const verdict = await reviewer(payload);

			if (verdict.decision === "block") {
				sidecarBlocked = true;
				needsConfirmation = true;
				reasons.push(`Sidecar 拦截(${verdict.risk}): ${verdict.reason}`);
			} else if (verdict.decision === "confirm") {
				needsConfirmation = true;
				reasons.push(`Sidecar 建议确认(${verdict.risk}): ${verdict.reason}`);
			}
		}

		if (!needsConfirmation) {
			breaker.recordAllow();
			return undefined;
		}

		if (sidecarBlocked) {
			const tripped = breaker.recordRejection();
			if (tripped) {
				hitlStore.record({
					sessionId: ctx.sessionManager.getSessionId(),
					kind: "security_confirm",
					actionSummary: `Sidecar 连续拒绝触发熔断: ${reasons.join("；")}`,
					approved: false,
					reason: "Sidecar 3-rejection circuit breaker tripped",
					riskLevel: "high",
					commandPreview: commandText,
				});
				return {
					block: true,
					reason: `层 4 Sidecar 连续拒绝达 ${breaker.getConsecutiveRejections()} 次触发熔断：${reasons.join("；")}。已交还人工裁决。`,
				};
			}
		}

		// 3. Layer 3 two-stage confirmation via HITL audit store.
		const decision = await hitlStore.promptForApproval(ctx, {
			sessionId: ctx.sessionManager.getSessionId(),
			kind: "security_confirm",
			actionSummary: reasons.join("；") || `高风险工具调用 ${event.toolName}`,
			riskLevel: "high",
			commandPreview: commandText,
			affectedPaths: typeof input.path === "string" ? [input.path] : undefined,
		});

		if (!decision.approved) {
			return {
				block: true,
				reason: `层 3/4 安全确认未通过（audit_id=${decision.auditId}）：${decision.reason ?? "用户拒绝"}。原因：${reasons.join("；")}`,
			};
		}

		breaker.recordAllow();
		return undefined;
	});

	return breaker;
}
