#!/usr/bin/env node
// CLI launcher for the personal assistant built on top of pi's interactive TUI and SDK.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSummaryWithUsage, main as runPiMain } from "@earendil-works/pi-coding-agent";
import { runRagEvalCli } from "../evals/rag/run-rag-eval.ts";
import { buildPiLaunchArgs, parseAssistantCliArgs } from "./cli-args.ts";
import { formatDoctorReport, runDoctorChecks } from "./commands/doctor.ts";
import { type AssistantConfig, AssistantConfigError, loadAssistantConfig } from "./config.ts";
import type { L3SummaryRequest } from "./context/compaction.ts";
import { createPersonalAssistantExtension } from "./extension.ts";
import { initWorkspace, resolveWorkspacePaths } from "./workspace.ts";

export { buildPiLaunchArgs, type ParsedAssistantCli, parseAssistantCliArgs } from "./cli-args.ts";

const APP_SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** Run the personal assistant CLI. */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
	const parsed = parseAssistantCliArgs(argv);

	if (parsed.kind === "help") {
		printHelp();
		return;
	}

	if (parsed.kind === "subcommand") {
		if (parsed.name === "doctor") {
			let config: AssistantConfig;
			try {
				config = loadAssistantConfig({
					configPath: parsed.configPath,
					workspaceDir: parsed.workspaceDir,
				});
			} catch (error) {
				if (error instanceof AssistantConfigError) {
					console.error(`Configuration Error: ${error.message}`);
					process.exitCode = 1;
					return;
				}
				throw error;
			}
			const workspace = resolveWorkspacePaths(config.workspace);
			const report = await runDoctorChecks(
				{ config, workspace },
				{ checkDeepSeekLive: parsed.args.includes("--live") },
			);
			console.log(formatDoctorReport(report));
			if (!report.overallOk) {
				process.exitCode = 1;
			}
			return;
		}
		if (parsed.name === "eval") {
			const evalArgs = [...parsed.args];
			if (parsed.workspaceDir && !evalArgs.includes("--workspace")) {
				evalArgs.push("--workspace", parsed.workspaceDir);
			}
			await runRagEvalCli(evalArgs);
			return;
		}
		return;
	}

	let config: AssistantConfig;
	try {
		config = loadAssistantConfig({
			configPath: parsed.configPath,
			workspaceDir: parsed.workspaceDir,
		});
	} catch (error) {
		if (error instanceof AssistantConfigError) {
			console.error(`Configuration Error: ${error.message}`);
			process.exitCode = 1;
			return;
		}
		throw error;
	}

	const initialized = initWorkspace(config.workspace);

	if (parsed.initOnly) {
		console.log(`Initialized personal assistant workspace at: ${initialized.paths.root}`);
		console.log(`  evidence/sessions: ${initialized.paths.sessionsDir}`);
		console.log(`  knowledge (Git ${initialized.gitBranch ?? "unknown"}): ${initialized.paths.knowledgeDir}`);
		console.log(`  index: ${initialized.paths.indexDir}`);
		return;
	}

	const skillDirs = [APP_SKILLS_DIR, initialized.paths.skillsDir].filter((dir) => existsSync(dir));
	const launchArgs = buildPiLaunchArgs(config, initialized.paths, parsed.piArgs, skillDirs);
	const extension = createPersonalAssistantExtension(
		{
			config,
			workspace: initialized.paths,
		},
		{
			compaction: {
				summarizer: (request: L3SummaryRequest) =>
					generateSummaryWithUsage(
						request.messages,
						request.model,
						request.reserveTokens,
						request.apiKey,
						request.headers,
						request.signal,
						request.customInstructions,
						request.previousSummary,
						request.thinkingLevel,
						undefined,
						undefined,
						undefined,
						undefined,
						request.sessionId,
					),
			},
		},
	);

	await runPiMain(launchArgs, { extensionFactories: [extension] });
}

function printHelp(): void {
	console.log(
		[
			"Usage: pi-assistant [assistant-options] [pi-options]",
			"",
			"Assistant options:",
			"  --config <path>      Path to assistant.config.json (or set PI_ASSISTANT_CONFIG)",
			"  --workspace <dir>    Path to workspace directory (or set PI_ASSISTANT_WORKSPACE)",
			"  --init               Initialize three-layer workspace and knowledge Git repo, then exit",
			"  --assistant-help     Show this help message",
			"",
			"Reserved subcommands:",
			"  doctor               Environment diagnostics (Milestone 5)",
			"  eval                 Run RAG / Agent evaluation suites (Milestone 7)",
			"",
			"All other flags (e.g. --model, --thinking, --continue, --resume, --print) are forwarded to pi.",
		].join("\n"),
	);
}

const isDirectEntry =
	process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
	await runCli();
}
