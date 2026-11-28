// Configuration loader, validator, and ablation feature flags for the personal assistant.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface FeatureFlags {
	statusBar: boolean;
	l2MicroCompact: boolean;
	reranker: boolean;
	sidecar: boolean;
	dockerSandbox: boolean;
}

export interface WorkspaceConfig {
	workspaceDir: string;
	notesDir?: string;
	rawPdfsDir?: string;
}

export interface MainModelConfig {
	provider: string;
	model: string;
	thinking: ThinkingLevel;
	baseUrl?: string;
	apiKeyEnv: string;
}

export interface OptionalApiProviderConfig {
	provider?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
	model?: string;
}

export interface OptionalSearchConfig {
	provider?: string;
	baseUrl?: string;
	apiKeyEnv?: string;
}

export interface OllamaConfig {
	baseUrl: string;
	embedModel: string;
	rerankModel: string;
	sidecarModel: string;
}

export interface AssistantConfig {
	configPath?: string;
	workspace: WorkspaceConfig;
	models: {
		main: MainModelConfig;
		vision?: OptionalApiProviderConfig;
		judge?: OptionalApiProviderConfig;
	};
	search?: OptionalSearchConfig;
	ollama: OllamaConfig;
	features: FeatureFlags;
}

export interface LoadAssistantConfigOptions {
	configPath?: string;
	workspaceDir?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

export class AssistantConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssistantConfigError";
	}
}

export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlags> = {
	statusBar: true,
	l2MicroCompact: true,
	reranker: true,
	sidecar: true,
	dockerSandbox: true,
};

export const DEFAULT_MAIN_MODEL_CONFIG: Readonly<MainModelConfig> = {
	provider: "deepseek",
	model: "deepseek-v4-pro",
	thinking: "high",
	apiKeyEnv: "DEEPSEEK_API_KEY",
};

export const DEFAULT_OLLAMA_CONFIG: Readonly<OllamaConfig> = {
	baseUrl: "http://127.0.0.1:11434",
	embedModel: "bge-m3",
	rerankModel: "bge-reranker-v2-m3",
	sidecarModel: "qwen2.5:3b",
};

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_CONFIG_FILENAME = "assistant.config.json";

/** Load and validate assistant configuration from JSON file, env vars, and CLI overrides. */
export function loadAssistantConfig(options: LoadAssistantConfigOptions = {}): AssistantConfig {
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;
	const configPath = resolveConfigFilePath(options.configPath, cwd, env);
	const raw = configPath ? readConfigFile(configPath) : {};
	const baseDir = configPath ? dirname(configPath) : cwd;

	const rawWorkspace = readOptionalRecord(raw.workspace, "workspace");
	const rawModels = readOptionalRecord(raw.models, "models");
	const rawMain = readOptionalRecord(rawModels?.main, "models.main");
	const rawOllama = readOptionalRecord(raw.ollama, "ollama");
	const rawFeatures = readOptionalRecord(raw.features, "features");

	const workspaceDir = resolveRequiredWorkspaceDir(
		options.workspaceDir,
		env.PI_ASSISTANT_WORKSPACE,
		rawWorkspace,
		cwd,
		baseDir,
	);
	const notesDir = resolveOptionalPath(
		env.PI_ASSISTANT_NOTES_DIR,
		rawWorkspace?.notesDir,
		"workspace.notesDir",
		cwd,
		baseDir,
	);
	const rawPdfsDir = resolveOptionalPath(
		env.PI_ASSISTANT_RAW_PDFS_DIR,
		rawWorkspace?.rawPdfsDir,
		"workspace.rawPdfsDir",
		cwd,
		baseDir,
	);

	const provider =
		readNonEmptyEnv(env.PI_ASSISTANT_PROVIDER) ??
		readOptionalString(rawMain?.provider, "models.main.provider") ??
		DEFAULT_MAIN_MODEL_CONFIG.provider;
	const model =
		readNonEmptyEnv(env.PI_ASSISTANT_MODEL) ??
		readOptionalString(rawMain?.model, "models.main.model") ??
		DEFAULT_MAIN_MODEL_CONFIG.model;
	const thinking = parseThinkingLevel(
		readNonEmptyEnv(env.PI_ASSISTANT_THINKING) ??
			readOptionalString(rawMain?.thinking, "models.main.thinking") ??
			DEFAULT_MAIN_MODEL_CONFIG.thinking,
	);
	const mainBaseUrl =
		(provider === "deepseek" ? readNonEmptyEnv(env.DEEPSEEK_BASE_URL) : undefined) ??
		readOptionalString(rawMain?.baseUrl, "models.main.baseUrl");
	const apiKeyEnv =
		readOptionalString(rawMain?.apiKeyEnv, "models.main.apiKeyEnv") ?? DEFAULT_MAIN_MODEL_CONFIG.apiKeyEnv;

	const vision = parseOptionalApiProvider(rawModels?.vision, "models.vision");
	const judge = parseOptionalApiProvider(rawModels?.judge, "models.judge");
	const search = parseOptionalSearch(raw.search, "search");

	const ollama: OllamaConfig = {
		baseUrl:
			readNonEmptyEnv(env.OLLAMA_BASE_URL) ??
			readOptionalString(rawOllama?.baseUrl, "ollama.baseUrl") ??
			DEFAULT_OLLAMA_CONFIG.baseUrl,
		embedModel:
			readNonEmptyEnv(env.OLLAMA_EMBED_MODEL) ??
			readOptionalString(rawOllama?.embedModel, "ollama.embedModel") ??
			DEFAULT_OLLAMA_CONFIG.embedModel,
		rerankModel:
			readNonEmptyEnv(env.OLLAMA_RERANK_MODEL) ??
			readOptionalString(rawOllama?.rerankModel, "ollama.rerankModel") ??
			DEFAULT_OLLAMA_CONFIG.rerankModel,
		sidecarModel:
			readNonEmptyEnv(env.OLLAMA_SIDECAR_MODEL) ??
			readOptionalString(rawOllama?.sidecarModel, "ollama.sidecarModel") ??
			DEFAULT_OLLAMA_CONFIG.sidecarModel,
	};

	const features: FeatureFlags = {
		statusBar: resolveFeatureFlag(
			env.PI_ASSISTANT_FLAG_STATUS_BAR,
			rawFeatures?.statusBar,
			"features.statusBar",
			DEFAULT_FEATURE_FLAGS.statusBar,
		),
		l2MicroCompact: resolveFeatureFlag(
			env.PI_ASSISTANT_FLAG_L2_MICRO_COMPACT,
			rawFeatures?.l2MicroCompact,
			"features.l2MicroCompact",
			DEFAULT_FEATURE_FLAGS.l2MicroCompact,
		),
		reranker: resolveFeatureFlag(
			env.PI_ASSISTANT_FLAG_RERANKER,
			rawFeatures?.reranker,
			"features.reranker",
			DEFAULT_FEATURE_FLAGS.reranker,
		),
		sidecar: resolveFeatureFlag(
			env.PI_ASSISTANT_FLAG_SIDECAR,
			rawFeatures?.sidecar,
			"features.sidecar",
			DEFAULT_FEATURE_FLAGS.sidecar,
		),
		dockerSandbox: resolveFeatureFlag(
			env.PI_ASSISTANT_FLAG_DOCKER_SANDBOX,
			rawFeatures?.dockerSandbox,
			"features.dockerSandbox",
			DEFAULT_FEATURE_FLAGS.dockerSandbox,
		),
	};

	return {
		configPath,
		workspace: {
			workspaceDir,
			notesDir,
			rawPdfsDir,
		},
		models: {
			main: {
				provider,
				model,
				thinking,
				baseUrl: mainBaseUrl,
				apiKeyEnv,
			},
			vision,
			judge,
		},
		search,
		ollama,
		features,
	};
}

function resolveConfigFilePath(
	explicitPath: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | undefined {
	if (explicitPath) {
		const resolved = isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath);
		if (!existsSync(resolved)) {
			throw new AssistantConfigError(`Config file not found: ${resolved}`);
		}
		return resolved;
	}

	const envPath = readNonEmptyEnv(env.PI_ASSISTANT_CONFIG);
	if (envPath) {
		const resolved = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
		if (!existsSync(resolved)) {
			throw new AssistantConfigError(`Config file from PI_ASSISTANT_CONFIG not found: ${resolved}`);
		}
		return resolved;
	}

	const cwdCandidate = resolve(cwd, DEFAULT_CONFIG_FILENAME);
	if (existsSync(cwdCandidate)) {
		return cwdCandidate;
	}

	const appCandidate = resolve(APP_ROOT, DEFAULT_CONFIG_FILENAME);
	if (existsSync(appCandidate)) {
		return appCandidate;
	}

	return undefined;
}

function readConfigFile(configPath: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new AssistantConfigError(`Failed to parse JSON config at ${configPath}: ${message}`);
	}

	if (!isPlainObject(parsed)) {
		throw new AssistantConfigError(`Config file ${configPath} must contain a JSON object at top level.`);
	}
	return parsed;
}

function resolveRequiredWorkspaceDir(
	cliWorkspaceDir: string | undefined,
	envWorkspaceDir: string | undefined,
	rawWorkspace: Record<string, unknown> | undefined,
	cwd: string,
	configBaseDir: string,
): string {
	if (cliWorkspaceDir && cliWorkspaceDir.trim().length > 0) {
		return resolve(cwd, cliWorkspaceDir.trim());
	}
	const fromEnv = readNonEmptyEnv(envWorkspaceDir);
	if (fromEnv) {
		return resolve(cwd, fromEnv);
	}
	const fromConfig = readOptionalString(rawWorkspace?.workspaceDir, "workspace.workspaceDir");
	if (fromConfig) {
		return resolve(configBaseDir, fromConfig);
	}
	throw new AssistantConfigError(
		[
			"Missing required workspaceDir configuration.",
			"Configure workspace.workspaceDir in assistant.config.json (see apps/personal-assistant/assistant.config.example.json),",
			"pass --workspace <dir>, or set PI_ASSISTANT_WORKSPACE.",
		].join(" "),
	);
}

function resolveOptionalPath(
	envValue: string | undefined,
	configValue: unknown,
	fieldName: string,
	cwd: string,
	configBaseDir: string,
): string | undefined {
	const fromEnv = readNonEmptyEnv(envValue);
	if (fromEnv) {
		return resolve(cwd, fromEnv);
	}
	const fromConfig = readOptionalString(configValue, fieldName);
	if (fromConfig) {
		return resolve(configBaseDir, fromConfig);
	}
	return undefined;
}

function parseOptionalApiProvider(value: unknown, fieldName: string): OptionalApiProviderConfig | undefined {
	const record = readOptionalRecord(value, fieldName);
	if (!record) return undefined;
	const config: OptionalApiProviderConfig = {
		provider: readOptionalString(record.provider, `${fieldName}.provider`),
		baseUrl: readOptionalString(record.baseUrl, `${fieldName}.baseUrl`),
		apiKeyEnv: readOptionalString(record.apiKeyEnv, `${fieldName}.apiKeyEnv`),
		model: readOptionalString(record.model, `${fieldName}.model`),
	};
	if (!config.provider && !config.baseUrl && !config.apiKeyEnv && !config.model) {
		return undefined;
	}
	return config;
}

function parseOptionalSearch(value: unknown, fieldName: string): OptionalSearchConfig | undefined {
	const record = readOptionalRecord(value, fieldName);
	if (!record) return undefined;
	const config: OptionalSearchConfig = {
		provider: readOptionalString(record.provider, `${fieldName}.provider`),
		baseUrl: readOptionalString(record.baseUrl, `${fieldName}.baseUrl`),
		apiKeyEnv: readOptionalString(record.apiKeyEnv, `${fieldName}.apiKeyEnv`),
	};
	if (!config.provider && !config.baseUrl && !config.apiKeyEnv) {
		return undefined;
	}
	return config;
}

function parseThinkingLevel(value: string): ThinkingLevel {
	if (VALID_THINKING_LEVELS.includes(value as ThinkingLevel)) {
		return value as ThinkingLevel;
	}
	throw new AssistantConfigError(
		`Invalid thinking level "${value}". Expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`,
	);
}

function resolveFeatureFlag(
	envValue: string | undefined,
	configValue: unknown,
	fieldName: string,
	defaultValue: boolean,
): boolean {
	const fromEnv = readNonEmptyEnv(envValue);
	if (fromEnv !== undefined) {
		const normalized = fromEnv.toLowerCase();
		if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
			return true;
		}
		if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
			return false;
		}
		throw new AssistantConfigError(`Invalid boolean value "${fromEnv}" for ${fieldName} env override.`);
	}
	if (configValue === undefined || configValue === null) {
		return defaultValue;
	}
	if (typeof configValue !== "boolean") {
		throw new AssistantConfigError(`Expected boolean for ${fieldName}, got ${typeof configValue}.`);
	}
	return configValue;
}

function readOptionalRecord(value: unknown, fieldName: string): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isPlainObject(value)) {
		throw new AssistantConfigError(`Expected object for ${fieldName}.`);
	}
	return value;
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new AssistantConfigError(`Expected string for ${fieldName}, got ${typeof value}.`);
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readNonEmptyEnv(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
