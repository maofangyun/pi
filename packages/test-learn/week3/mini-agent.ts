import * as fs from "node:fs/promises";
import type {Context, Message, Tool, ToolCall} from "@earendil-works/pi-ai";
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
async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
	if (name === "read_file") {
		// 从 args.path 读取文件内容并返回字符串（提示：fs.readFile）
		if (typeof args.path !== "string") {
			throw new Error("read_file 缺少有效的 string 类型 path 参数");
		}
		return fs.readFile(args.path, "utf8");

	}

	if (name === "list_dir") {
		// 读取 args.path 目录下的文件列表并返回字符串（提示：fs.readdir）
		if (typeof args.path !== "string") {
			throw new Error("list_dir 缺少有效的 string 类型 path 参数");
		}
		const dirs = await fs.readdir(args.path, { withFileTypes: true });
		return dirs.map((dir) => dir.name).join("\n");
	}

	return `未知工具: ${name}`;
}

// 3. Agent 主循环
async function runAgent(userInput: string): Promise<string> {
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

	while (true) {
		// 1: 调用 models.complete(model, { systemPrompt, messages, tools: toolDefinitions })
		const context: Context = {systemPrompt, messages, tools: toolDefinitions};
		const reply = await models.complete(model, context);
		// 拿到模型返回的 AssistantMessage，并把它加入 messages
		// 2: 从 reply.content 中找出所有 type === "toolCall" 的项
		const toolCalls = reply.content
			.filter((item): item is ToolCall => item.type === "toolCall");

		if (reply.stopReason === "error") {
			throw new Error(reply.errorMessage ?? "模型调用失败");
		}
		messages.push(reply);
		// 如果模型没有要求调用工具，说明已经得出最终答案，直接提取文本返回
		if (toolCalls.length === 0) {
			// 3: 从 reply.content 中提取 type === "text" 的内容并拼接返回
			return reply.content
				.filter(item => item.type === "text")
				.map(item => item.text)
				.join("\n");
		}

		// 4: 遍历 toolCalls，调用 runTool(call.name, call.arguments)
		// 把每个结果包装成 role: "toolResult" 的消息，push 到 messages 中，继续下一轮循环
		for (const item of toolCalls) {
			const toolResult = await runTool(item.name,item.arguments);
			messages.push({
				role: "toolResult",
				toolCallId: item.id,
				content: [{ type: "text", text: toolResult }],
				timestamp: Date.now(),
				toolName: item.name,
				isError: false
			})
		}
	}
}

async function main(): Promise<void> {
	const answer = await runAgent("请列出当前目录下的文件，并读取mini-agent.ts");
	console.log("\n最终回答：\n", answer);
}

main().catch(console.error);
