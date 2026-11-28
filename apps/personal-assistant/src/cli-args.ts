// Pure CLI argument parsing and pi launch argument construction for the personal assistant.

import type { AssistantConfig } from "./config.ts";
import type { WorkspacePaths } from "./workspace.ts";

export type ParsedAssistantCli =
	| { kind: "help" }
	| {
			kind: "subcommand";
			name: "doctor" | "eval";
			args: string[];
			configPath?: string;
			workspaceDir?: string;
	  }
	| {
			kind: "launch";
			initOnly: boolean;
			configPath?: string;
			workspaceDir?: string;
			piArgs: string[];
	  };

/** Parse assistant-specific flags while preserving all pi CLI arguments intact. */
export function parseAssistantCliArgs(argv: string[]): ParsedAssistantCli {
	let configPath: string | undefined;
	let workspaceDir: string | undefined;
	let initOnly = false;
	const piArgs: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--assistant-help") {
			return { kind: "help" };
		}
		if (arg === "--config" && i + 1 < argv.length) {
			configPath = argv[++i];
			continue;
		}
		if (arg === "--workspace" && i + 1 < argv.length) {
			workspaceDir = argv[++i];
			continue;
		}
		if (arg === "--init") {
			initOnly = true;
			continue;
		}
		if (piArgs.length === 0 && (arg === "doctor" || arg === "eval")) {
			return {
				kind: "subcommand",
				name: arg,
				args: argv.slice(i + 1),
				configPath,
				workspaceDir,
			};
		}
		piArgs.push(arg);
	}

	return {
		kind: "launch",
		initOnly,
		configPath,
		workspaceDir,
		piArgs,
	};
}

/** Build the final argument vector passed to pi's main() without overriding explicit user flags. */
export function buildPiLaunchArgs(
	config: AssistantConfig,
	workspace: WorkspacePaths,
	userPiArgs: string[],
	skillDirs: string[],
): string[] {
	const args: string[] = [];

	const hasSessionDir = hasAnyFlag(userPiArgs, ["--session-dir", "--no-session"]);
	if (!hasSessionDir) {
		args.push("--session-dir", workspace.sessionsDir);
	}

	if (!hasAnyFlag(userPiArgs, ["--provider"])) {
		args.push("--provider", config.models.main.provider);
	}

	if (!hasAnyFlag(userPiArgs, ["--model"])) {
		args.push("--model", config.models.main.model);
	}

	if (!hasAnyFlag(userPiArgs, ["--thinking"])) {
		args.push("--thinking", config.models.main.thinking);
	}

	if (!hasAnyFlag(userPiArgs, ["--no-skills", "-ns"])) {
		for (const dir of skillDirs) {
			args.push("--skill", dir);
		}
	}

	args.push(...userPiArgs);
	return args;
}

function hasAnyFlag(args: string[], names: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--") break;
		if (names.includes(arg)) return true;
	}
	return false;
}
