import { type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { obj, opt, str } from '@earendil-works/pi-schema';

// 创建包含所有内置 Provider 的 Models 集合
const models = builtinModels();

// 在集合中同步查找模型
const model = models.getModel('deepseek', 'deepseek-flash')!;

// 使用 JSON Schema 定义工具；pi-schema 构建器会自动推导参数类型
const tools: Tool[] = [{
    name: 'get_time',
    description: '获取当前时间',
    parameters: obj({
        timezone: opt(str({ description: '可选的时区（例如：America/New_York 或 Asia/Shanghai）' }))
    })
}];

// 构建对话上下文（可方便地序列化，并在不同模型间无缝流转）
const context: Context = {
    systemPrompt: '你是一个得力的助手。',
    messages: [{ role: 'user', content: '现在几点了？', timestamp: Date.now() }],
    tools
};

// 方式 1：流式调用，监听所有事件类型。
// 认证信息会自动由 Provider 解析（此处从环境变量中读取 OPENAI_API_KEY）。
const s = models.stream(model, context);

for await (const event of s) {
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
            process.stdout.write(event.delta);
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

// 流式结束后获取最终消息对象，并推入上下文
const finalMessage = await s.result();
context.messages.push(finalMessage);

// 处理工具调用（若有）
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
    const result = call.name === 'get_time'
        ? new Date().toLocaleString('zh-CN', {
            timeZone: typeof call.arguments.timezone === 'string' ? call.arguments.timezone : 'Asia/Shanghai',
            dateStyle: 'full',
            timeStyle: 'long'
        })
        : '未知工具';

    // 将工具执行结果添加至上下文（支持文本和图像）
    context.messages.push({
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text', text: result }],
        isError: false,
        timestamp: Date.now()
    });
}

// 若触发了工具调用，携带结果继续调用模型
if (toolCalls.length > 0) {
    const continuation = await models.complete(model, context);
    context.messages.push(continuation);
    console.log('执行工具后的回复:', continuation.content);
}

console.log(`Token 消耗: 输入 ${finalMessage.usage.input}, 输出 ${finalMessage.usage.output}`);
console.log(`费用: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 方式 2：非流式直接获取完整回复
const response = await models.complete(model, context);

for (const block of response.content) {
    if (block.type === 'text') {
        console.log(block.text);
    } else if (block.type === 'toolCall') {
        console.log(`工具调用: ${block.name}(${JSON.stringify(block.arguments)})`);
    }
}