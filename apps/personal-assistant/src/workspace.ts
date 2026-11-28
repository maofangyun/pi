// Three-layer workspace path resolution and idempotent initialization (evidence / knowledge[Git] / index).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { WorkspaceConfig } from "./config.ts";

export interface WorkspacePaths {
	root: string;
	evidenceDir: string;
	sessionsDir: string;
	rawPdfsDir: string;
	artifactsDir: string;
	tracesDir: string;
	feedbackDir: string;
	knowledgeDir: string;
	memoryDir: string;
	profileDir: string;
	eventsDir: string;
	experienceDir: string;
	notesDir: string;
	notesIndexFile: string;
	indexDir: string;
	ftsDbPath: string;
	vectorsDbPath: string;
	manifestPath: string;
	backupsDir: string;
	skillsDir: string;
}

export interface InitWorkspaceResult {
	paths: WorkspacePaths;
	createdDirs: string[];
	gitInitialized: boolean;
	gitBranch: string | undefined;
}

const ROOT_GITIGNORE_CONTENT = [
	"# Personal assistant derived index and runtime caches (rebuildable)",
	"index/",
	"evidence/artifacts/",
	".pi/backups/",
	"*.tmp",
	".DS_Store",
	"Thumbs.db",
	"",
].join("\n");

const KNOWLEDGE_GITIGNORE_CONTENT = [
	"# Never commit derived search indexes or temp files into knowledge Git repo",
	"index/",
	"*.tmp",
	".DS_Store",
	"Thumbs.db",
	"",
].join("\n");

const INITIAL_NOTES_INDEX_CONTENT = [
	"# 个人知识库目录索引",
	"",
	"本文件作为 `knowledge/notes/` 的 L0/L1 目录入口概览，便于助理按需导航。",
	"",
].join("\n");

/** Compute all canonical paths for the three-layer assistant workspace. */
export function resolveWorkspacePaths(workspace: WorkspaceConfig): WorkspacePaths {
	const root = resolve(workspace.workspaceDir);
	const evidenceDir = join(root, "evidence");
	const knowledgeDir = join(root, "knowledge");
	const memoryDir = join(knowledgeDir, "memory");
	const indexDir = join(root, "index");
	const notesDir = workspace.notesDir ? resolve(workspace.notesDir) : join(knowledgeDir, "notes");
	const rawPdfsDir = workspace.rawPdfsDir ? resolve(workspace.rawPdfsDir) : join(evidenceDir, "raw_pdfs");

	return {
		root,
		evidenceDir,
		sessionsDir: join(evidenceDir, "sessions"),
		rawPdfsDir,
		artifactsDir: join(evidenceDir, "artifacts"),
		tracesDir: join(evidenceDir, "traces"),
		feedbackDir: join(evidenceDir, "feedback"),
		knowledgeDir,
		memoryDir,
		profileDir: join(memoryDir, "profile"),
		eventsDir: join(memoryDir, "events"),
		experienceDir: join(knowledgeDir, "experience"),
		notesDir,
		notesIndexFile: join(notesDir, "_index.md"),
		indexDir,
		ftsDbPath: join(indexDir, "fts.sqlite"),
		vectorsDbPath: join(indexDir, "vectors.db"),
		manifestPath: join(indexDir, "manifest.json"),
		backupsDir: join(root, ".pi", "backups"),
		skillsDir: join(root, "skills"),
	};
}

/** Idempotently initialize the three-layer directory structure and knowledge/ Git repository. */
export function initWorkspace(workspace: WorkspaceConfig): InitWorkspaceResult {
	const paths = resolveWorkspacePaths(workspace);
	const requiredDirs = [
		paths.root,
		paths.evidenceDir,
		paths.sessionsDir,
		paths.rawPdfsDir,
		paths.artifactsDir,
		paths.tracesDir,
		paths.feedbackDir,
		paths.knowledgeDir,
		paths.memoryDir,
		paths.profileDir,
		paths.eventsDir,
		paths.experienceDir,
		paths.notesDir,
		paths.indexDir,
		paths.backupsDir,
		paths.skillsDir,
	];

	const createdDirs: string[] = [];
	for (const dir of requiredDirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			createdDirs.push(dir);
		}
	}

	writeFileIfMissing(join(paths.root, ".gitignore"), ROOT_GITIGNORE_CONTENT);
	writeFileIfMissing(join(paths.knowledgeDir, ".gitignore"), KNOWLEDGE_GITIGNORE_CONTENT);

	// Only seed _index.md automatically when notesDir lives inside knowledgeDir.
	if (isPathInside(paths.notesDir, paths.knowledgeDir)) {
		writeFileIfMissing(paths.notesIndexFile, INITIAL_NOTES_INDEX_CONTENT);
	}

	const { gitInitialized, gitBranch } = ensureKnowledgeGitRepo(paths.knowledgeDir);

	return {
		paths,
		createdDirs,
		gitInitialized,
		gitBranch,
	};
}

function writeFileIfMissing(filePath: string, content: string): void {
	if (!existsSync(filePath)) {
		writeFileSync(filePath, content, "utf8");
	}
}

function isPathInside(targetPath: string, parentDir: string): boolean {
	const rel = relative(parentDir, targetPath);
	return rel === "" || (!rel.startsWith("..") && !rel.includes(":") && !rel.startsWith("\\") && !rel.startsWith("/"));
}

function ensureKnowledgeGitRepo(knowledgeDir: string): { gitInitialized: boolean; gitBranch: string | undefined } {
	const gitDir = join(knowledgeDir, ".git");
	let gitInitialized = false;

	if (!existsSync(gitDir)) {
		try {
			runGit(knowledgeDir, ["init", "-b", "main"]);
		} catch {
			runGit(knowledgeDir, ["init"]);
		}
		gitInitialized = true;
	}

	if (!hasGitHead(knowledgeDir)) {
		runGit(knowledgeDir, ["add", ".gitignore"]);
		const notesIndex = join(knowledgeDir, "notes", "_index.md");
		if (existsSync(notesIndex)) {
			runGit(knowledgeDir, ["add", "notes/_index.md"]);
		}
		runGit(knowledgeDir, [
			"-c",
			"user.name=pi-assistant",
			"-c",
			"user.email=pi-assistant@local",
			"commit",
			"--allow-empty",
			"-m",
			"chore: initialize knowledge repository",
		]);
	}

	return {
		gitInitialized,
		gitBranch: readGitBranch(knowledgeDir),
	};
}

function hasGitHead(cwd: string): boolean {
	try {
		runGit(cwd, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

function readGitBranch(cwd: string): string | undefined {
	try {
		const output = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		return output.length > 0 ? output : undefined;
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
