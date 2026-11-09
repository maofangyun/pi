import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
    AssistantMessage,
    Context,
    Model,
    StopReason,
    SystemMessage,
    TextContent,
    ThinkingContent,
    ToolCall,
    ToolResultMessage,
    Usage,
    UserMessage,
} from "@earendil-works/pi-ai";

// 初始化模型集合并获取deepseek
const models = builtinModels();
const model = models.getModel("deepseek","deepseek-flash");
if (!model) {
    throw new Error("Model not found");
}

// 构建对话上下文
const userMessage: UserMessage = {
    role: "user",
    content: "简单打个招呼",
    timestamp: Date.now(),
}

const context: Context = {
    systemPrompt: "你是一个得力的智能助手",
    messages: [userMessage]
}

// 调用deepseek一次性的获取全部的信息
const reply = await models.complete(model, context);
console.log(reply);


console.log("stopReason:", reply.stopReason);
console.log("usage:", reply.usage);
console.log("content 块数量:", reply.content.length);

for (const block of reply.content) {
    if (block.type === "text") {
        console.log("\n[TextContent]:", block.text);
    } else if (block.type === "thinking") {
        console.log("\n[ThinkingContent]:", block.thinking);
    } else if (block.type === "toolCall") {
        console.log("\n[ToolCall]:", block.name, block.arguments);
    }
}





