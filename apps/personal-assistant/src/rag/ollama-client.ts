// Local Ollama HTTP client for dense embeddings (bge-m3), cross-encoder reranking,
// optional L2 contextual prefixes, and health checks.

import type { OllamaConfig } from "../config.ts";

export interface RerankItem {
	index: number;
	score: number;
}

export interface OllamaHealthResult {
	reachable: boolean;
	baseUrl: string;
	installedModels: string[];
	missingModels: string[];
	error?: string;
}

export interface RagModelClient {
	embed(texts: readonly string[], model?: string): Promise<Float32Array[]>;
	rerank(query: string, documents: readonly string[], model?: string): Promise<RerankItem[]>;
	generateShortContext?(text: string, model?: string): Promise<string | undefined>;
	healthCheck(): Promise<OllamaHealthResult>;
}

export interface OllamaClientOptions {
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	/** Optional standalone reranker endpoint (e.g. local TEI / Xinference / vLLM /rerank). */
	rerankUrl?: string;
}

/** HTTP client wrapping local Ollama embedding, reranking, and health check endpoints. */
export class OllamaClient implements RagModelClient {
	private readonly config: OllamaConfig;
	private readonly timeoutMs: number;
	private readonly fetchFn: typeof fetch;
	private readonly rerankUrl: string | undefined;

	constructor(config: OllamaConfig, options: OllamaClientOptions = {}) {
		this.config = config;
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.fetchFn = options.fetchFn ?? fetch;
		this.rerankUrl = options.rerankUrl;
	}

	/** Generate dense embeddings for one or more texts using local Ollama (default bge-m3). */
	async embed(texts: readonly string[], model = this.config.embedModel): Promise<Float32Array[]> {
		if (texts.length === 0) return [];
		const baseUrl = stripTrailingSlash(this.config.baseUrl);

		// Prefer Ollama >= 0.2 batch /api/embed endpoint.
		const batchRes = await this.postJson(`${baseUrl}/api/embed`, {
			model,
			input: [...texts],
		});

		if (batchRes.ok) {
			const payload = (await batchRes.json()) as { embeddings?: number[][] };
			if (Array.isArray(payload.embeddings) && payload.embeddings.length === texts.length) {
				return payload.embeddings.map((vec) => Float32Array.from(vec));
			}
			throw new Error(`Ollama /api/embed returned unexpected embedding count for model "${model}".`);
		}

		// Fallback to legacy single-text /api/embeddings endpoint on 404.
		if (batchRes.status === 404) {
			const vectors: Float32Array[] = [];
			for (const text of texts) {
				const singleRes = await this.postJson(`${baseUrl}/api/embeddings`, {
					model,
					prompt: text,
				});
				if (!singleRes.ok) {
					throw new Error(`Ollama /api/embeddings failed (${singleRes.status}): ${await singleRes.text()}`);
				}
				const payload = (await singleRes.json()) as { embedding?: number[] };
				if (!Array.isArray(payload.embedding)) {
					throw new Error(`Ollama /api/embeddings returned invalid payload for model "${model}".`);
				}
				vectors.push(Float32Array.from(payload.embedding));
			}
			return vectors;
		}

		throw new Error(`Ollama /api/embed failed (${batchRes.status}): ${await batchRes.text()}`);
	}

	/**
	 * Rerank candidate documents against a query using local reranker endpoint (/api/rerank or custom rerankUrl).
	 * Returns candidates sorted descending by relevance score.
	 */
	async rerank(query: string, documents: readonly string[], model = this.config.rerankModel): Promise<RerankItem[]> {
		if (documents.length === 0) return [];
		const endpoint = this.rerankUrl ?? `${stripTrailingSlash(this.config.baseUrl)}/api/rerank`;

		const res = await this.postJson(endpoint, {
			model,
			query,
			documents: [...documents],
		});

		if (!res.ok) {
			throw new Error(`Local reranker failed (${res.status}) at ${endpoint}: ${await res.text()}`);
		}

		const payload = (await res.json()) as {
			results?: Array<{ index: number; relevance_score?: number; score?: number }>;
			scores?: number[];
		};

		if (Array.isArray(payload.results)) {
			return payload.results
				.map((item) => ({
					index: item.index,
					score: typeof item.relevance_score === "number" ? item.relevance_score : (item.score ?? 0),
				}))
				.filter((item) => item.index >= 0 && item.index < documents.length)
				.sort((a, b) => b.score - a.score);
		}

		if (Array.isArray(payload.scores) && payload.scores.length === documents.length) {
			return payload.scores.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score);
		}

		throw new Error(`Unexpected reranker response payload from ${endpoint}.`);
	}

	/** Optional L2 semantic context summary (1-2 sentences) using local Ollama lightweight model. */
	async generateShortContext(text: string, model = this.config.sidecarModel): Promise<string | undefined> {
		const baseUrl = stripTrailingSlash(this.config.baseUrl);
		const res = await this.postJson(`${baseUrl}/api/generate`, {
			model,
			prompt: `请用1-2句极简中文概括下面文档片段的核心主题与背景（不超过60字，不要解释）：\n\n${text.slice(0, 1200)}`,
			stream: false,
		});
		if (!res.ok) return undefined;
		const payload = (await res.json()) as { response?: string };
		const trimmed = payload.response?.replace(/\s+/g, " ").trim();
		return trimmed && trimmed.length > 0 ? trimmed.slice(0, 140) : undefined;
	}

	/** Check Ollama daemon reachability and whether configured models are pulled locally. */
	async healthCheck(): Promise<OllamaHealthResult> {
		const baseUrl = stripTrailingSlash(this.config.baseUrl);
		const required = [this.config.embedModel, this.config.rerankModel, this.config.sidecarModel];

		try {
			const res = await this.fetchFn(`${baseUrl}/api/tags`, {
				method: "GET",
				signal: AbortSignal.timeout(Math.min(this.timeoutMs, 8000)),
			});
			if (!res.ok) {
				return {
					reachable: false,
					baseUrl,
					installedModels: [],
					missingModels: required,
					error: `HTTP ${res.status}`,
				};
			}
			const payload = (await res.json()) as { models?: Array<{ name?: string }> };
			const installed = (payload.models ?? [])
				.map((m) => m.name?.trim())
				.filter((name): name is string => Boolean(name));

			const missing = required.filter(
				(req) => !installed.some((inst) => inst === req || inst.startsWith(`${req}:`)),
			);

			return {
				reachable: true,
				baseUrl,
				installedModels: installed,
				missingModels: missing,
			};
		} catch (error) {
			return {
				reachable: false,
				baseUrl,
				installedModels: [],
				missingModels: required,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async postJson(url: string, body: Record<string, unknown>): Promise<Response> {
		return this.fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
	}
}

function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}
