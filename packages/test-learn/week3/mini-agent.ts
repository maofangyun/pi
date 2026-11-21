import * as fs from "node:fs/promises";
import type { Context, Message, Tool, ToolCall } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { obj, str } from "@earendil-works/pi-schema";

// 1. 定义工具（给模型看的说明书）
const toolDefinitions: Tool[] = [
	{
		name: "read_file",
		description: "读取指定路径的文件内容",
		parameters: obj({
			path: str({ description: "文件路径" }),
		}),
	},
	{
		name: "list_dir",
		description: "列出指定目录下的文件和子目录",
		parameters: obj({
			path: str({ description: "目录路径，例如 ." }),
		}),
	},
];

// 2. 工具的本地实现
async function runTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
	// TODO 3b (可选): 如果在工具执行前已经取消，直接抛出 AbortError 或提前终止
	void signal;

	if (name === "read_file") {
		if (typeof args.path !== "string") {
			throw new Error("read_file 缺少有效的 string 类型 path 参数");
		}
		return fs.readFile(args.path, { encoding: "utf8", signal });
	}

	if (name === "list_dir") {
		if (typeof args.path !== "string") {
			throw new Error("list_dir 缺少有效的 string 类型 path 参数");
		}
		const dirs = await fs.readdir(args.path, { withFileTypes: true });
		return dirs.map((dir) => dir.name).join("\n");
	}

	throw new Error(`未知工具: ${name}`);
}

export interface RunAgentOptions {
	maxTurns?: number;
	signal?: AbortSignal;
}

// 3. Agent 主循环
async function runAgent(userInput: string, options: RunAgentOptions = {}): Promise<string> {
	const maxTurns = options.maxTurns ?? 10;
	const { signal } = options;

	const models = builtinModels();
	const model = models.getModel("deepseek", "deepseek-flash");
	if (!model) {
		throw new Error("找不到 deepseek/deepseek-flash 模型");
	}

	const systemPrompt = "你是一个本地文件助手，可以调用工具查看目录和读取文件。";
	const messages: Message[] = [
		{
			role: "user",
			content: userInput,
			timestamp: Date.now(),
		},
	];

	let turn = 0;

	while (true) {
		// TODO 1: 最大轮数限制
		// 递增 turn 并检查是否超过 maxTurns，超过时退出循环（抛错或返回提示）
		turn++;
		if (turn > maxTurns) {
			throw new Error(`超过最大轮数限制 (${maxTurns})，任务中止`);
		}

		// TODO 3b: 取消检查（模型调用前）
		// 如果 signal?.aborted 为 true，抛出取消错误或返回已中止提示

		const context: Context = { systemPrompt, messages, tools: toolDefinitions };
		// 把 { signal } 作为第三个参数传给 models.complete(model, context, { signal })
		const reply = await models.complete(model, context, {signal});

		// TODO 3b: 处理取消/错误状态
		// 注意：请求被中止时 reply.stopReason 可能是 "aborted"；错误时为 "error"
		if (reply.stopReason === "error") {
			throw new Error(reply.errorMessage ?? "模型调用失败");
		}

		messages.push(reply);

		const toolCalls = reply.content.filter((item): item is ToolCall => item.type === "toolCall");

		// 如果模型没有要求调用工具，说明已经得出最终答案，直接提取文本返回
		if (toolCalls.length === 0) {
			return reply.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
		}

		for (const item of toolCalls) {
			// TODO 3b: 取消检查（每个工具执行前）
			// 如果 signal?.aborted 为 true，中断工具循环

			// TODO 2: 工具错误回传
			// 用 try / catch 包裹 runTool(item.name, item.arguments, signal)：
			// - 成功时：isError: false，text 为工具返回结果
			// - 失败时：不要直接 throw 终止整个 Agent，而是提取错误信息，
			//   设置 isError: true，把错误文本作为 toolResult 回传给模型
			const toolResult = await runTool(item.name, item.arguments, signal);
			messages.push({
				role: "toolResult",
				toolCallId: item.id,
				content: [{ type: "text", text: toolResult }],
				timestamp: Date.now(),
				toolName: item.name,
				isError: false,
			});
		}
	}
}

async function main(): Promise<void> {
	const controller = new AbortController();

	// TODO 3a: 监听 Ctrl+C (SIGINT)
	// 定义 onSigint 处理函数调用 controller.abort()，用 process.on("SIGINT", onSigint) 注册，
	// 并在 try / finally 中调用 runAgent，在 finally 里用 process.off("SIGINT", onSigint) 清理
	void controller;

	const answer = await runAgent("请列出当前目录下的文件，并读取mini-agent.ts", {
		maxTurns: 5,
		signal: controller.signal,
	});
	console.log("\n最终回答：\n", answer);
}

main().catch((err) => {
	// TODO 3c: 区分“用户主动取消”和“其他异常”，避免按 Ctrl+C 后打印完整堆栈
	console.error(err);
});
