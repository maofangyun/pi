// Milestone 5 unit tests: Windows Docker sandbox argument boundaries & path mapping,
// 4-layer runtime resilience (idle watchdog, duplicate fingerprint breaker, death-spiral prevention),
// single-file interactive HTML report generator/validator, /doctor diagnostics, and /promote-skill.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	ToolCallEvent,
	ToolDefinition,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { formatDoctorReport, runDoctorChecks } from "../src/commands/doctor.ts";
import { attachPromoteSkillCommand, buildPromoteSkillDraft } from "../src/commands/promote-skill.ts";
import { loadAssistantConfig } from "../src/config.ts";
import type { AssistantRuntime } from "../src/extension.ts";
import {
	attachResilienceModule,
	computeExponentialBackoffMs,
	computeToolCallFingerprint,
	isTransientProviderError,
} from "../src/runtime/resilience.ts";
import {
	attachDockerSandboxTool,
	buildDockerRunArgs,
	DEFAULT_SANDBOX_IMAGE,
	type DockerProcessRunner,
	DockerSandboxExecutor,
	formatDockerExecResult,
	mapContainerToHostPath,
	mapHostToContainerPath,
	toDockerHostPath,
} from "../src/sandbox/docker-executor.ts";
import { HitlAuditStore } from "../src/tools/hitl.ts";
import {
	attachHtmlReportTool,
	generateInteractiveHtmlReport,
	validateInteractiveHtmlReport,
} from "../src/tools/html-report.ts";
import { initWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function createTestRuntime(overrides?: Record<string, string>): AssistantRuntime {
	const root = createTempDir("pa-m5-");
	const config = loadAssistantConfig({
		cwd: root,
		env: {
			PI_ASSISTANT_WORKSPACE: join(root, "ws"),
			...overrides,
		},
	});
	const { paths } = initWorkspace(config.workspace);
	return { config, workspace: paths };
}

function createHarness() {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const tools = new Map<string, ToolDefinition>();

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands.set(name, options.handler);
		},
		registerTool(tool: ToolDefinition) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		async emit(event: string, payload: unknown, ctx: unknown) {
			let last: unknown;
			for (const h of handlers.get(event) ?? []) {
				const res = await h(payload, ctx);
				if (res !== undefined) last = res;
			}
			return last;
		},
		async runCommand(name: string, args: string, ctx: unknown) {
			const fn = commands.get(name);
			if (!fn) throw new Error(`Missing command: ${name}`);
			await fn(args, ctx);
		},
		getTool(name: string) {
			const tool = tools.get(name);
			if (!tool) throw new Error(`Missing tool: ${name}`);
			return tool;
		},
	};
}

function createMockCtx(options: {
	cwd: string;
	sessionId?: string;
	hasUI?: boolean;
	selectAnswer?: string;
	onAbort?: () => void;
}) {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		cwd: options.cwd,
		hasUI: options.hasUI ?? true,
		ui: {
			async select() {
				return options.selectAnswer;
			},
			async input() {
				return "";
			},
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
		abort() {
			options.onAbort?.();
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-m5",
		},
	} as unknown as ExtensionContext & ExtensionToolContext & ExtensionCommandContext;

	return { ctx, notifications };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("M5 Windows Docker sandbox boundaries & path mapping", () => {
	it("ships a hardened non-root Python 3.12 data-analysis Dockerfile", () => {
		const dockerfilePath = fileURLToPath(new URL("../docker/sandbox/Dockerfile", import.meta.url));
		expect(existsSync(dockerfilePath)).toBe(true);
		const df = readFileSync(dockerfilePath, "utf8");
		expect(df).toContain("FROM python:3.12-slim");
		for (const pkg of ["pandas", "openpyxl", "pymupdf", "duckdb", "sympy", "matplotlib", "ruff"]) {
			expect(df).toContain(pkg);
		}
		expect(df).toContain("USER sandbox");
	});

	it("constructs hardened docker run args (:ro evidence, --network none, zero API keys, resource limits) and maps paths bidirectionally", async () => {
		const runtime = createTestRuntime();
		const taskWorkDir = join(runtime.workspace.artifactsDir, "task-01");

		// Bidirectional path mapping.
		const hostFile = join(taskWorkDir, "out", "clean.csv");
		expect(toDockerHostPath(hostFile)).not.toContain("\\");
		expect(mapHostToContainerPath(hostFile, { taskWorkDir, evidenceDir: runtime.workspace.evidenceDir })).toBe(
			"/workspace/out/clean.csv",
		);
		expect(
			mapContainerToHostPath("/workspace/out/clean.csv", {
				taskWorkDir,
				evidenceDir: runtime.workspace.evidenceDir,
			}),
		).toBe(resolve(hostFile));
		expect(
			mapContainerToHostPath("/workspace/../../etc/passwd", {
				taskWorkDir,
				evidenceDir: runtime.workspace.evidenceDir,
			}),
		).toBeUndefined();

		const { args } = buildDockerRunArgs(
			runtime.workspace,
			{
				image: DEFAULT_SANDBOX_IMAGE,
				cpus: "2",
				memory: "2g",
				pidsLimit: 128,
				defaultTimeoutMs: 60_000,
				maxTimeoutMs: 300_000,
				taskWorkDir,
				mountKnowledgeRw: false,
			},
			{ command: "python clean.py" },
		);

		const joined = args.join(" ");
		expect(joined).toContain("--network none");
		expect(joined).toContain(":/evidence:ro");
		expect(joined).toContain(":/workspace:rw");
		expect(joined).toContain("--cpus 2");
		expect(joined).toContain("--memory 2g");
		expect(joined).toContain("--pids-limit 128");
		expect(joined).toContain("--cap-drop=ALL");
		expect(joined).toContain("--read-only");
		expect(joined).not.toContain("DEEPSEEK_API_KEY");
		expect(joined).not.toContain(".ssh");

		// Timeout kills container cleanly and formats structured tail output.
		const killedContainers: string[] = [];
		const mockRunner: DockerProcessRunner = {
			async run() {
				return {
					exitCode: null,
					stdout: "processing row 100...\nprocessing row 200...",
					stderr: "",
					timedOut: true,
				};
			},
			killContainer(_bin, name) {
				killedContainers.push(name);
			},
		};

		const executor = new DockerSandboxExecutor(runtime.workspace, { taskWorkDir }, { runner: mockRunner });
		const timeoutRes = await executor.execute({ command: "while true; do :; done", timeoutMs: 2000 });
		expect(timeoutRes.ok).toBe(false);
		expect(timeoutRes.timedOut).toBe(true);
		expect(killedContainers).toEqual([timeoutRes.containerName]);
		const formatted = formatDockerExecResult(timeoutRes);
		expect(formatted).toContain("Docker 沙箱超时终止");
		expect(formatted).toContain("processing row 200...");

		// allow_network=true requires explicit HITL approval before enabling bridge network.
		const harness = createHarness();
		const hitl = new HitlAuditStore(runtime.workspace.feedbackDir);
		const capturedRunArgs: string[][] = [];
		attachDockerSandboxTool(harness.pi, runtime, hitl, {
			runner: {
				async run(_bin, runArgs) {
					capturedRunArgs.push(runArgs);
					return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
				},
				killContainer() {},
			},
		});

		const bashTool = harness.getTool("bash");
		const { ctx: rejectCtx } = createMockCtx({ cwd: runtime.workspace.root, selectAnswer: "拒绝 (Reject)" });
		const rejected = await bashTool.execute(
			"b1",
			{ command: "curl https://example.com", allow_network: true },
			undefined,
			undefined,
			rejectCtx,
		);
		expect(rejected.content[0].type === "text" ? rejected.content[0].text : "").toContain("已被用户拒绝");
		expect(capturedRunArgs).toHaveLength(0);

		const { ctx: approveCtx } = createMockCtx({ cwd: runtime.workspace.root, selectAnswer: "批准执行 (Approve)" });
		await bashTool.execute(
			"b2",
			{ command: "curl https://example.com", allow_network: true },
			undefined,
			undefined,
			approveCtx,
		);
		expect(capturedRunArgs[0]).toContain("bridge");
	});
});

describe("M5 Four-layer failure resilience", () => {
	it("trips duplicate fingerprint breaker at 3 identical failures, fires idle watchdog, and marks abnormal exit on provider error", async () => {
		expect(computeToolCallFingerprint("bash", { a: 1, b: 2 })).toBe(
			computeToolCallFingerprint("bash", { b: 2, a: 1 }),
		);
		expect(isTransientProviderError(429)).toBe(true);
		expect(isTransientProviderError("503 Service Unavailable")).toBe(true);
		expect(isTransientProviderError(400)).toBe(false);
		expect(computeExponentialBackoffMs(3, 1000, 30_000)).toBe(4000);

		const harness = createHarness();
		let abortedCount = 0;
		const resilience = attachResilienceModule(harness.pi, {
			idleTimeoutMs: 40,
			maxDuplicateFailures: 3,
		});
		const { ctx, notifications } = createMockCtx({
			cwd: process.cwd(),
			onAbort: () => {
				abortedCount += 1;
			},
		});

		// 1. Streaming idle watchdog aborts stalled stream.
		await harness.emit("agent_start", { type: "agent_start" }, ctx);
		await new Promise((r) => setTimeout(r, 80));
		expect(abortedCount).toBe(1);
		expect(resilience.abnormalExit.isAbnormal()).toBe(true);

		// 2. Duplicate tool-call fingerprint loop breaker trips after 3 consecutive identical failures.
		await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(resilience.abnormalExit.isAbnormal()).toBe(false);

		const sameInput = { command: "python missing.py" };
		for (let i = 0; i < 3; i++) {
			const allow = await harness.emit(
				"tool_call",
				{ type: "tool_call", toolCallId: `d${i}`, toolName: "bash", input: sameInput } as unknown as ToolCallEvent,
				ctx,
			);
			expect(allow).toBeUndefined();
			await harness.emit(
				"tool_result",
				{
					type: "tool_result",
					toolCallId: `d${i}`,
					toolName: "bash",
					input: sameInput,
					content: [{ type: "text", text: "No such file" }],
					isError: true,
				} as unknown as ToolResultEvent,
				ctx,
			);
		}

		const blocked4th = (await harness.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: "d4", toolName: "bash", input: sameInput } as unknown as ToolCallEvent,
			ctx,
		)) as { block?: boolean; reason?: string };
		expect(blocked4th?.block).toBe(true);
		expect(blocked4th?.reason).toContain("重复调用指纹熔断");
		expect(resilience.abnormalExit.isAbnormal()).toBe(true);

		// 3. Main model error pauses & reports without switching vendors.
		resilience.abnormalExit.clear();
		await harness.emit(
			"agent_end",
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: "deepseek",
						model: "deepseek-v4-pro",
						stopReason: "error",
						errorMessage: "429 rate limit exceeded after retries",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					},
				],
			},
			ctx,
		);
		expect(resilience.abnormalExit.isAbnormal()).toBe(true);
		expect(notifications.some((n) => n.message.includes("不做跨厂商自动接管"))).toBe(true);
	});
});

describe("M5 Single-file interactive HTML report generator & validator", () => {
	it("generates offline self-contained HTML from JSON data and catches CDN/JSON/JS violations deterministically", async () => {
		const html = generateInteractiveHtmlReport({
			title: "2026 Q3 财务清洗报告",
			subtitle: "数据来源：沙箱 Python 清洗脚本",
			kpis: [
				{ label: "有效订单", value: "1,280", delta: "+12.4%" },
				{ label: "总金额", value: "￥458,200.00" },
			],
			charts: [
				{
					title: "月度营收趋势",
					type: "bar",
					labels: ["7月", "8月", "9月"],
					values: [120, 155, 183],
					unit: "万元",
				},
			],
			table: {
				title: "部门汇总",
				columns: ["部门", "金额", "备注"],
				rows: [
					{ 部门: "研发", 金额: "210000.00", 备注: "含 </script> 安全转义测试" },
					{ 部门: "运营", 金额: "148200.00", 备注: "已核对" },
				],
			},
			methodologyNotes: ["所有金额保留两位小数", "导出 CSV 使用 UTF-8-BOM"],
		});

		const valid = validateInteractiveHtmlReport(html);
		expect(valid.ok).toBe(true);
		expect(valid.hasEmbeddedDataJson).toBe(true);
		expect(valid.errors).toEqual([]);

		// Validator rejects external CDN script and broken JS syntax.
		const badCdn =
			'<!DOCTYPE html><html><body><script src="https://cdn.example.com/chart.js"></script></body></html>';
		expect(validateInteractiveHtmlReport(badCdn).ok).toBe(false);

		const badJs = "<!DOCTYPE html><html><body><script>function broken( {</script></body></html>";
		expect(validateInteractiveHtmlReport(badJs).ok).toBe(false);

		// End-to-end tool reading JSON produced by script and emitting validated HTML file.
		const runtime = createTestRuntime();
		const dataJsonPath = join(runtime.workspace.artifactsDir, "summary.json");
		const outHtmlPath = join(runtime.workspace.artifactsDir, "report.html");
		writeFileSync(
			dataJsonPath,
			JSON.stringify({
				kpis: [{ label: "总行数", value: "500" }],
				table: { columns: ["id", "amount"], rows: [{ id: 1, amount: "99.50" }] },
			}),
			"utf8",
		);

		const harness = createHarness();
		attachHtmlReportTool(harness.pi);
		const tool = harness.getTool("generate_html_report");
		const { ctx } = createMockCtx({ cwd: runtime.workspace.root });
		const res = await tool.execute(
			"h1",
			{ output_path: outHtmlPath, title: "清洗结果报告", data_json_path: dataJsonPath },
			undefined,
			undefined,
			ctx,
		);
		expect(res.content[0].type === "text" ? res.content[0].text : "").toContain("通过确定性校验");
		expect(existsSync(outHtmlPath)).toBe(true);
		expect(readFileSync(outHtmlPath, "utf8")).toContain("99.50");
	});
});

describe("M5 /doctor diagnostics and /promote-skill crystallization", () => {
	it("/doctor accurately detects stopped Ollama, stopped Docker, missing key, and optional unconfigured APIs", async () => {
		const runtime = createTestRuntime();

		// Failure case: missing DEEPSEEK_API_KEY, Ollama down, Docker down.
		const failingReport = await runDoctorChecks(runtime, {
			env: {},
			ollamaClient: {
				embed: async () => [],
				rerank: async () => [],
				healthCheck: async () => ({
					reachable: false,
					baseUrl: "http://127.0.0.1:11434",
					installedModels: [],
					missingModels: ["bge-m3"],
					error: "ECONNREFUSED",
				}),
			},
			dockerProbe: () => ({ daemonRunning: false, imageExists: false, error: "Docker Desktop stopped" }),
		});

		expect(failingReport.overallOk).toBe(false);
		expect(failingReport.items.find((i) => i.id === "deepseek")?.status).toBe("fail");
		expect(failingReport.items.find((i) => i.id === "ollama")?.status).toBe("fail");
		expect(failingReport.items.find((i) => i.id === "docker")?.status).toBe("fail");
		expect(failingReport.items.find((i) => i.id === "vision")?.status).toBe("unconfigured");
		expect(formatDoctorReport(failingReport)).toContain("[FAIL]");
		expect(formatDoctorReport(failingReport)).toContain("[OPT]");

		// All-green case (optional providers unconfigured still yields overallOk=true).
		const healthyReport = await runDoctorChecks(runtime, {
			env: { DEEPSEEK_API_KEY: "ds-live-test" },
			ollamaClient: {
				embed: async () => [],
				rerank: async () => [],
				healthCheck: async () => ({
					reachable: true,
					baseUrl: "http://127.0.0.1:11434",
					installedModels: ["bge-m3", "bge-reranker-v2-m3", "qwen2.5:3b"],
					missingModels: [],
				}),
			},
			dockerProbe: () => ({ daemonRunning: true, imageExists: true }),
		});
		expect(healthyReport.overallOk).toBe(true);
		expect(formatDoctorReport(healthyReport)).toContain("PASS");
	});

	it("/promote-skill requires human approval before writing parameterized script and SKILL.md into workspace skills/", async () => {
		const runtime = createTestRuntime();
		const scriptPath = join(runtime.workspace.artifactsDir, "clean_finance.py");
		writeFileSync(scriptPath, 'import sys\nprint("cleaned")\n', "utf8");

		const draft = buildPromoteSkillDraft({
			skillName: "Finance CSV Clean!",
			description: "清洗财务 CSV 并输出 UTF-8-BOM 与 HTML 报告",
			sourceScriptPath: scriptPath,
			skillsRootDir: runtime.workspace.skillsDir,
		});
		expect(draft.skillName).toBe("finance-csv-clean");
		expect(draft.skillMarkdown).toContain("name: finance-csv-clean");
		expect(draft.skillMarkdown).toContain("回退给完整 Agent");

		const harness = createHarness();
		const hitl = new HitlAuditStore(runtime.workspace.feedbackDir);
		attachPromoteSkillCommand(harness.pi, runtime, hitl);

		// Reject -> must not write files.
		const { ctx: rejectCtx } = createMockCtx({ cwd: runtime.workspace.root, selectAnswer: "拒绝 (Reject)" });
		await harness.runCommand("promote-skill", `finance-csv-clean ${scriptPath} 清洗月度报表`, rejectCtx);
		expect(existsSync(draft.targetSkillMdPath)).toBe(false);

		// Approve -> writes both SKILL.md and scripts/clean_finance.py.
		const { ctx: approveCtx } = createMockCtx({ cwd: runtime.workspace.root, selectAnswer: "批准执行 (Approve)" });
		await harness.runCommand("promote-skill", `finance-csv-clean ${scriptPath} 清洗月度报表`, approveCtx);
		expect(existsSync(draft.targetSkillMdPath)).toBe(true);
		expect(existsSync(draft.targetScriptPath)).toBe(true);
		expect(readFileSync(draft.targetScriptPath, "utf8")).toContain('print("cleaned")');
	});
});
