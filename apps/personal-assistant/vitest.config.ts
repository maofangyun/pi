import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const repoPath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
				{ find: /^@earendil-works\/pi-schema$/, replacement: repoPath("../../packages/schema/src/index.ts") },
				{
					find: /^@earendil-works\/pi-schema\/formats$/,
					replacement: repoPath("../../packages/schema/src/formats/index.ts"),
				},
				{ find: /^@earendil-works\/pi-env$/, replacement: repoPath("../../packages/env/src/index.ts") },
			],
		},
	}),
);
