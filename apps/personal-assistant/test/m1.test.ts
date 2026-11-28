// Milestone 1 unit tests: config loading, ablation flags, workspace initialization, DeepSeek compat, and CLI routing.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiLaunchArgs, parseAssistantCliArgs } from "../src/cli-args.ts";
import {
	AssistantConfigError,
	DEFAULT_FEATURE_FLAGS,
	DEFAULT_MAIN_MODEL_CONFIG,
	loadAssistantConfig,
} from "../src/config.ts";
import { attachAssistantExtension, formatAssistantStatus, registerDeepSeekCompatIfNeeded } from "../src/extension.ts";
import { initWorkspace, resolveWorkspacePaths } from "../src/workspace.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M1 config loading and ablation feature flags", () => {
	it("requires explicit workspaceDir instead of assuming a hardcoded path", () => {
		const cwd = createTempDir("pa-config-empty-");
		expect(() => loadAssistantConfig({ cwd, env: {} })).toThrowError(AssistantConfigError);
	});

	it("loads JSON config with relative paths, defaults, and empty optional providers", () => {
		const root = createTempDir("pa-config-file-");
		const configDir = join(root, "cfg");
		mkdirSync(configDir, { recursive: true });
		const configPath = join(configDir, "assistant.config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				workspace: {
					workspaceDir: "../my-workspace",
					notesDir: "../external-notes",
				},
				models: {
					main: {
						provider: "deepseek",
						model: "deepseek-reasoner",
						thinking: "high",
					},
					vision: null,
					judge: null,
				},
				search: null,
				features: {
					reranker: false,
					sidecar: false,
				},
			}),
			"utf8",
		);

		const config = loadAssistantConfig({ configPath, cwd: root, env: {} });

		expect(config.configPath).toBe(configPath);
		expect(config.workspace.workspaceDir).toBe(resolve(configDir, "../my-workspace"));
		expect(config.workspace.notesDir).toBe(resolve(configDir, "../external-notes"));
		expect(config.workspace.rawPdfsDir).toBeUndefined();
		expect(config.models.main.provider).toBe("deepseek");
		expect(config.models.main.model).toBe("deepseek-reasoner");
		expect(config.models.main.thinking).toBe("high");
		expect(config.models.vision).toBeUndefined();
		expect(config.models.judge).toBeUndefined();
		expect(config.search).toBeUndefined();
		expect(config.features).toEqual({
			...DEFAULT_FEATURE_FLAGS,
			reranker: false,
			sidecar: false,
		});
	});

	it("applies environment overrides for workspace, model, ollama, and ablation flags", () => {
		const cwd = createTempDir("pa-config-env-");
		const config = loadAssistantConfig({
			cwd,
			env: {
				PI_ASSISTANT_WORKSPACE: "./ws",
				PI_ASSISTANT_MODEL: "deepseek-flash",
				PI_ASSISTANT_THINKING: "medium",
				DEEPSEEK_BASE_URL: "https://proxy.deepseek.local/v1",
				OLLAMA_BASE_URL: "http://127.0.0.1:22434",
				PI_ASSISTANT_FLAG_STATUS_BAR: "0",
				PI_ASSISTANT_FLAG_DOCKER_SANDBOX: "false",
			},
		});

		expect(config.workspace.workspaceDir).toBe(resolve(cwd, "./ws"));
		expect(config.models.main.model).toBe("deepseek-flash");
		expect(config.models.main.thinking).toBe("medium");
		expect(config.models.main.baseUrl).toBe("https://proxy.deepseek.local/v1");
		expect(config.ollama.baseUrl).toBe("http://127.0.0.1:22434");
		expect(config.features.statusBar).toBe(false);
		expect(config.features.dockerSandbox).toBe(false);
		expect(config.features.l2MicroCompact).toBe(true);
	});

	it("rejects invalid thinking levels and non-boolean feature flags", () => {
		const cwd = createTempDir("pa-config-invalid-");
		expect(() =>
			loadAssistantConfig({
				cwd,
				env: { PI_ASSISTANT_WORKSPACE: "./ws", PI_ASSISTANT_THINKING: "turbo" },
			}),
		).toThrowError(AssistantConfigError);

		const badConfigPath = join(cwd, "bad.json");
		writeFileSync(
			badConfigPath,
			JSON.stringify({
				workspace: { workspaceDir: "./ws" },
				features: { sidecar: "yes" },
			}),
			"utf8",
		);
		expect(() => loadAssistantConfig({ configPath: badConfigPath, cwd, env: {} })).toThrowError(AssistantConfigError);
	});
});

describe("M1 three-layer workspace initialization", () => {
	it("creates evidence, knowledge (Git repo), and index directories idempotently", () => {
		const root = createTempDir("pa-ws-");
		const workspaceDir = join(root, "assistant-workspace");

		const first = initWorkspace({ workspaceDir });
		expect(first.gitInitialized).toBe(true);
		expect(first.createdDirs.length).toBeGreaterThan(0);

		for (const dir of [
			first.paths.sessionsDir,
			first.paths.rawPdfsDir,
			first.paths.artifactsDir,
			first.paths.tracesDir,
			first.paths.feedbackDir,
			first.paths.profileDir,
			first.paths.eventsDir,
			first.paths.experienceDir,
			first.paths.notesDir,
			first.paths.indexDir,
			first.paths.backupsDir,
			first.paths.skillsDir,
		]) {
			expect(existsSync(dir)).toBe(true);
		}

		expect(existsSync(join(first.paths.knowledgeDir, ".git"))).toBe(true);
		expect(existsSync(first.paths.notesIndexFile)).toBe(true);
		expect(readFileSync(join(first.paths.root, ".gitignore"), "utf8")).toContain("index/");
		expect(readFileSync(join(first.paths.knowledgeDir, ".gitignore"), "utf8")).toContain("index/");

		const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd: first.paths.knowledgeDir,
			encoding: "utf8",
		}).trim();
		expect(head.length).toBe(40);

		// Customize _index.md and verify second run is idempotent and preserves user content.
		writeFileSync(first.paths.notesIndexFile, "# Custom Index\n", "utf8");
		const second = initWorkspace({ workspaceDir });
		expect(second.gitInitialized).toBe(false);
		expect(second.createdDirs).toEqual([]);
		expect(readFileSync(first.paths.notesIndexFile, "utf8")).toBe("# Custom Index\n");
	});

	it("respects external notesDir and rawPdfsDir without modifying external notesDir", () => {
		const root = createTempDir("pa-ws-ext-");
		const externalNotes = join(root, "my-obsidian");
		const externalPdfs = join(root, "my-pdfs");
		mkdirSync(externalNotes, { recursive: true });
		mkdirSync(externalPdfs, { recursive: true });

		const result = initWorkspace({
			workspaceDir: join(root, "ws"),
			notesDir: externalNotes,
			rawPdfsDir: externalPdfs,
		});

		expect(result.paths.notesDir).toBe(resolve(externalNotes));
		expect(result.paths.rawPdfsDir).toBe(resolve(externalPdfs));
		expect(existsSync(join(externalNotes, "_index.md"))).toBe(false);
	});
});

describe("M1 extension hooks and DeepSeek compatibility", () => {
	function createFakeExtensionApi() {
		const providers = new Map<string, ProviderConfig>();
		const commands: string[] = [];
		const tools: string[] = [];
		const events: string[] = [];

		const pi = {
			registerProvider(nameOrProvider: string | { id: string }, config?: ProviderConfig) {
				if (typeof nameOrProvider === "string" && config) {
					providers.set(nameOrProvider, config);
				}
			},
			registerCommand(name: string) {
				commands.push(name);
			},
			registerTool(tool: { name: string }) {
				tools.push(tool.name);
			},
			appendEntry() {},
			getActiveTools() {
				return tools;
			},
			on(event: string) {
				events.push(event);
				return () => {};
			},
		} as unknown as ExtensionAPI;

		return { pi, providers, commands, tools, events };
	}

	it("keeps built-in DeepSeek catalog untouched for default deepseek-v4-pro", () => {
		const { pi, providers } = createFakeExtensionApi();
		const registered = registerDeepSeekCompatIfNeeded(pi, { ...DEFAULT_MAIN_MODEL_CONFIG });
		expect(registered).toBe(false);
		expect(providers.size).toBe(0);
	});

	it("registers DeepSeek compat with reasoning_content preservation for deepseek-reasoner or custom baseUrl", () => {
		const { pi, providers } = createFakeExtensionApi();
		const registered = registerDeepSeekCompatIfNeeded(pi, {
			...DEFAULT_MAIN_MODEL_CONFIG,
			model: "deepseek-reasoner",
			baseUrl: "https://api.deepseek.com",
		});

		expect(registered).toBe(true);
		const providerConfig = providers.get("deepseek");
		expect(providerConfig).toBeDefined();
		expect(providerConfig?.baseUrl).toBe("https://api.deepseek.com");
		expect(providerConfig?.api).toBe("openai-completions");

		const reasoner = providerConfig?.models?.find((m) => m.id === "deepseek-reasoner");
		expect(reasoner).toBeDefined();
		expect(reasoner?.type !== "image" && reasoner?.type !== "classifier" ? reasoner?.reasoning : false).toBe(true);
		if (reasoner && reasoner.type !== "image" && reasoner.type !== "classifier") {
			// DeepSeek models use openai-completions compat fields.
			const compat = reasoner.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.thinkingFormat).toBe("deepseek");
			expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		}
	});

	it("attaches session_start hook, /assistant-status command, and formats runtime status", () => {
		const cwd = createTempDir("pa-ext-");
		const config = loadAssistantConfig({ cwd, env: { PI_ASSISTANT_WORKSPACE: "./ws" } });
		const workspace = resolveWorkspacePaths(config.workspace);
		const { pi, commands, events } = createFakeExtensionApi();

		attachAssistantExtension(pi, { config, workspace });

		expect(events).toContain("session_start");
		expect(commands).toContain("assistant-status");

		const summary = formatAssistantStatus({ config, workspace }).join("\n");
		expect(summary).toContain("deepseek/deepseek-v4-pro");
		expect(summary).toContain("vision=未配置");
		expect(summary).toContain("statusBar=true");
	});
});

describe("M1 CLI parsing and pi launch argument routing", () => {
	it("parses assistant options, reserved subcommands, and forwards pi flags", () => {
		expect(parseAssistantCliArgs(["--assistant-help"])).toEqual({ kind: "help" });

		expect(parseAssistantCliArgs(["--workspace", "D:/ws", "doctor", "--verbose"])).toEqual({
			kind: "subcommand",
			name: "doctor",
			args: ["--verbose"],
			configPath: undefined,
			workspaceDir: "D:/ws",
		});

		expect(parseAssistantCliArgs(["--config", "./a.json", "--init"])).toEqual({
			kind: "launch",
			initOnly: true,
			configPath: "./a.json",
			workspaceDir: undefined,
			piArgs: [],
		});

		expect(parseAssistantCliArgs(["--workspace", "./ws", "--continue", "-p", "hello"])).toEqual({
			kind: "launch",
			initOnly: false,
			configPath: undefined,
			workspaceDir: "./ws",
			piArgs: ["--continue", "-p", "hello"],
		});
	});

	it("injects default session-dir, DeepSeek model, thinking, and skills without overriding user flags", () => {
		const cwd = createTempDir("pa-cli-");
		const config = loadAssistantConfig({ cwd, env: { PI_ASSISTANT_WORKSPACE: "./ws" } });
		const workspace = resolveWorkspacePaths(config.workspace);

		const defaultArgs = buildPiLaunchArgs(config, workspace, [], ["/skills/builtin"]);
		expect(defaultArgs).toEqual([
			"--session-dir",
			workspace.sessionsDir,
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-pro",
			"--thinking",
			"high",
			"--skill",
			"/skills/builtin",
		]);

		const overriddenArgs = buildPiLaunchArgs(
			config,
			workspace,
			["--model", "deepseek-flash", "--no-session", "--no-skills"],
			["/skills/builtin"],
		);
		expect(overriddenArgs).toEqual([
			"--provider",
			"deepseek",
			"--thinking",
			"high",
			"--model",
			"deepseek-flash",
			"--no-session",
			"--no-skills",
		]);
	});
});
