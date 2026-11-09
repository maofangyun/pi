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
import {styleText} from "node:util";

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

// 流式调用
const eventStream = await models.stream(model, context, {"reasoningEffort": "high"});

for await (const event of eventStream) {
    switch (event.type) {
        case 'start':
            console.log(`开始生成，使用模型: ${event.partial.model}`);
            break;
        case 'text_start':
            console.log('\n[文本块开始]');
            break;
        case 'text_delta':
            process.stdout.write(event.delta);
            break;
        case 'text_end':
            console.log('\n[文本块结束]');
            break;
        case 'thinking_start':
            console.log('[模型开始思考...]');
            break;
        case 'thinking_delta':
            process.stdout.write(styleText("gray",event.delta));
            break;
        case 'thinking_end':
            console.log('[思考完成]');
            break;
        case 'toolcall_start':
            console.log(`\n[工具调用开始: 序号 ${event.contentIndex}]`);
            break;
        case 'toolcall_delta':
            // 正在流式接收部分工具参数
            const partialCall = event.partial.content[event.contentIndex];
            if (partialCall.type === 'toolCall') {
                console.log(`[正在流式接收 ${partialCall.name} 的参数]`);
            }
            break;
        case 'toolcall_end':
            console.log(`\n工具调用完成: ${event.toolCall.name}`);
            console.log(`完整参数: ${JSON.stringify(event.toolCall.arguments)}`);
            break;
        case 'done':
            console.log(`\n生成完毕，原因: ${event.reason}`);
            break;
        case 'error':
            console.error(`错误: ${event.error.errorMessage}`);
            break;
    }
}






