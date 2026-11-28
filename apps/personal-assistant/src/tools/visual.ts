// Multimodal visual analysis tool (analyze_visual) calling a user-configured cloud Vision API
// and returning only concise text answers + provenance without bloating DeepSeek context with raw images.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OptionalApiProviderConfig } from "../config.ts";
import type { AssistantRuntime } from "../extension.ts";

export interface VisualToolOptions {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	/** Optional PDF page renderer returning PNG bytes (injectable for Docker/tests). */
	renderPdfPageToPng?: (pdfPath: string, page: number) => Buffer;
}

export interface AnalyzeVisualInput {
	filePath: string;
	question: string;
	page?: number;
}

const AnalyzeVisualParams = Type.Object({
	file_path: Type.String({ description: "本地图片（png/jpg/webp/gif）或 PDF 文件路径" }),
	question: Type.String({ description: "针对该图片或 PDF 指定页要解答的具体问题" }),
	page: Type.Optional(Type.Number({ description: "当 file_path 为 PDF 时的页码（从 1 开始，默认 1）", minimum: 1 })),
});

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

/** Analyze a local image or specific PDF page via the configured cloud Vision API, returning concise text only. */
export async function executeAnalyzeVisual(
	visionConfig: OptionalApiProviderConfig | undefined,
	input: AnalyzeVisualInput,
	options: VisualToolOptions = {},
): Promise<{ ok: true; answer: string; provenance: string } | { ok: false; message: string }> {
	if (!visionConfig || !visionConfig.baseUrl || !visionConfig.model) {
		return {
			ok: false,
			message:
				"云端视觉模型（models.vision）尚未配置。请在 assistant.config.json 中配置 models.vision.baseUrl、models.vision.model 与 models.vision.apiKeyEnv，并通过 /doctor 检查配置状态。",
		};
	}

	const env = options.env ?? process.env;
	const apiKey = visionConfig.apiKeyEnv ? env[visionConfig.apiKeyEnv]?.trim() : undefined;
	if (visionConfig.apiKeyEnv && !apiKey) {
		return {
			ok: false,
			message: `云端视觉模型缺少环境变量 ${visionConfig.apiKeyEnv}，请设置后再调用 analyze_visual。`,
		};
	}

	const resolvedPath = resolve(input.filePath);
	if (!existsSync(resolvedPath)) {
		return { ok: false, message: `找不到目标文件：${input.filePath}` };
	}

	const ext = extname(resolvedPath).toLowerCase();
	let imageBytes: Buffer;
	let mimeType: string;
	let provenance: string;

	if (ext === ".pdf") {
		const page = input.page ?? 1;
		try {
			imageBytes = options.renderPdfPageToPng
				? options.renderPdfPageToPng(resolvedPath, page)
				: renderPdfPageViaPython(resolvedPath, page);
		} catch (error) {
			return {
				ok: false,
				message: `渲染 PDF 第 ${page} 页为图片失败：${error instanceof Error ? error.message : String(error)}`,
			};
		}
		mimeType = "image/png";
		provenance = `${input.filePath.replace(/\\/g, "/")}#p${page}`;
	} else if (IMAGE_MIME_BY_EXT[ext]) {
		imageBytes = readFileSync(resolvedPath);
		mimeType = IMAGE_MIME_BY_EXT[ext];
		provenance = input.filePath.replace(/\\/g, "/");
	} else {
		return {
			ok: false,
			message: `analyze_visual 仅支持图片（png/jpg/webp/gif）与 PDF 文件，不支持 "${ext || "unknown"}"。`,
		};
	}

	const base64 = imageBytes.toString("base64");
	const fetchFn = options.fetchFn ?? fetch;
	const timeoutMs = options.timeoutMs ?? 45_000;
	const provider = (visionConfig.provider ?? "openai-compatible").toLowerCase();

	try {
		const prompt = [
			"请严格基于所提供的图像内容回答以下问题，输出精炼、准确的中文事实与数值，不要编造看不清的信息：",
			`问题：${input.question}`,
		].join("\n");

		let res: Response;
		if (provider === "anthropic") {
			const endpoint = visionConfig.baseUrl.endsWith("/messages")
				? visionConfig.baseUrl
				: `${visionConfig.baseUrl.replace(/\/+$/, "")}/v1/messages`;
			res = await fetchFn(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"anthropic-version": "2023-06-01",
					...(apiKey ? { "x-api-key": apiKey } : {}),
				},
				body: JSON.stringify({
					model: visionConfig.model,
					max_tokens: 1024,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "image",
									source: { type: "base64", media_type: mimeType, data: base64 },
								},
								{ type: "text", text: prompt },
							],
						},
					],
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} else {
			const endpoint = visionConfig.baseUrl.endsWith("/chat/completions")
				? visionConfig.baseUrl
				: `${visionConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
			res = await fetchFn(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				},
				body: JSON.stringify({
					model: visionConfig.model,
					max_tokens: 1024,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: prompt },
								{ type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
							],
						},
					],
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		}

		if (!res.ok) {
			return { ok: false, message: `云端视觉 API 调用失败 (HTTP ${res.status}): ${await res.text()}` };
		}

		const payload: unknown = await res.json();
		const answer = extractVisionText(payload);
		if (!answer) {
			return { ok: false, message: "云端视觉 API 返回了空结果或无法识别的响应格式。" };
		}

		return { ok: true, answer, provenance };
	} catch (error) {
		return {
			ok: false,
			message: `云端视觉 API 请求异常：${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Register analyze_visual tool onto pi's ExtensionAPI. */
export function attachVisualTool(pi: ExtensionAPI, runtime: AssistantRuntime, options: VisualToolOptions = {}): void {
	pi.registerTool({
		name: "analyze_visual",
		label: "Analyze Visual",
		description:
			"针对本地图片、截图或 PDF 指定页调用云端视觉 API 进行图表/扫描件解读，仅返回针对问题的精炼文本结论与页码出处（不将原图塞入主上下文）。",
		promptSnippet: "调用云端视觉 API 解读截图、图表或 PDF 指定页（仅回传精炼文本与页码出处）",
		parameters: AnalyzeVisualParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedPath = resolve(ctx.cwd, params.file_path);
			const res = await executeAnalyzeVisual(
				runtime.config.models.vision,
				{
					filePath: resolvedPath,
					question: params.question,
					page: params.page,
				},
				options,
			);

			if (!res.ok) {
				return {
					content: [{ type: "text", text: res.message }],
					details: { error: res.message },
				};
			}

			const formatted = `[视觉分析结论 | 来源: ${res.provenance}]\n${res.answer}`;
			return {
				content: [{ type: "text", text: formatted }],
				details: { provenance: res.provenance, page: params.page },
			};
		},
	});
}

function renderPdfPageViaPython(pdfPath: string, page: number): Buffer {
	const pythonBin = process.platform === "win32" ? "python" : "python3";
	const script = [
		"import base64, sys, fitz",
		"doc = fitz.open(sys.argv[1])",
		"idx = int(sys.argv[2]) - 1",
		"if idx < 0 or idx >= len(doc): raise ValueError(f'Page {idx+1} out of range (1..{len(doc)})')",
		"pix = doc[idx].get_pixmap(dpi=150)",
		"sys.stdout.write(base64.b64encode(pix.tobytes('png')).decode('ascii'))",
	].join("; ");
	const b64 = execFileSync(pythonBin, ["-c", script, pdfPath, String(page)], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 25 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	return Buffer.from(b64, "base64");
}

function extractVisionText(payload: unknown): string {
	if (typeof payload !== "object" || payload === null) return "";
	const record = payload as Record<string, unknown>;

	// OpenAI-compatible format
	if (Array.isArray(record.choices) && record.choices.length > 0) {
		const first = record.choices[0] as Record<string, unknown>;
		const message = first?.message as Record<string, unknown> | undefined;
		if (typeof message?.content === "string") {
			return message.content.trim();
		}
		if (Array.isArray(message?.content)) {
			return message.content
				.filter(
					(b): b is { type: string; text: string } =>
						typeof b === "object" &&
						b !== null &&
						(b as { type?: string }).type === "text" &&
						typeof (b as { text?: unknown }).text === "string",
				)
				.map((b) => b.text.trim())
				.join("\n")
				.trim();
		}
	}

	// Anthropic format
	if (Array.isArray(record.content)) {
		return record.content
			.filter(
				(b): b is { type: string; text: string } =>
					typeof b === "object" &&
					b !== null &&
					(b as { type?: string }).type === "text" &&
					typeof (b as { text?: unknown }).text === "string",
			)
			.map((b) => b.text.trim())
			.join("\n")
			.trim();
	}

	return "";
}
