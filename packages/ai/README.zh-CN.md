# @earendil-works/pi-ai

统一的 LLM API：具备 Provider（提供商）集合管理、自动化认证解析、Token 与费用追踪，以及简捷的会话上下文持久化和中途跨模型无缝切换（Hand-off）能力。

**注意**：Chat 目录仅包含支持工具调用（Tool Calling / Function Calling）的模型，因为这对于 Agent 工作流至关重要。图像生成与分类器目录则针对各自专用的操作能力进行管理。

## 目录

- [支持的提供商 (Supported Providers)](#支持的提供商)
- [安装 (Installation)](#安装)
- [快速开始 (Quick Start)](#快速开始)
- [提供商与模型 (Providers and Models)](#提供商与模型)
  - [提供商工厂函数 (Provider Factories)](#提供商工厂函数)
  - [所有内置提供商 (All Built-in Providers)](#所有内置提供商)
  - [查询模型 (Querying Models)](#查询模型)
  - [静态目录读取 (Static Catalog Reads)](#静态目录读取)
  - [动态提供商 (Dynamic Providers)](#动态提供商)
- [认证机制 (Auth)](#认证机制)
  - [认证如何解析 (How Auth Resolves)](#认证如何解析)
  - [转换请求头 (Transforming Request Headers)](#转换请求头)
  - [客户端标识 (Client Identity)](#客户端标识)
  - [凭据存储 (Credential Store)](#凭据存储)
  - [环境变量 (Environment Variables)](#环境变量)
- [工具调用 (Tools)](#工具调用)
  - [定义工具 (Defining Tools)](#定义工具)
  - [工具约束采样 (Constrained Sampling for Tools)](#工具约束采样)
  - [处理工具调用 (Handling Tool Calls)](#处理工具调用)
  - [流式解析部分 JSON 工具参数 (Streaming Tool Calls with Partial JSON)](#流式解析部分-json-工具参数)
  - [校验工具参数 (Validating Tool Arguments)](#校验工具参数)
  - [完整流式事件参考 (Complete Event Reference)](#完整流式事件参考)
- [图像输入 (Image Input)](#图像输入)
- [图像生成 (Image Generation)](#图像生成)
  - [基础图像生成 (Basic Image Generation)](#基础图像生成)
  - [注意事项与限制 (Notes and Limitations)](#注意事项与限制)
- [分类器 (Classification)](#分类器)
  - [System One 图像](#system-one-图像)
  - [OpenAI Decisions](#openai-decisions)
  - [llama.cpp 对话模型作为分类器](#llamacpp-对话模型作为分类器)
- [思考 / 推理 (Thinking/Reasoning)](#思考--推理)
  - [统一接口 (streamSimple/completeSimple)](#统一接口)
  - [提供商专属选项 (stream/complete)](#提供商专属选项)
  - [流式接收思考内容 (Streaming Thinking Content)](#流式接收思考内容)
- [停止原因 (Stop Reasons)](#停止原因)
- [遥测与监控 (Telemetry)](#遥测与监控)
- [错误处理 (Error Handling)](#错误处理)
  - [中止请求 (Aborting Requests)](#中止请求)
  - [中止后恢复会话 (Continuing After Abort)](#中止后恢复会话)
  - [调试 Provider 请求载荷 (Debugging Provider Payloads)](#调试-provider-请求载荷)
  - [监听 Provider 原生流式事件 (Observing Provider Stream Events)](#监听-provider-原生流式事件)
- [自定义提供商 (Custom Providers)](#自定义提供商)
  - [createProvider()](#createprovider)
  - [直接调用 API 底层实现 (Calling API Implementations Directly)](#直接调用-api-底层实现)
  - [OpenAI 兼容性设置 (OpenAI Compatibility Settings)](#openai-兼容性设置)
- [用于测试的虚拟提供商 (Faux Provider for Tests)](#用于测试的虚拟提供商)
- [跨 Provider 模型切换 (Cross-Provider Handoffs)](#跨-provider-模型切换)
- [系统消息 (System Messages)](#系统消息)
- [上下文序列化 (Context Serialization)](#上下文序列化)
- [浏览器环境使用 (Browser Usage)](#浏览器环境使用)
- [打包与摇树优化 (Bundling and Tree Shaking)](#打包与摇树优化)
  - [请求级 Provider 环境变量覆盖 (Provider-Scoped Environment Overrides)](#请求级-provider-环境变量覆盖)
- [OAuth 认证提供商 (OAuth Providers)](#oauth-认证提供商)
  - [Vertex AI](#vertex-ai)
  - [CLI 登录 (CLI Login)](#cli-登录)
  - [编程式 OAuth (Programmatic OAuth)](#编程式-oauth)
- [从旧版全局 API 迁移 (Migrating from the Old Global API)](#从旧版全局-api-迁移)
- [开发指南 (Development)](#开发指南)
  - [添加新的 Provider (Adding a New Provider)](#添加新的-provider)
- [开源协议 (License)](#开源协议)

---

## 支持的提供商

- **OpenAI**（包括 Decisions 分类器 API）
- **Ant Ling（蚂蚁灵犀）**
- **Azure OpenAI (Responses)**
- **OpenAI Codex (旧版)**（ChatGPT Plus/Pro 订阅，需 OAuth，见后文）
- **Radius**（支持 API Key 或 OAuth，网关目录动态刷新）
- **TypeSafe**（System One 分类器 API）
- **DeepSeek**
- **NVIDIA NIM**
- **Anthropic**
- **Google**
- **Vertex AI**（通过 Vertex AI 调用 Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **ZAI Coding Plan (Global)**（包含独立的 China 国内 Provider）
- **MiniMax**（包含独立的 China 国内 Provider）
- **Together AI**
- **Baseten**
- **Hugging Face**
- **Moonshot AI（月之暗面）**（包含独立的 China 国内 Provider）
- **GitHub Copilot**（需 OAuth，见后文）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（使用 OpenAI 和 Anthropic 兼容 API）
- **Kimi For Coding**（Moonshot AI 订阅端点，采用 Anthropic 兼容协议）
- **Meta**（Model API，采用 OpenAI Responses 兼容协议）
- **Qwen Token Plan（通义千问）**（提供独立的个人版与现有目录，以及独立的 China 国内 Provider）
- **Xiaomi MiMo（小米 MiMo）**（默认使用 API 计费端点，针对 `cn`/`ams`/`sgp` 区域提供独立的 Token Plan Provider）
- **任何兼容 OpenAI 的接口**：Ollama、vLLM、LM Studio 等

---

## 安装

```bash
npm install @earendil-works/pi-ai
```

工具参数基于 JSON Schema 构建。示例中使用 `@earendil-works/pi-schema` 构造并提供类型推导（`npm install @earendil-works/pi-schema`）；同时兼容 TypeBox Schema 以及普通的纯 JSON Schema 对象。

---

## 快速开始

你需要先构建一个包含各 Provider 的 `Models` 集合，然后通过它进行流式调用。最快速的入门方式是直接注册所有内置 Provider；注重打包体积的应用可以按需单独注册 Provider（参见 [提供商工厂函数](#提供商工厂函数) 与 [打包与摇树优化](#打包与摇树优化)）。

```typescript
import { type Context, type Tool } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { obj, opt, str } from '@earendil-works/pi-schema';

// 创建包含所有内置 Provider 的 Models 集合
const models = builtinModels();

// 在集合中同步查找模型
const model = models.getModel('openai', 'gpt-4o-mini')!;

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
        timeZone: call.arguments.timezone || 'Asia/Shanghai',
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
```

当 `usage.cost.total` 是提供商返回的真实计费金额时，`usage.cost.totalFromProvider` 为 `true`；若是根据模型目录的费率估算的，则为 `false`。若该字段不存在（例如在新增此字段之前保存的历史会话中），同样视为 `false`。

本 README 后续的代码片段均假设你已按照此方式初始化了 `models` 集合。

`usage.cost.total` 代表当前最准确的总费用。对于 OpenRouter 对话响应，它优先采用 OpenRouter 报告的账单费用（在 BYOK 模式下包含了 OpenRouter 服务费与上游推理费用）。当无法获取提供商账单或数据无效时，会回退到使用模型目录中的基准费率估算。`input`、`output`、`cacheRead` 和 `cacheWrite` 各子项费用始终保持为目录估算值，因此各子项相加之和可能不等于提供商直接上报的 total 金额。

---

## 提供商与模型

**Provider（提供商）** 是运行时的基本单元：它管理自己的模型目录、认证方式（API Key 解析、OAuth 登录流程）以及流式行为。`Models` 集合负责统一容纳这些 Provider，并将每个请求精准路由到拥有该模型的 Provider。

各 Provider 内部复用底层的 **API 实现**（即通讯线协议 Wire Protocol）：Anthropic 模型使用 `anthropic-messages`，OpenAI 使用 `openai-responses`，而 xAI、Groq、Cerebras、OpenRouter 及多数厂商则共享 `openai-completions`。对于支持混合 API 的 Provider（如 GitHub Copilot、OpenCode Zen），则按模型分发到对应 API。

### 提供商工厂函数

如果你的应用只需要某些特定 Provider，每个内置 Provider 都提供了一个独立的子路径导入工厂函数，仅会引入该 Provider 自身的模型目录：

```typescript
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';
// ... 支持列表中的每个 Provider 都有对应的子模块

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider 工厂函数仅导入该 Provider 的模型目录和一个懒加载的 API 包装器，不会引入其它 Provider。在开启了代码分割的打包器中，具体厂商的 SDK（如 `@anthropic-ai/sdk`、`openai`、`@google/genai` 等）将作为懒加载 chunk 存在，只有首次向对应 API 发起请求时才会被加载。

### 所有内置提供商

若希望一次性注册全部 Provider（如“快速开始”中的做法）：

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels(); // 包含所有内置 Provider 的 Models 集合
```

这会导入所有的模型目录及所有内置 Provider 工厂，是一个较重但显式的全量入口。`builtinModels()` 接收与 `createModels()` 完全相同的选项（如 `credentials`、`authContext`）；如果你需要拿到 Provider 数组并自行注册到自定义集合中，可以使用 `builtinProviders()`。

### 查询模型

查询操作是同步进行的，返回当前已知列表：

```typescript
const providers = models.getProviders();           // 已注册的 Provider 对象列表
const provider = models.getProvider('anthropic');  // 获取单个 Provider

const all = models.getModels();                    // 所有 Provider 下的全部 Chat 模型
const anthropicModels = models.getModels('anthropic');
const model = models.getModel('anthropic', 'claude-sonnet-4-5');

for (const m of anthropicModels) {
  console.log(`${m.id}: ${m.name}`);
  console.log(`  API 协议: ${m.api}`);
  console.log(`  上下文窗口: ${m.contextWindow} tokens`);
  console.log(`  是否支持视觉: ${m.input.includes('image')}`);
  console.log(`  是否支持推理: ${m.reasoning}`);
}
```

未加限定的 `getModels()` / `getModel()` / `getAvailable()` 返回的是可用于 `stream()` 的对话模型（`Model<Api>`）。带有 `*OfType` 后缀的方法则按指定的模型类型过滤，而 `getAllModels()` / `getAllAvailable()` 则以 `AnyModel` 的联合类型返回所有类型的模型：

```typescript
const images = models.getModelsOfType('image', 'openrouter');           // ImageModel[]
const flux = models.getModelOfType('image', 'openrouter', 'black-forest-labs/flux.2-pro');
const jev = models.getModelOfType('classifier', 'typesafe', 'jev-latest');
const availableImages = await models.getAvailableOfType('image');
const everything = models.getAllModels();                               // AnyModel[]
```

模型的 `type` 决定了它适用的操作类型：对话模型支持流式生成（stream），`type: "image"` 模型用于图像生成，`type: "classifier"` 模型用于对结构化状态进行分类。对话模型上的 `type` 属性是可选的，因此未标注 `type` 的模型默认即为对话模型。请不要直接用 `===` 比较 `type`；建议使用类型守卫 `isModelType()` 收窄混合列表，或使用 `getModelType()` 读取生效的类型：

```typescript
import { isModelType } from '@earendil-works/pi-ai';

for (const model of models.getAllModels()) {
  if (isModelType(model, 'image')) {
    // 此时 model 收窄为: ImageModel<ImageApi>
  }
}
```

在同一个 Provider 和同一模型类型下，模型 ID 是唯一的；上游同一个模型如果支持多种操作能力，在目录中会有不同类型的条目。在 Provider 对象上，`getModels()` 返回对话模型，可选的 `getAllModels()` 返回所有类型；仅包含对话模型的 Provider 可以省略该方法。

动态拉取的对话模型类型为泛型 `Model<Api>`。当你需要特定 API 专属的选项类型约束时，可使用 `hasApi()` 守卫进行收窄：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

const m = models.getModel('anthropic', 'claude-sonnet-4-5');
if (m && hasApi(m, 'anthropic-messages')) {
  // m 类型收窄为: Model<'anthropic-messages'> — stream 选项拥有完整的强类型提示
  models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### 静态目录读取

若开发外部工具需要完全字面量类型的内置模型目录（支持 Provider 和模型 ID 的 IDE 自动补全），且不依赖任何运行时集合对象，可以直接使用以下静态方法：

```typescript
import {
  getAllBuiltinModels,
  getBuiltinClassifierModel,
  getBuiltinClassifierModels,
  getBuiltinImageModel,
  getBuiltinImageModels,
  getBuiltinModel,
  getBuiltinModels,
  getBuiltinProviders,
} from '@earendil-works/pi-ai/providers/all';

const model = getBuiltinModel('openai', 'gpt-4o-mini'); // 类型为 Model<'openai-responses'>
const radius = getBuiltinModel('radius', 'balanced');   // 类型为 Model<'pi-messages'>
const flux = getBuiltinImageModel('openrouter', 'black-forest-labs/flux.2-pro');
const jev = getBuiltinClassifierModel('typesafe', 'jev-latest');
const providers = getBuiltinProviders();
const openrouterChat = getBuiltinModels('openrouter');        // Model[]
const openrouterImages = getBuiltinImageModels('openrouter'); // ImageModel[]
const typesafeClassifiers = getBuiltinClassifierModels('typesafe'); // ClassifierModel[]
const openrouterAll = getAllBuiltinModels('openrouter');      // AnyModel[]
```

### 动态提供商

有些 Provider 拥有动态模型列表（如本地 llama.cpp 服务，或 OpenRouter 线上实时列表）。模型读取依然是同步的；而拉取更新是一个显式的异步动作：

```typescript
// getModels() 返回当前已知的最新列表（首次刷新前为空）
await models.refresh({ providers: ['llamacpp'] }); // 仅刷新指定 Provider
await models.refresh();                            // 并发尽力刷新所有 Provider
const fresh = models.getModel('llamacpp', 'qwen3-30b');
```

静态内置 Provider 对 `refresh()` 是空操作。Radius 同时具备静态与动态特性：它自带 `radius.pi.dev` 公共静态目录供同步查询，配置认证并刷新后，会叠加本地缓存与从 `/v1/config` 实时拉取的最新模型。关于如何构建动态 Provider，请参见 [createProvider()](#createprovider)。

---

## 认证机制

每个 Provider 自行管理认证逻辑：如何解析 API Key（本地存储凭据、环境变量、环境凭据如 AWS Profile 或 gcloud ADC），以及针对支持的厂商提供 OAuth 登录/刷新流。

### 认证如何解析

当你调用 `models.stream()` 时，集合会通过拥有该模型的 Provider 解析认证，并合并至请求中。**每次请求时显式传入的认证优先级最高**：

```typescript
// 自动通过 Provider 解析（读取环境变量、已保存的凭据或 OAuth Token）：
await models.complete(model, context);

// 显式传入的 key 优先级最高，覆盖 Provider 解析的值：
await models.complete(model, context, { apiKey: 'sk-explicit' });
```

你也可以在不发起请求的情况下检查认证解析结果。传入 Provider ID 获取 Provider 级别的认证，或传入具体 Model 获取包含其静态 `model.headers` 的完整认证信息：

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
  console.log(`认证来源: ${modelAuth.source}`); // 如 "ANTHROPIC_API_KEY", "OAuth", "stored credential"
  console.log(modelAuth.auth.headers);        // Provider 认证请求头 + model.headers
} else {
  console.log('未配置认证信息');
}
```

这两个重载都会解析凭证并在必要时刷新过期的 OAuth Token，返回由认证推导出的 `apiKey`、`headers` 或 `baseUrl`。未配置认证时 `getAuth()` 返回 `undefined`；若认证存在实质性损坏时则会抛出 `ModelsError`（如 `"oauth"`: Token 刷新失败，但保留了凭据以供重新登录；`"auth"`: 秘钥解析失败或凭据存储读取异常）。在发起请求时，这些异常会以流式错误事件（stream error）的形式体现。

`getAuth()`、`checkAuth()`、`getAvailable()`、login 与 logout 支持通过选项或交互对象传入外部取消信号（AbortSignal）；未提供信号时操作没有超时约束。Provider 的 `login`、`ApiKeyAuth.check`、`ApiKeyAuth.resolve` 与 `OAuthAuth.refresh` 实现均会接收具体的信号，并必须在阻塞性操作中响应取消。

### 转换请求头

`Models.stream()`、`complete()`、`streamSimple()` 以及 `completeSimple()` 支持专属的 `transformHeaders` 选项。该函数在合并了 Provider 认证头、`model.headers` 以及显式传入的 `options.headers` 之后、正式发往 Provider 之前执行一次：

```typescript
const response = await models.completeSimple(model, context, {
  headers: { "X-Client": "my-app" },
  transformHeaders: async (headers) => ({
    ...headers,
    "X-Request-ID": crypto.randomUUID(),
  }),
});
```

请求头的合并顺序为：

```text
Provider 认证头 -> model.headers -> 显式 options.headers -> transformHeaders -> Provider.stream*()
```

请求头名称的合并大小写不敏感。显式 headers 会覆盖认证和模型 headers，而 `transformHeaders` 拥有最终决定权；将某个 Header 的值设为 `null` 可将其删除。

`transformHeaders` 是 `Models` 层的配置，不属于 `Provider`。`Models` 会在调用 `Provider.stream*()` 之前消耗并移除该选项。Provider 实现接收到的始终是常规的 `ApiStreamOptions` 或 `SimpleStreamOptions`，无需关心此转换。请优先使用此选项，而不是在调用 `stream*()` 之前手动调用 `getAuth(model)`，后者会导致认证被重复解析两次。

### 客户端标识

`identity` 用于控制请求如何向 Provider 声明当前调用方应用。你可以在 `createModels()` 中设置全局默认值，或在具体请求中按字段进行覆盖：

```typescript
const models = createModels({
  identity: {
    userAgent: 'detailed',
    version: '2.1.0',
    attribution: { name: 'my-app', url: 'https://my-app.example', categories: ['cloud-agent'] },
  },
});

await models.completeSimple(model, context, { identity: { attribution: null } });
```

- `userAgent`：`"detailed"`（默认值）发送 `pi/<version> (<platform>; <runtime>; <arch>)`；`"short"` 发送 `pi`；`{ custom: "..." }` 发送自定义字符串。在 Bedrock 上该值会追加到 AWS SDK 默认的 User-Agent 之后。
- `version`：详细 User-Agent 中的版本号，默认为 pi-ai 的包版本。
- `attribution`：厂商归属请求头。缺省（默认）或设为 `null` 时不发送；显式设为 `null` 还可以禁用合并后的全局归属信息。`{ name, url, categories? }` 会映射到各 Provider 的特定请求头：
  - OpenRouter：`HTTP-Referer: <url>`（在 OpenRouter 榜单中标记来源）、`X-OpenRouter-Title: <name>` 和 `X-OpenRouter-Categories`（英文逗号分隔）。
  - NVIDIA NIM：`X-BILLING-INVOKE-ORIGIN: <name>`（首字母大写）。
  - OpenCode：`x-opencode-client: <name>`。

  内置的 `PI_ATTRIBUTION` 即为 pi 自身的标识：`{ name: "pi", url: "https://pi.dev", categories: ["cli-agent"] }`。

客户端标识请求头处于较低优先级，位于 Provider、模型和请求头之下，因此显式配置的请求头始终优先生效，传入 `null` 可显式移除。自带固定客户端身份的 Provider（如 GitHub Copilot 和 Anthropic OAuth）会保留其自身标识。`withClientIdentity(models, identity)` 可以基于现有 `Models` 包装出一个新实例并应用覆盖的 `identity`，适合在宿主将 `Models` 传递给第三方库时使用。`identity` 是纯 JSON 对象，可安全持久化。

### 凭据存储

持久化的凭据（交互式输入的 API Key、OAuth Token）保存在 `CredentialStore` 中——每个 Provider 仅保存一份带类型标识的凭据。pi-ai 默认自带内存实现；生产应用可以注入基于文件或数据库的持久化实现：

```typescript
import { createModels, type CredentialStore } from '@earendil-works/pi-ai';

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() 支持完全相同的配置：
// const models = builtinModels({ credentials: myFileBackedStore });
```

接口设计非常精简：`read(providerId)`、用于读取非敏感元数据 `{ providerId, type }` 的 `list()`、唯一的写入路径 `modify(providerId, fn)`（执行串行化的读-改-写事务），以及 `delete(providerId)`。每个操作均支持可选的取消信号。遍历列表时不得泄漏秘钥或触发外部命令。OAuth Token 刷新逻辑运行在 `modify` 锁内，防止并发请求导致轮换 Token 被重复刷新。已保存的凭据对该 Provider 拥有**独占控制权**：仅在未持久化任何凭据时才会回退到环境变量，刷新失败也不会静默降级为环境变量 Key。

API Key 凭据使用与 pi `auth.json` 相同的判别字段，并可携带特定 Provider 作用域的环境/配置变量：

```typescript
const credential = {
  type: 'api_key',
  key: '...',
  env: {
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
} as const;
```

### 环境变量

Node.js 环境下，内置 Provider 会自动读取以下环境变量（浏览器环境中请显式传入 `apiKey`）：

| 提供商 (Provider) | 环境变量 (Environment Variables) |
|---|---|
| OpenAI | `OPENAI_API_KEY` |
| Ant Ling（蚂蚁灵犀） | `ANT_LING_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例如 `https://{resource}.ai.azure.com`）或 `AZURE_OPENAI_RESOURCE_NAME`。支持 `*.openai.azure.com`、`*.cognitiveservices.azure.com` 与 `*.ai.azure.com`；根路径自动规范化为 `/openai/v1`。可选参数：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` 或 `ANTHROPIC_OAUTH_TOKEN` |
| Radius | `RADIUS_API_KEY` |
| TypeSafe | `TYPESAFE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY`，或者 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC 认证 |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan (Global) | `ZAI_API_KEY` |
| ZAI Coding Plan (China) | `ZAI_CODING_CN_API_KEY` |
| MiniMax (Global) | `MINIMAX_API_KEY` |
| MiniMax (China) | `MINIMAX_CN_API_KEY` |
| Moonshot AI / Moonshot AI (China) | `MOONSHOT_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| Qwen Token Plan (现有目录) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (个人版) | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan (China) | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo (API 计费) | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan (China) | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan (阿姆斯特丹) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan (新加坡) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`qwen-token-plan-individual` 与 `qwen-token-plan` 共用国际版端点及 `QWEN_TOKEN_PLAN_API_KEY`。其中个人版（Individual）仅展示官方文档列出的个人订阅模型，而现有 Provider 保留了更宽泛的目录以保持向后兼容。凭证存储具备 Provider 隔离性，请在你注册的 Provider ID 下保存秘钥。

Amazon Bedrock 自动解析运行环境中的 AWS 凭证（`AWS_PROFILE`、Access Key 密钥对、`AWS_BEARER_TOKEN_BEDROCK`、ECS 任务角色、Web 身份令牌等）；其内置的登录流程支持 Bearer Token、AWS Profile 以及现有的凭证链。Vertex AI 支持显式 API Key 或通过 gcloud Application Default Credentials (ADC) 获取项目/位置信息，登录流程适配了 API Key、ADC 以及服务账号 JSON 密钥文件。

---

## 工具调用

工具调用（Tools）让 LLM 能够与外部系统进行交互。工具的 `parameters` 为 JSON Schema 对象：推荐使用 `@earendil-works/pi-schema` 构造（配合其 `Static` 提供强类型推导），亦可使用 TypeBox 或手写 JSON 对象。`validateToolCall()` 和 `validateToolArguments()` 依赖 pi-schema 进行校验，并在校验前自动对松散类型进行类型强制转换（例如数字字符串转换、`"true"` 转为布尔、单个值包装为数组、省略的可选属性填充 `null` 等）。Schema 为标准 JSON 结构，可随 Context 一同序列化。

### 定义工具

```typescript
import { type Tool, StringEnum } from '@earendil-works/pi-ai';
import { arr, obj, str } from '@earendil-works/pi-schema';

// 使用 pi-schema 构建工具参数规范
const weatherTool: Tool = {
  name: 'get_weather',
  description: '获取指定地点的当前天气',
  parameters: obj({
    location: str({ description: '城市名称或经纬度坐标' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 说明：StringEnum 生成 { type: "string", enum: [...] }，所有 Provider 均原生支持
// 包括 Google（Google 平台不接受 anyOf/const 组合模式）

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: '预约会议',
  parameters: obj({
    title: str({ minLength: 1 }),
    startTime: str({ format: 'date-time' }),
    endTime: str({ format: 'date-time' }),
    attendees: arr(str({ format: 'email' }), { minItems: 1 })
  })
};
```

### 工具约束采样

工具可以声明由 Provider 服务端实施的约束采样（Constrained Sampling）。针对 JSON Schema 工具，声明 `strict: 'prefer'` 会在上游支持严格模式时启用服务端强制约束，不支持时回退到普通工具调用；声明 `strict: 'require'` 则会在当前 Provider 或模型不支持时直接报错失败。设置 `constrainedSampling: false` 则显式禁用（效果等同于省略此字段）。

```typescript
const strictTool: Tool = {
  name: 'edit_file',
  description: '编辑文件',
  parameters: obj({ path: str(), content: str() }), // obj() 默认封闭：additionalProperties: false
  constrainedSampling: { type: 'json_schema', strict: 'prefer' }
};
```

OpenAI、Anthropic、支持的 Amazon Bedrock Converse 模型、Mistral，以及通过 Google Generative AI 和 Vertex 适配器调用的 Gemini 3 均支持严格 JSON Schema 约束采样。Google 在此模式下使用 `VALIDATED` 函数调用模式（显式声明时也可使用 `ANY`）；旧版 Gemini 因无法强制必须参数，在 `strict: 'prefer'` 时会自动回退，并在 `strict: 'require'` 时报错。Bedrock 的 strict 能力由模型结构化输出元数据生成，自定义 Bedrock 模型可通过 `compat.supportsStrictMode` 进行覆盖。

OpenAI Responses 和 Chat Completions 还支持通过 OpenAI Lark 或正则（Regex）语法生成受语法约束的自定义工具。如果配置了多种变体，优先采用 Lark 语法。语法约束仅在当前模型支持语法工具时生效；否则自动回退为普通函数/JSON Schema 处理。语法工具支持属于模型元数据：生成的模型目录会自动为能够转发 OpenAI 自定义工具端点（OpenAI、OpenAI Codex、Azure OpenAI Responses、GitHub Copilot、opencode 以及 Cloudflare AI Gateway）上的 GPT-5+ 模型标记 `compat.supportsOpenAIGrammarTools`。OpenAI 会拒绝 GPT-5 之前的模型使用 `type: "custom"` 工具，而某些会规范化 tool 结构的网关（如 OpenRouter）可能会破坏该结构，因此在其它端点上该标志保持关闭。自定义模型可通过 `compat` 开启此能力。具备语法能力但未提供有效语法规则的配置会报错。原生的语法工具必须具有包含单个必需字符串属性的对象参数 Schema：

```typescript
const patchTool: Tool = {
  name: 'apply_patch',
  description: '应用补丁',
  parameters: obj({ input: str() }),
  constrainedSampling: {
    type: 'grammar',
    variants: {
      openai_lark: 'start: /.+/s'
    }
  }
};
```

### 处理工具调用

工具调用结果封装为内容块（Content Block），支持同时包含文本和图像：

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: '伦敦今天天气怎么样？', timestamp: Date.now() }],
  tools: [weatherTool]
};

const response = await models.complete(model, context);

// 检查响应中的工具调用
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 使用模型生成的参数执行你的业务逻辑
    // 校验方式请参见后文“校验工具参数”章节
    const result = await executeWeatherApi(block.arguments);

    // 将文本结果回填至上下文
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// 工具调用结果也可以包含图像（仅适用于支持视觉的模型）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: '已生成显示气温走势的图表' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

### 流式解析部分 JSON 工具参数

在流式响应过程中，工具调用的参数在数据到达的同时会被渐进式（Progressive）解析为部分 JSON。这使你能够在参数尚未完整生成之前，便实时更新前端 UI：

```typescript
const s = models.stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // 流式传输期间，toolCall.arguments 包含尽可能解析出的部分 JSON 对象
    // 可用于前端渐进式渲染
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 请保持防御性编程：此时字段可能不完整
      // 例如：即便 content 尚未传输完成，也优先显示正在写入的文件路径
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`正在写入路径: ${toolCall.arguments.path}`);

        // 内容可能是截断的或尚未到达
        if (toolCall.arguments.content) {
          console.log(`内容预览: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // 此时 toolCall.arguments 已经完整接收（但尚未经过 Schema 校验）
    const toolCall = event.toolCall;
    console.log(`工具调用参数接收完成: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**关于部分工具参数的重要说明：**
- 在 `toolcall_delta` 事件中，`arguments` 是根据当前接收到的不完整 JSON 尽力解析出的对象；
- 某些字段可能完全缺失或不完整——使用前务必进行存在性检查；
- 字符串可能在单词中间被截断；
- 数组可能尚未填满；
- 嵌套对象可能只填充了一部分属性；
- `arguments` 最低限度是一个空对象 `{}`，绝不会是 `undefined`；
- Google Provider 不支持函数调用的流式分片传输。Google 模型会一次性发出包含完整参数的单个 `toolcall_delta` 事件。

### 校验工具参数

在自定义工具执行调度循环时，在执行前请使用 `validateToolCall` 校验参数。它通过 pi-schema 执行松散类型强制转换（`compile(schema, { coerce: true }).parse()`），返回类型转换后的参数对象；若校验失败，则抛出详细异常，列出所有错误路径及原因（`path: message`）以及收到的原始参数：

```typescript
import { validateToolCall, type Tool } from '@earendil-works/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = models.stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // 根据工具 Schema 严格校验参数（若不符合要求会抛出异常）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... 将工具执行成功的结果推入 context
    } catch (error) {
      // 校验失败：将错误信息作为 toolResult 回填，以便模型自我纠错重试
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

### 完整流式事件参考

正常的生成流遵循：`start → updates* → done`。生成中途若发生故障则遵循：`start → updates* → error`。请求初始化阶段在生成启动前若失败，流中将直接发出单个 `error` 事件；在 `start` 事件前发出 `done` 或更新事件均属于非法状态。底层 API 的 `streamSimple()` 在缺少认证信息时会同步抛出异常。

所有非终止事件中的 `partial` 是共享的当前响应快照辅助对象。需要特别说明的是，**它不是事件触发瞬间的不可变历史快照**：随着生成推进，Provider 可能会就地更新同一个消息对象及其 content blocks（哪怕旧事件还在队列中等待消费）。因此，请在事件回调时立即检查它，而不要将其作为不可变的历史状态长久持有。普通的文本和思考块在 `*_start` 事件发出时是空的，通过 `*_delta` 累加，直到权威的 `*_end`；而脱敏思考（Redacted Thinking）在 `start` 时可能就已经完整，不发出 delta。`toolcall_start` 时的工具参数依 Provider 行为而定，后续的 JSON 更新由 `toolcall_delta` 携带。

Assistant 消息生成过程中发出的全部事件类型：

| 事件类型 | 说明 | 核心属性 |
|---|---|---|
| `start` | 流式开始 | `partial`: 初始的 Assistant 消息骨架 |
| `text_start` | 文本块开始 | `contentIndex`: 在 content 数组中的索引位置 |
| `text_delta` | 接收到文本增量片段 | `delta`: 新到达的文本, `contentIndex`: 索引位置 |
| `text_end` | 文本块接收完成 | `content`: 完整文本, `contentIndex`: 索引位置 |
| `thinking_start` | 思考块开始 | `contentIndex`: 在 content 数组中的索引位置 |
| `thinking_delta` | 接收到思考增量片段 | `delta`: 新到达的思考文本, `contentIndex`: 索引位置 |
| `thinking_end` | 思考块接收完成 | `content`: 完整思考文本, `contentIndex`: 索引位置 |
| `toolcall_start` | 工具调用开始 | `contentIndex`: 在 content 数组中的索引位置 |
| `toolcall_delta` | 工具参数流式到达 | `delta`: JSON 增量片段, `partial.content[contentIndex].arguments`: 部分解析的参数 |
| `toolcall_end` | 工具调用接收完成 | `toolCall`: 包含完整 `id`、`name`、`arguments` 的工具调用对象（未做 Schema 校验） |
| `done` | 流正常结束 | `reason`: 停止原因 ("stop", "length", "toolUse"), `message`: 最终完整的 Assistant 消息 |
| `error` | 发生错误 | `reason`: 错误类型 ("error" 或 "aborted"), `error`: 携带部分已生成内容的 AssistantMessage |

不同内容块的流式事件并不保证是连续发出的。Provider 可能会在同一个上游 chunk 中混杂文本、思考和工具调用的增量，pi 也会将它们交错触发，例如 `text_start` -> `text_delta` -> `toolcall_start` -> `text_delta` -> `toolcall_delta`。调用方必须通过 `contentIndex` 将 delta/end 事件关联到具体的 block，绝不可假设某个 block 的 `*_start`/`*_delta`/`*_end` 序列不会被其它 block 的事件打断。

---

## 图像输入

具备视觉能力的模型可以解析图像。你可以通过模型的 `input` 属性检查其是否支持图像。如果向不支持视觉的模型传入图像，它们会被静默忽略。

```typescript
import { readFileSync } from 'fs';

const model = models.getModel('openai', 'gpt-4o-mini')!;

// 检查模型是否支持视觉能力
if (model.input.includes('image')) {
  console.log('该模型支持视觉处理');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await models.complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: '这张图片里有什么？' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ],
    timestamp: Date.now()
  }]
});

// 输出回复
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

---

## 图像生成

图像模型同样归属于 `Models` 集合与对应的 `Provider` 下，因此配置一份 Provider 凭证即可同时支持对话和生图。图像模型的类型为 `ImageModel`（带有 `type: "image"` 标记），并通过 `generateImages()` 专用方法调用。这是一个单次异步 API，会等待 Provider 生成完毕并返回最终的 `AssistantImages` 结果。请不要将图像模型传递给对话/流式接口；`stream()` 会直接拒绝图像模型。

### 基础图像生成

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();

const model = models.getModelOfType('image', 'openrouter', 'google/gemini-2.5-flash-image')!;

// 认证信息自动通过 Provider 提取（此处为 OPENROUTER_API_KEY）；显式传入的 apiKey 优先级最高
const result = await models.generateImages(model, {
  input: [{ type: 'text', text: '在纯白底色上绘制一个鲜红色的圆形。' }]
});

for (const block of result.output) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'image') {
    console.log(block.mimeType);
    console.log(block.data.substring(0, 32)); // Base64 编码数据
  }
}
```

`generateImages()` 仅接受 `ImageModel` 实例。如果某个上游模型既支持对话又支持图像生成，在目录中会以相同的 Provider 和 ID 拆分成两个独立的条目：`getModel()` 返回其对话模型，`getModelOfType('image', ...)` 返回其生图模型。生图调用发生错误时不会抛出 Promise reject，而是返回带有 `stopReason: "error"` 的 `AssistantImages` 对象，这涵盖了未知 Provider、未配置凭据以及 Provider 未实现生图接口等各种异常。

Provider 在 [`createProvider()`](#createprovider) 中通过 `images` 选项声明生图支持：即一个从 `model.api` 到包含 `generateImages()` 实现的映射表。图像模型与对话模型混存在同一个 `models` 列表中。当指定了 `images` 时，`api` 成为可选属性，因此纯图像 Provider 实际上就是不带对话模型的 Provider：

```typescript
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';

const pixels = createProvider({
  id: 'pixels',
  auth: { apiKey: envApiKeyAuth('Pixels API key', ['PIXELS_API_KEY']) },
  models: [{
    type: 'image',
    id: 'flux-pro',
    name: 'FLUX Pro',
    api: 'pixels-images',
    provider: 'pixels',
    baseUrl: 'https://api.pixels.test/v1',
    input: ['text'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
  images: {
    'pixels-images': { generateImages: async (model, context, options) => { /* ... */ } },
  },
});
models.setProvider(pixels);
```

旧版的全局 API（`getImageModel()` / `getImageModels()` / `getImageProviders()` / `generateImages()`）依然可以在 [compat 入口](#从旧版全局-api-迁移) 中继续使用：

```typescript
import { getImageModel, generateImages } from '@earendil-works/pi-ai/compat';

const model = getImageModel('openrouter', 'google/gemini-2.5-flash-image');
const result = await generateImages(model, {
  input: [{ type: 'text', text: '在纯白底色上绘制一个鲜红色的圆形。' }]
}, {
  apiKey: process.env.OPENROUTER_API_KEY
});
```

部分图像模型还支持图像输入（图生图）：

```typescript
import { readFileSync } from 'fs';

const imageBuffer = readFileSync('input.png');
const result = await models.generateImages(model, {
  input: [
    { type: 'text', text: '将该图像做个变体，背景改为蓝色。' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ]
});
```

可通过模型元数据检查其出入能力：

```typescript
console.log(model.input);  // ['text'] 或 ['text', 'image']
console.log(model.output); // ['image'] 或 ['image', 'text']
```

### 注意事项与限制

- 图像模型与对话模型统一存放在 `Models` 和 `Provider` 中；请使用 `getModelsOfType('image')` 列出它们，并使用 `generateImages()` 调用，切勿使用 chat/stream 接口；
- 图像生成模型不支持工具调用（Tool Calling）；
- 输出结果存放在 `AssistantImages.output` 中，可能包含 Base64 编码的 `ImageContent` 块以及 `TextContent` 文本块；
- 某些模型只返回图片，另一些会返回图片及文字说明，请通过 `model.output` 判定；
- 某些模型支持图生图，另一些仅支持文生图，请通过 `model.input` 判定；
- 与流式 API 类似，图像生成支持 `apiKey`、`signal`、`headers`、`onPayload`、`onResponse` 等配置项，结果同样包含 `stopReason`、`responseId` 以及 `usage`；
- 如果你希望在多轮对话中让模型分析图片或执行工具，请使用支持图片输入的常规对话模型；
- 目前，内置图像生成能力仅在 OpenRouter Provider 中开放。

---

## 分类器

分类器模型（Classifier Models）专门用于消费结构化的 JSON 状态以及可选的图像，并针对其回答一个或多个带类型的分类问题。它们不使用传统的 Chat 或生图 API。TypeSafe 的 Jev 模型、Cloudflare 的 Clef 系列模型以及 OpenAI 的 GPT-6 Luna 可在以下内置 Provider 中使用：

| 提供商 (Provider) | 模型 ID | 所需认证 |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `typesafe/jev-1.14`, `~typesafe/jev-latest`, `cloudflare/clef`, `cloudflare/clef-flash`, `cloudflare/clef-omni` | `OPENROUTER_API_KEY` 或 OpenRouter OAuth |
| `cloudflare-workers-ai` | `typesafe/jev`, `typesafe/jev-1.14.0`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`, `@cf/cloudflare/clef-omni` | `CLOUDFLARE_API_KEY` 与 `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |

```typescript
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

const models = builtinModels();
const model = models.getModelOfType('classifier', 'typesafe', 'jev-latest')!;
const result = await models.classify(model, {
  state: { message: '这个改动完美解决问题，多谢！' },
  questions: {
    category: {
      type: 'choice',
      instructions: '对该消息进行意图分类。',
      criteria: {
        approval: '用户认可当前结果',
        correction: '用户要求修改或纠错'
      }
    },
    satisfaction: {
      type: 'score',
      instructions: '评估用户满意度。',
      criteria: ['dissatisfied', 'neutral', 'satisfied']
    },
    approved: {
      type: 'bool',
      instructions: '用户是否表示同意？',
      criteria: { true: '同意', false: '不同意' }
    }
  }
});

console.log(result.answers);
```

对外统一约定使用 `bool` 问题以及 `{ type: "bool", probability }` 答案。TypeSafe 适配器会自动在底层的 `noul` 线格式与该标准结构间双向转换。与图像生成一样，`classify()` 在遇到 Provider 认证失败或响应错误时，会返回带有 `stopReason: "error"` 的结果对象，而不是直接 reject。

当服务上报 Token 消耗时，`result.usage` 会返回 Token 数及目录价格，数据结构与对话消息的 `Usage` 一致。所有 System One 服务均会上报 Token；即使返回了畸形数据，只要产生计费就会保留 usage。本地分类器（如 `llama-cpp-classify`）不上报 usage。

`ClassifierOptions.temperature` 用于在归一化之前对 logits 进行缩放；大于 1 的值会让预测概率分布更加平缓。对于无法控制温度的服务（如 System One 和 OpenAI Decisions），该选项会被忽略。

`ClassifierContext.images` 可携带图像块（`{ type: "image", data, mimeType }`），以便结合状态统一判别。只有在 `input` 中明确声明包含 `"image"` 的模型才允许传入图像，其它模型调用时会直接返回错误结果。

### System One 图像

System One 服务支持三种形式的图像传输。模型的 `compat.imageInput` 决定其模式（`"assets"`、`"images"` 或 `"state-image-urls"`），`compat.sendImageOptInHeader` 则控制 TypeSafe 的实验性请求头：

- **TypeSafe**（`typesafe` 以及 Workers AI 上的 Jev）：以 `assets` 形式发送 PNG 和 JPEG，即 `{ "<image-1>": { type: "image", format: "png", data_base64 } }`。请求中必须引用全部 asset，因此 state 会包装成 `["<image-1>", ..., state]` 的格式发出。在 TypeSafe 自身 API 上图像属于实验性特性，需要附带 `TypeSafe-Danger-Zone-Images: true` 请求头。
- **Workers AI 上的 Clef**：最多支持 4 张 PNG/JPEG/WebP 图片，作为独立于原 state 的 Data URL 数组通过 `images` 字段传输。
- **OpenRouter**：将图片以 `{ type: "image_url", image_url: { url } }` 的形式拼在 state 之前：`[part, ..., state]`。若用 `assets` 模式向其发送，OpenRouter 不会报错但会静默丢弃图片。

内置目录已显式设定了 `compat`，即使通过反向代理也能正确传输。对于未明确标注的模型，API 会自动嗅探：Provider 为 `openrouter` 或 `baseUrl` 包含 `openrouter.ai` 则使用 OpenRouter 格式；模型 ID 以 `@cf/cloudflare/clef` 开头使用 Clef 格式；其余默认采用带实验头的 TypeSafe 格式。如果你自建的 Provider 经由中转访问 OpenRouter，务必显式指定 `compat.imageInput: "state-image-urls"` 与 `compat.sendImageOptInHeader: false`，否则 OpenRouter 会丢失图片。

Vercel AI Gateway 和 OpenCode 的 Jev 模型目前仅注册了文本输入能力。

### OpenAI Decisions

`openai-decisions` API 对接 OpenAI 的 [Decisions API](https://developers.openai.com/api/docs/guides/decisions)（`POST /v1/decisions`）。GPT-6 Luna 是其唯一的模型。State 会以 JSON 文本发送；若包含图片，则组合为一条 User 消息，先放置 state，随后附带最多 128 张 Data URL 格式的图片。`choice` 和 `score` 问题对应 Decisions API 中同名类型；`bool` 问题映射为 `predicate`，由于 predicate 没有 criteria 字段，true 和 false 的定义会自动追加到 instructions 描述末尾。若 OpenAI 拒绝回答某个问题，整个调用结果均标记为 error。Usage 仅统计输入 Token，按目录输入单价并计入 OpenAI 的长上下文乘数。

该端点必须使用 OpenAI API Key；不支持 ChatGPT 订阅登录（OAuth），因此在处于 OAuth 登录态时，`openai` Provider 会在 `getAvailableOfType('classifier')` 中对 `gpt-6-luna` 进行隐藏。API 不接受超过 922K Token 的超大输入；且请求耗时超过约 5 秒（目前约超过 600K 输入 Token）时便会因网关超时（504）而失败。

### llama.cpp 对话模型作为分类器

llama.cpp 也原生支持通过 `/v1/systemone` 运行 Julia-1 或 Kev 等判定模型。自 llama.cpp 0.6.0 起，此类模型的 `architecture.output_modalities` 会标明包含 `decisions`。它们可以直接通过 `typesafe-system-one` API 与服务端 `/v1` 地址交互；若服务未启动 `--api-key`，则传入的 API Key 会被服务端忽略。对于普通对话模型，则通过 `llama-cpp-classify` 适配器作为降级方案。

`llama-cpp-classify` API 能将 `llama-server` 托管的普通对话模型转化为分类器。每个问题会被包装成一个 Chat Prompt：先放 state，紧接着列出所有问题，再次重复 state，最后列出当前问题及其单 Token 形式的选项（单选为字母，布尔为 `Yes`/`No`，打分为数字）。在当前请求的所有问题中，前半段完全一致，从而能命中服务端 Prompt Cache 对 state 仅评测一次。服务端返回下一个 Token 的 log-probabilities，答案即为对应选项 Token 的 Softmax 概率。单选支持多达 62 个选项，评分支持多达 10 个梯度。模型的 `baseUrl` 即为服务器根地址；末尾的 `/v1` 会被自动忽略。在 Router 模式下，模型 ID 可用于选择底座模型。

```typescript
import { createProvider } from '@earendil-works/pi-ai';
import { llamaCppClassifyApi } from '@earendil-works/pi-ai/api/llama-cpp-classify.lazy';

const provider = createProvider({
  id: 'local-llama',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [{
    type: 'classifier',
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    api: 'llama-cpp-classify',
    provider: 'local-llama',
    baseUrl: 'http://127.0.0.1:8080',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768
  }],
  classifiers: { 'llama-cpp-classify': llamaCppClassifyApi() }
});
```

原始输出的标签概率通常过于绝对；建议传入大于 1 的 `temperature` 进行平滑。

在自定义 Provider 中注册分类器模型及实现：

```typescript
createProvider({
  id: 'classifier-service',
  auth,
  models: [model],
  classifiers: {
    'classifier-api': { classify: async (model, context, options) => result }
  }
});
```

---

## 思考 / 推理

众多前沿模型支持思考/深度推理能力，能够输出其内部的思维链（Thought Process）。你可以通过 `reasoning` 属性确认模型是否具备此能力。向不支持推理的模型传递思考参数会被安全地静默忽略。

### 统一接口 (streamSimple/completeSimple)

```typescript
// 众多厂商的旗舰模型均支持思考 / 深度推理
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
// 或 models.getModel('openai', 'gpt-5-mini');
// 或 models.getModel('google', 'gemini-2.5-flash');
// 或 models.getModel('xai', 'grok-4.7');

// 检查模型是否具备推理能力
if (model.reasoning) {
  console.log('模型支持思考与推理能力');
}

// 使用统一的思考预算级别
const response = await models.completeSimple(model, {
  messages: [{ role: 'user', content: '求解方程：2x + 5 = 13', timestamp: Date.now() }]
}, {
  reasoning: 'medium'  // 可选值：'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
});

// 分别提取思考过程和正文文本
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('思考过程:', block.thinking);
  } else if (block.type === 'text') {
    console.log('最终回复:', block.text);
  }
}
```

`xhigh` 与 `max` 属于特定模型自愿开启的高阶级别。使用 `getSupportedThinkingLevels(model)` 判定具体模型是否开放了这两个级别（如 GPT-5.6 能够同时支持两者）。

### 提供商专属选项 (stream/complete)

`models.stream()` / `complete()` 允许传入底层 API 完整的原生参数。配合 `hasApi()` 守卫可以精确收窄动态模型类型，享受完整的类型提示：

```typescript
import { hasApi } from '@earendil-works/pi-ai';

// OpenAI 原生推理选项 (o1, o3, gpt-5)
const openaiModel = models.getModel('openai', 'gpt-5-mini')!;
if (hasApi(openaiModel, 'openai-responses')) {
  await models.complete(openaiModel, context, {
    reasoningEffort: 'medium',
    reasoningSummary: 'detailed'  // 仅适用于 OpenAI Responses API
  });
}

// Anthropic 原生思考配置
const anthropicModel = models.getModel('anthropic', 'claude-sonnet-4-5')!;
if (hasApi(anthropicModel, 'anthropic-messages')) {
  await models.complete(anthropicModel, context, {
    thinkingEnabled: true,
    thinkingBudgetTokens: 8192  // 指定最大思考 Token 预算
  });
}

// Google Gemini 思考配置
const googleModel = models.getModel('google', 'gemini-2.5-flash')!;
if (hasApi(googleModel, 'google-generative-ai')) {
  await models.complete(googleModel, context, {
    thinking: {
      enabled: true,
      budgetTokens: 8192  // -1 为动态自适应，0 为禁用
    }
  });
}
```

### 流式接收思考内容

在流式响应中，思考过程通过专属事件流送：

```typescript
const s = models.streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[模型开始深度思考]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 实时输出思考流
      break;
    case 'thinking_end':
      console.log('\n[思考完毕]');
      break;
  }
}
```

---

## 停止原因

每个 `AssistantMessage` 都包含一个 `stopReason` 字段，用于指示生成由于何种原因结束：

- `"pending"` - 仅出现在未完成的部分消息中，代表当前尚不明确最终结束原因；
- `"stop"` - 正常结束，模型在本轮对话中已完成全部内容的输出；
- `"length"` - 输出达到上下文或设置的最大 Token 上限被截断；
- `"toolUse"` - 模型发起了工具调用，正在等待外部回传工具执行结果；
- `"error"` - 生成过程中发生了错误；
- `"aborted"` - 外部调用通过 AbortSignal 中途取消了请求。

如果底层协议支持返回上游响应 ID，`AssistantMessage` 还会带上 `responseId`。需要注意，不同 Provider 之间不能假设此字段必定存在。

---

## 遥测与监控

你可以通过 `telemetry` 传递显式的父级追踪 Span（`TelemetrySpan` 类型，非 Adapter）；未提供时使用空操作 Span（no-op）：

```typescript
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();
await telemetry.startSpan({ name: 'application.turn' }, async (span) => {
  await models.completeSimple(model, context, { telemetry: span });
});
```

`Models.stream()` 与 `streamSimple()` 会创建名为 `pi.ai.request` 的 Span；`streamDeferred()` 则为每一次轮询创建 `pi.ai.poll`。上层的 complete 辅助函数复用相同的 Span。这些 Span 完整覆盖了认证与请求建立，在生成彻底结束时关闭，且不强制调用方必须消耗流式事件。直接调用底层 Provider/API 的请求不会自动注入监控。

根模块及 `@earendil-works/pi-ai/models` 导出了标准词汇表 `AI_TELEMETRY_SCHEMA`：

- **Start 属性**：包含 `provider`、`api`、`model`；且仅在 `options.reasoning` 为字符串时记录 `reasoning`（Provider 原生的复杂推理对象会被忽略）。
- **End 属性**：包含 `stop`、`usage.input`、`usage.output`、`usage.cache_read`、`usage.cache_write`、`cost.total` 以及可选的 `response.id`。当 `stop: "error"` 时，错误状态归类为固定的 `provider_error`，且 `AssistantMessage.errorMessage` 会截断至最多 500 字符（不存在时为空）。用户主动取消时保持 `ok` 状态，并标记 `stop: "aborted"`。
- `pi.ai.first_chunk` 标记第一个规范化事件到达的时刻（包括配置初始化错误）。每个文本、思考或工具调用块完成时触发 `pi.ai.block` 事件，附带 `type`、`index` 和 `chars` 字符数；仅工具调用附带 `tool`。字符数统计基于 JS 字符串长度；工具参数通过累加 delta 长度计算，无需重新序列化。

当 `options.telemetry.metrics` 可用时，会自动上报指标：

| 指标 (Metric) | 单位 (Unit) | 标签属性 (Attributes) |
|---|---|---|
| `pi.ai.request.duration` | `ms` | `provider`, `model`, `stop` |
| `pi.ai.first_chunk.duration` | `ms` | `provider`, `model` |
| `pi.ai.tokens` | `token` | `provider`, `model`, `kind` (`input`, `output`, `cache_read`, `cache_write`) |
| `pi.ai.cost` | `USD` | `provider`, `model` |

耗时采用 `performance.now()` 计算。挂起/延迟轮询不会累加 Token 和费用；只有最终完成或报错的轮询才会记录。不支持指标能力的父 Span 依然完全可用，仅静默跳过指标记录。

遥测机制**严禁**将用户的 Prompt、生成文本、思考过程细节或工具参数明文写入属性或事件。错误信息仅包含最多 500 字符的 Provider 原始报错，请根据所在机构的数据出境策略审慎导出。响应 ID 与错误详情绝不会被放入 Metric 标签中。

---

## 错误处理

流式对象（Stream）被成功返回后，其后续的失败**绝不会抛出未捕获的 Promise 异常**：当请求异常终止（包括超时中断、用户中止和工具参数校验失败）时，流会触发 `error` 事件，最终的消息对象中会封装详尽的失败信息。如果在生成开始前初始化阶段就失败，流会直接输出 `error` 事件（没有 `start`）；如果是生成中途故障，则会有 `start`、部分 update 事件，随后发出 `error`。底层 API 的 `streamSimple()` 仅在缺少必要认证凭据时同步抛出异常。

```typescript
// 流式监听
for await (const event of s) {
  if (event.type === 'error') {
    // event.reason 可能是 "error" 或 "aborted"
    // event.error 则是包含已接收部分内容的 AssistantMessage
    console.error(`发生错误 (${event.reason}):`, event.error.errorMessage);
    console.log('已接收到的部分内容:', event.error.content);
  }
}

// 最终消息中也会沉淀错误信息
const message = await s.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('请求未成功:', message.errorMessage);
  // message.content 包含发生错误前已接收到的片段
  // message.usage 依然保留已消耗的局部 Token 和费用统计
}
```

在使用 Provider 集合时，认证故障（如 OAuth 刷新失败、Provider 不存在）会作为 `stopReason: "error"` 的流式错误暴露。

### 中止请求

你可以通过 `AbortSignal` 随时取消正在进行中的请求。被取消的请求其 `stopReason === 'aborted'`：

```typescript
const controller = new AbortController();

// 2 秒后强制中止
setTimeout(() => controller.abort(), 2000);

const s = models.stream(model, {
  messages: [{ role: 'user', content: '请写一篇很长的科幻小说', timestamp: Date.now() }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason 能清晰区分是被中止还是发生错误
    console.log(`${event.reason === 'aborted' ? '用户中止' : '发生错误'}:`, event.error.errorMessage);
  }
}

// 获取部分结果
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('请求已被取消:', response.errorMessage);
  console.log('取消前接收到的内容:', response.content);
  console.log('已消耗 Token:', response.usage);
}
```

### 中止后恢复会话

被取消的消息依然可以安全地放回上下文，并在后续请求中让模型继续生成：

```typescript
const context = {
  messages: [
    { role: 'user', content: '请详细解释量子计算的原理', timestamp: Date.now() }
  ]
};

// 第一次请求在 2 秒后取消
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await models.complete(model, context, { signal: controller1.signal });

// 将已生成的部分内容加入上下文
context.messages.push(partial);
context.messages.push({ role: 'user', content: '请接着上面的内容继续说', timestamp: Date.now() });

// 恢复并继续生成
const continuation = await models.complete(model, context);
```

### 调试 Provider 请求载荷

使用 `onPayload` 回调可以审查最终发送给 Provider 的底层 HTTP Request Payload。这对于排查 Prompt 格式化异常或模型服务端的校验报错极有帮助。

```typescript
const response = await models.complete(model, context, {
  onPayload: (payload) => {
    console.log('发往 Provider 的完整载荷:', JSON.stringify(payload, null, 2));
  }
});
```

该回调在 `stream`、`complete`、`streamSimple` 和 `completeSimple` 中均受支持。

### 监听 Provider 原生流式事件

使用 `onProviderStreamEvent` 回调可以拦截 Provider 返回的、但未被 Pi 纳入标准 `AssistantMessage` 的厂商专属字段。该回调在数据被 Pi 标准化之前触发。请将此事件视为只读对象，修改可能会干扰后续的标准化处理。该事件不一定是原始的 HTTP 二进制字节或 SSE 帧。

```typescript
const openRouterModel = models.getModel('openrouter', 'openrouter/auto')!;
const response = await models.complete(openRouterModel, context, {
  headers: { "X-OpenRouter-Metadata": "enabled" },
  onProviderStreamEvent: (data) => {
    const chunk = data as Record<string, unknown>;
    if (chunk.openrouter_metadata) {
      console.log(chunk.openrouter_metadata);
    }
  },
});
```

回调是按流式顺序 `await` 执行的，耗时过长会阻塞流消费，抛出异常会导致请求失败。基于厂商 SDK 封装的适配器只能读取其 SDK 未丢弃的字段。

---

## 自定义提供商

### createProvider()

`createProvider()` 允许你自由拼装一个 Provider：提供身份标识、认证实现、模型清单以及 API 通信实现（对话模型使用 `api`，生图使用 `images`，分类器使用 `classifiers`，至少提供其一）。适用于自建本地模型服务器、中转代理或任意兼容 OpenAI/Anthropic 的服务端点：

```typescript
import { createModels, createProvider, envApiKeyAuth, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

const ollama = createProvider({
  id: 'ollama',
  name: 'Ollama',
  baseUrl: 'http://localhost:11434/v1',
  // 每个 Provider 都必须声明认证；无需秘钥的本地服务可直接 resolve 空对象
  auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
  models: [ollamaModel],
  api: openAICompletionsApi(),
});

const models = createModels();
models.setProvider(ollama);

await models.complete(models.getModel('ollama', 'llama-3.1-8b')!, context);
```

对于拥有正式 Key 的中转服务，使用 `envApiKeyAuth(displayName, envVars)` 可获得标准行为（优先使用已保存凭据，其次按顺序读取环境变量）：

```typescript
const proxy = createProvider({
  id: 'my-proxy',
  auth: { apiKey: envApiKeyAuth('我的代理服务 API Key', ['MY_PROXY_API_KEY']) },
  models: [/* ... */],
  api: openAICompletionsApi(),
});
```

针对混合协议的 Provider，可在 `api` 属性传入以 `model.api` 为 Key 的映射表，请求会自动分发到对应的 API 实现：

```typescript
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';

const gateway = createProvider({
  id: 'my-gateway',
  auth: { apiKey: envApiKeyAuth('网关秘钥', ['GATEWAY_API_KEY']) },
  models: [/* 同时包含 api 为 'anthropic-messages' 或 'openai-responses' 的模型 */],
  api: {
    'anthropic-messages': anthropicMessagesApi(),
    'openai-responses': openAIResponsesApi(),
  },
});
```

Provider 级别的端点或请求重写应封装在其 API 实现中：通过包装传入 `api` 的 `ProviderStreams`，让每个请求在正式发送前都经过这层变换。Cloudflare Provider 正是利用这一机制从环境变量中动态替换租户和网关地址占位符：

```typescript
function tenantStreams(streams: ProviderStreams): ProviderStreams {
  const withTenant = (model: Model<Api>) => ({ ...model, baseUrl: model.baseUrl.replace('{tenant}', tenantId) });
  return {
    stream: (model, context, options) => streams.stream(withTenant(model), context, options),
    streamSimple: (model, context, options) => streams.streamSimple(withTenant(model), context, options),
  };
}

const tenantGateway = createProvider({
  id: 'tenant-gateway',
  auth: { apiKey: envApiKeyAuth('Gateway key', ['GATEWAY_API_KEY']) },
  models: [/* ... */],
  api: tenantStreams(openAICompletionsApi()),
});
```

动态模型列表可以通过 `fetchModels` 抓取并返回任意类型的模型。`Models.refresh()` 会刷新所有已配置的动态 Provider，并自动传递生效的 API Key 或已刷新的 OAuth 凭据。`ModelsStore` 可用于持久化动态目录；默认均采用内存实现。其 `read`、`write` 和 `delete` 均支持取消信号，`Models` 会将等待过程与 Provider 刷新的信号绑定。

```typescript
const models = createModels({ credentials, modelsStore });
const llamacpp = createProvider({
  id: 'llamacpp',
  auth: { apiKey: { name: 'llama.cpp', resolve: async () => ({ auth: {} }) } },
  models: [],
  fetchModels: async ({ signal }) => fetchModelsFromServer('http://localhost:8080', signal),
  api: openAICompletionsApi(),
});

models.setProvider(llamacpp);
const result = await models.refresh({ signal });
if (result.aborted) console.log('刷新已取消');
for (const [provider, error] of result.errors) console.error(provider, error);
```

省略信号时 `Models.refresh()` 无限期等待。Provider 实现必定会接收到具体的 `RefreshModelsContext.signal`，且必须在网络请求和阻塞操作中响应取消。即使自定义 Provider 未能良好协作，一旦调用方发出中止信号，`Models.refresh()` 也会立刻返回 `aborted: true`。

可使用 `models.refresh({ providers: ['openrouter'] })` 仅刷新指定厂商；使用 `models.refresh({ allowNetwork: false })` 仅恢复本地持久化的模型目录而不发起网络请求；或使用 `models.refresh({ force: true })` 强制跳过新鲜度检查。模型查询始终保持同步，返回最近恢复或刷新出的模型清单。

`createProvider()` 自动处理动态发布与持久化。手写的 `Provider.refreshModels()` 实现会接收只读的 `context.stored` 快照，并通过 `context.publish({ persist?, update? })` 进行发布。省略 `persist` 保持存储不变；传入 `ModelsStoreEntry` 写入存储；传入 `persist: null` 则清空。发布操作具备代际冲突检查（Generation-checked）。

自定义模型还可以携带专属 `headers`（例如穿透反爬或反向代理）以及 `compat` 兼容性参数。`Models.getAuth(model)` 会自动合并这些模型请求头，且流式方法会在显式请求头和 `transformHeaders` 执行前将其注入。参见 [OpenAI 兼容性设置](#openai-兼容性设置)。

部分兼容 OpenAI 的推理服务无法识别针对推理模型引入的 `developer` 角色。此时可将 `compat.supportsDeveloperRole` 设置为 `false`，系统提示词将改以常规的 `system` 角色发送。如果服务端同时不支持 `reasoning_effort` 参数，一并将 `compat.supportsReasoningEffort` 设为 `false`。这在 Ollama、vLLM、SGLang 等开源服务端点上非常普遍。

使用模型级别的 `thinkingLevelMap` 来映射模型特定的思考力度控制。Map 的 Key 为 pi 内部的思考等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。常规级别至 `high` 未配置时使用 Provider 默认规则；`xhigh` 与 `max` 为自愿开启项，要求提供非空映射值。字符串值将直接发送给 Provider，`null` 标记为不支持：

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

### 直接调用 API 底层实现

各个底层的 API 通信实现支持独立导入。每个模块均精准导出 `stream` 与 `streamSimple` 函数，具备该 API 专属的完整参数类型。直接调用会绕过 Provider 的认证和上下文规整逻辑——需要显式传入 `apiKey` 并用 `normalizeContext()` 包裹上下文：

```typescript
import { normalizeContext } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/anthropic-messages';

const s = stream(claudeModel, normalizeContext(context), {
  apiKey: process.env.ANTHROPIC_API_KEY,
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048,
});
```

内置 API 实现位于 `./api/<api-id>`：

| API ID | 选项类型 (Options Type) |
|---|---|
| `anthropic-messages` | `AnthropicOptions` |
| `openai-completions` | `OpenAICompletionsOptions` |
| `openai-responses` | `OpenAIResponsesOptions` |
| `openai-codex-responses` | `OpenAICodexResponsesOptions` |
| `azure-openai-responses` | `AzureOpenAIResponsesOptions` |
| `google-generative-ai` | `GoogleOptions` |
| `google-vertex` | `GoogleVertexOptions` |
| `mistral-conversations` | `MistralOptions` |
| `bedrock-converse-stream` | `BedrockOptions` |

直接导入具体的实现模块会立即引入对应厂商的官方 SDK。而 `./api/<id>.lazy` 模块（被 Provider 工厂广泛使用）则在打包器或运行时支持动态导入时，将 SDK 的加载推迟到首个真实请求发生。

### OpenAI 兼容性设置

`openai-completions` 协议被众多厂商实现，但细节上往往存在细微差异。默认情况下，类库会根据常见厂商的 `baseUrl`（如 Cerebras、xAI、Chutes、DeepSeek、NVIDIA NIM、Together AI、zAi、OpenCode、Cloudflare Workers AI 等）自动嗅探兼容性设置。对于自建代理或未收录的端点，你可以通过 `compat` 字段显式覆盖这些行为：

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // 是否支持 `store` 字段（默认: true）
  supportsDeveloperRole?: boolean;   // 是否支持 `developer` 角色替代 `system`（默认: true）
  supportsReasoningEffort?: boolean; // 是否支持 `reasoning_effort` 选项（默认: true）
  supportsUsageInStreaming?: boolean; // 流式下是否支持 `stream_options: { include_usage: true }`（默认: true）
  supportsStrictMode?: boolean;      // 工具定义是否支持 `strict`（默认: false；内置支持的模型在元数据中开启）
  supportsOpenAIGrammarTools?: boolean; // 是否生成 OpenAI 自定义 Lark/Regex 语法工具；false 则回退为普通函数工具（默认: false）
  supportsMidConvoSystemMessages?: boolean; // 会话开始后是否仍支持追加 system 消息；false 则会将后续 system 折叠合并到开头的提示词中（默认: false）
  supportsMidConvoToolAdditions?: boolean; // 后续系统消息是否可以通过 Kimi 风格的 tools 追加新工具；依赖 supportsMidConvoSystemMessages（默认: false）
  sendSessionAffinityHeaders?: boolean; // 是否基于 `sessionId` 发送会话亲和性请求头（默认: OpenRouter 为 true，其余为 false）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和格式（默认: 自动嗅探）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 最大 Token 字段名（默认: max_completion_tokens）
  requiresToolResultName?: boolean;  // 工具执行结果中是否必须附带 `name` 字段（默认: false）
  requiresAssistantAfterToolResult?: boolean; // 工具结果后是否必须跟随 assistant 消息（默认: false）
  requiresThinkingAsText?: boolean;  // 思考块是否必须转换为普通正文文本发送（默认: false）
  requiresReasoningContentOnAssistantMessages?: boolean; // 开启推理时，历史回放的 assistant 消息是否必须包含空的 reasoning_content（默认: DeepSeek 下自动开启）
  thinkingFormat?: 'openai' | 'openrouter' | 'deepseek' | 'together' | 'baseten' | 'zai' | 'qwen' | 'chat-template' | 'qwen-chat-template' | 'string-thinking' | 'ant-ling'; // 思考参数格式（默认: openai）
  chatTemplateKwargs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // 针对 chat-template 传参；使用 $var 注入动态思考值
  chatTemplateArgs?: Record<string, string | number | boolean | null | { '$var': 'thinking.enabled' | 'thinking.effort' | 'thinking.budget'; omitWhenOff?: boolean }>; // 针对 baseten 的 chat_template_args 传参
  thinkingTokenBudgetField?: 'thinking_token_budget' | 'thinking_budget' | 'thinking_budget_tokens'; // 限制思考 Token 的根字段名（vLLM / Qwen / llama.cpp，默认关闭）
  supportsThinkingTokenBudget?: boolean; // thinkingTokenBudgetField: 'thinking_token_budget' 的别名（vLLM）
  cacheControlFormat?: 'anthropic';  // 在 system prompt、最后一个工具及最后一条用户/回复内容上标记 Anthropic 风格的 cache_control
  openRouterRouting?: OpenRouterRouting; // OpenRouter 路由偏好设置（默认: {}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway 路由偏好设置（默认: {}）
}

interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;   // 是否支持 `developer` 角色（默认: true）
  sessionAffinityFormat?: 'openai' | 'openai-nosession' | 'openrouter'; // 会话亲和头格式
  supportsLongCacheRetention?: boolean; // 是否支持 `prompt_cache_retention: "24h"`（默认: true）
  supportsStrictMode?: boolean;      // 是否支持严格 JSON Schema 函数工具（默认: false；内置 OpenAI 模型开启）
  supportsOpenAIGrammarTools?: boolean; // 是否发射 OpenAI 自定义语法工具（默认: false）
}
```

启用 Prompt 缓存时，发往 OpenRouter 的请求会携带基于 `sessionId` 生成的 `x-session-id` 请求头。Chat Completions 与 Anthropic Messages 均会自动嗅探 OpenRouter 端点（除非显式将 `sendSessionAffinityHeaders` 设为 false）。在 Anthropic 兼容模型上，`sessionAffinityFormat: "openrouter"` 选择发送 `x-session-id`；未设置时使用原有的 `x-session-affinity` 格式。显式传入的请求头优于自动生成的头。

若未声明 `compat`，类库将完全依赖 URL 特征嗅探；若仅配置了部分属性，未指定的属性将继承嗅探得出的默认值。这非常适用于：
- **LiteLLM 反向代理**：可能不兼容 `store` 字段；
- **自研推理服务**：参数名称或字段定义非标；
- **私有部署端点**：不支持部分高级企业级特性。

---

## 用于测试的虚拟提供商

`fauxProvider()` 可在内存中构造一个可预设编排响应的虚拟 Provider，专门用于自动化单元测试或离线演示：

```typescript
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai';

const faux = fauxProvider({
  tokensPerSecond: 50 // 可选：模拟打字机流式输出速率
});

const models = createModels();
models.setProvider(faux.provider);

const model = faux.getModel();
const context = {
  messages: [{ role: 'user', content: '总结 package.json 并调用 echo 工具', timestamp: Date.now() }]
};

// 预设第一次回复：先输出思考，然后触发工具调用
faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('需要先检查 package 元数据。'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await models.complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

// 回填工具执行结果
context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: '此处为 package.json 的文件内容' }],
  isError: false,
  timestamp: Date.now()
});

// 预设第二次回复：接收到工具结果后输出最终结论
faux.setResponses([
  fauxAssistantMessage([
    fauxThinking('现在我可以根据工具返回的内容进行总结了。'),
    fauxText('这是总结内容。')
  ])
]);

// 也可以像真实模型一样流式接收
const s = models.stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 支持多虚拟模型（例如测试跨模型切换场景）
const multiModel = fauxProvider({
  provider: 'faux-multi',
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
models.setProvider(multiModel.provider);
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(faux.getPendingResponseCount());
console.log(faux.state.callCount);
```

**特性说明：**
- 预设响应按照请求发起的先后顺序先进先出（FIFO）消耗；
- 若预设队列被消耗完毕，虚拟 Provider 会返回带有 `errorMessage: "No more faux responses queued"` 的错误回复；
- 使用 `faux.setResponses([...])` 替换剩余队列，或使用 `faux.appendResponses([...])` 追加响应；
- `faux.models` 暴露所有虚拟模型。`faux.getModel()` 返回首个模型，`faux.getModel(id)` 返回特定模型；
- 使用 `fauxAssistantMessage(...)` 构造虚拟响应，使用 `fauxText(...)`、`fauxThinking(...)` 与 `fauxToolCall(...)` 快速拼装内容块，无需手动填充繁琐的底层元数据；
- Token 消耗按照每 4 个字符约合 1 个 Token 自动估算。提供 `sessionId` 且启用了 Prompt 缓存时，会自动模拟 Prompt Cache 的读写计数；
- 工具调用的参数通过 `toolcall_delta` 分片逐步流式放出；
- 默认情况下每个增量片段在独立的微任务中发射；配置 `tokensPerSecond` 可以真实模拟物理打字机流式延时；
- 推荐每个测试用例维护一个独立的实例。如果需要测试并发流程，请创建拥有不同 `provider` ID 的独立虚拟实例。

---

## 跨 Provider 模型切换

本类库原生支持**在同一会话中途跨不同 LLM 厂商自由切换模型（Cross-Provider Handoffs）**。这使你能够在多轮交互过程中随意切换模型，同时完整保留整个对话的历史上下文——包括普通的对话文本、工具调用以及工具返回的图文结果。

当历史消息被发送给另一个不同的 Provider 时，类库会自动对其进行兼容性转换：

- **用户消息与工具结果消息**：完全保持原样透传；
- **同 Provider、同 API、同模型的历史 Assistant 消息**：完全保持原样保留（包括思考过程与数字签名）；
- **来自其它模型的历史 Assistant 消息**：其思考块（Thinking Blocks）会被**自动剥离**。因为思考签名和加密推理仅对原生成模型有效，将前一个模型的思考明文作为普通文本发送会导致新模型误将其当成正文内容；
- **工具调用（Tool Calls）与普通正文文本**：完全保持原样保留。

```typescript
import { createModels, type Context } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());
models.setProvider(googleProvider());

const context: Context = { messages: [] };

// 第 1 步：使用 Claude 开始对话（开启深度思考）
const claude = models.getModel('anthropic', 'claude-sonnet-4-5')!;
context.messages.push({ role: 'user', content: '25 乘以 18 等于多少？', timestamp: Date.now() });
context.messages.push(await models.completeSimple(claude, context, { reasoning: 'medium' }));

// 第 2 步：将会话切换给 GPT-5 — GPT-5 能看到 Claude 的最终回复，但 Claude 的思考过程已被自动剥离
const gpt5 = models.getModel('openai', 'gpt-5-mini')!;
context.messages.push({ role: 'user', content: '上面这个计算过程准确吗？', timestamp: Date.now() });
context.messages.push(await models.complete(gpt5, context));

// 第 3 步：将会话切换给 Gemini
const gemini = models.getModel('google', 'gemini-2.5-flash')!;
context.messages.push({ role: 'user', content: '最初提出的问题是什么？', timestamp: Date.now() });
const geminiResponse = await models.complete(gemini, context);
```

所有 Provider 都能无缝承接来自其它厂商的消息流——包括文本、工具调用与多模态结果、思考过程（跨模型时剥离）以及被用户中途取消的残缺内容。这为复杂 Agent 工作流带来了极大的灵活性：例如可以在初阶使用低延迟的小模型快速筛选，复杂步骤无缝移交给旗舰模型进行深度推理，或在某个厂商服务不可用时实现会话零丢失的降级熔断。

---

## 系统消息

`Context.systemPrompt` 与 `Context.tools` 是定义开篇系统消息的快捷属性。对外统一入口（`Models.stream()`、`streamSimple()`、`complete()`、`completeSimple()`）接收 `Context` 并统一调用 `normalizeContext()` 一次；在其下方的各层组件（包括 `Provider.stream()`、`ProviderStreams` 及底层通信模块）接收到的均是经过规整的 `TranscriptContext`，该对象仅保留 `messages` 列表。

对话记录允许在后续对话中再次插入新的系统消息，从而在不重写历史记录的前提下动态修改 Prompt 或变更可用工具列表：

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];             // 开篇首条：基础 Prompt；后续系统消息：追加的附加指令
  sections?: Record<string, string | null>;    // 命名 Prompt 分区；后续消息按名称补丁覆盖，null 表示删除
  toolsAdded?: Tool[];                         // 从本条消息开始新增生效的工具
  toolsRemoved?: ToolReference[];              // 从本条消息开始失效作废的工具
  timestamp: number;
}
```

Prompt 的 Sections 是紧跟在 `content` 之后逐字渲染的独立文本块，各块之间用空行分隔。建议为每个 Section 采用明确的自界定标记（如自定义标签、Markdown 标题），以便模型识别变更。按顺序回放遍历所有系统消息即可还原出当前生效的完整 Prompt 与可用工具列表：

```typescript
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

const messages: Message[] = [
  { role: "system", content: "你是一个得力的助手。", sections: { rules: "<rules>请保持简短。</rules>" }, toolsAdded: [readTool], timestamp: 1 },
  { role: "user", content: "你好", timestamp: 2 },
  { role: "system", content: "", sections: { rules: "<rules>请详细回答。</rules>" }, toolsRemoved: [{ name: "read" }], timestamp: 3 },
];

getCurrentSystemPrompt(messages); // "你是一个得力的助手。\n\n<rules>请详细回答。</rules>"
getCurrentTools(messages);        // []
```

自定义 `Provider` 或 `ProviderStreams` 实现同样通过 `context.messages` 提取 Prompt 和工具；在底层接口中不再存在 `context.systemPrompt` 与 `context.tools` 字段。

对于原生支持会话中途接收系统消息的模型（模型 `compat` 设置中开启了 `supportsMidConvoSystemMessages`，由生成的模型目录为经过验证的模型自动配置），后续的系统消息会原位发送给模型，从而最大程度保留模型前缀的 Prompt 缓存命中；分区变更会携带名称结构告知模型。其余模型则自动执行 `collapseSystemMessages(transcript)`：将回放合并后的最终 Prompt 与当前工具作为开篇第一条系统消息发送，后续的系统消息自动丢弃。

对于同时支持 `supportsMidConvoToolChanges` 的 Anthropic 模型（基于 `inline-tools-2026-09-15` beta 特性），工具变更会作为原生 Block 发送：最顶层工具列表包含初始工具及稳定的占位符且永不改变，后续新增工具在对应消息中以 `tool_addition` 发送（同名替换），删除以 `tool_removal` 引用发送，从而避免工具变更导致前缀 Prompt 缓存失效。OpenAI Responses 拥有 `supportsAdditionalTools` 的模型会将所有工具声明在 `additional_tools` 中（类似 Codex 机制）。Kimi 等模型则采用其自身的 mid-convo 挂载协议。

---

## 上下文序列化

`Context` 是一个标准的纯数据对象，可通过普通的 `JSON.stringify` 与 `JSON.parse` 轻松序列化与反序列化，极大简化了对话持久化、历史记录存储以及跨微服务传输的实现复杂度：

```typescript
const context: Context = {
  systemPrompt: '你是一个得力的助手。',
  messages: [
    { role: 'user', content: '什么是 TypeScript？', timestamp: Date.now() }
  ]
};

const model = models.getModel('openai', 'gpt-4o-mini')!;
const response = await models.complete(model, context);
context.messages.push(response);

// 序列化整个会话上下文
const serialized = JSON.stringify(context);

// 保存到数据库、localStorage、文件等
localStorage.setItem('conversation', serialized);

// 后续：从存储中恢复并继续多轮对话
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: '请详细讲讲它的类型系统', timestamp: Date.now() });

// 可以无缝切换为任何模型继续对话
const newModel = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const continuation = await models.complete(newModel, restored);
```

Model 对象本身同样是纯数据结构——不挂载任何函数或类方法实例——因此连同“当前会话使用的是哪一个模型”也可以简单地用 `JSON.stringify` 一同保存。

> **提示**：如果上下文中包含图片（以 Base64 字符串形式存放在 Image Input 中），这些图片也会完整随上下文一同被序列化。

---

## 浏览器环境使用

本类库原生支持在现代浏览器环境中运行。核心入口与各 Provider 工厂均为无副作用（Side-effect free）的纯模块，可以被打包器干净地打包。由于浏览器无法直接读取 `process.env` 环境变量，请显式传入 API Key——或者注入一个基于浏览器（如基于 `localStorage`）的持久化 `CredentialStore`：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel('anthropic', 'claude-3-5-haiku-20241022')!;
const response = await models.complete(model, {
  messages: [{ role: 'user', content: '你好！', timestamp: Date.now() }]
}, {
  apiKey: '你的API秘钥'
});
```

> **安全警告**：在前端代码中暴露真实的 API Key 极度危险，任何访问者都可以轻松提取并滥用你的凭据。此用法仅推荐用于内网工具或技术原型演示。在生产级应用中，请务必经由后端代理转发以保护 API Key。

浏览器兼容性注意事项：
- Amazon Bedrock（`bedrock-converse-stream`）不支持浏览器环境。模型列表中依然可见，但在浏览器调用时会报错；
- OAuth 登录流（OAuth Login Flow）属于 Node.js 专属。这些逻辑被打包器不可见（bundler-opaque）的动态加载保护，单纯注册支持 OAuth 的 Provider 不会将 Node 依赖打包到浏览器 Bundle 中——除非你真的在浏览器端尝试执行 `login()`；
- 若 Web 客户端需要连接 Bedrock 或执行 OAuth 登录，请在服务端部署代理中转。

---

## 打包与摇树优化

为了实现极小的前端体积及轻量级无打包脚本，推荐导入独立的模型运行时，并仅引入你所需要的 Provider：

```typescript
import { createModels } from '@earendil-works/pi-ai/models';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

const models = createModels();
models.setProvider(openaiProvider());
```

**依赖打包规则：**
- `@earendil-works/pi-ai/models`：仅导出模型运行时（`createModels`、`createProvider`、模型辅助方法及其类型），**不包含** Schema 校验引擎、内置全量目录或厂商 SDK 实现；
- `@earendil-works/pi-ai`：核心主入口，不预导入全量内置目录或厂商 SDK，但为了方便开箱即用，会直接打包 pi-schema 校验引擎；在未打包的原始 Node 脚本中，未使用的导出无法被摇树剔除；如对轻量有极高要求，建议按需引用 `./models`、`./providers/faux` 以及指定的 `./utils/*` 子路径；
- `@earendil-works/pi-ai/providers/<provider>`：仅导入该特定 Provider 的模型目录及懒加载的 API 包装器；
- `@earendil-works/pi-ai/providers/all`：全量入口，会打包全部内置 Provider 工厂与所有模型目录。仅在你确实需要支持全量模型的应用中使用；
- 在启用了代码分割（Code Splitting）的打包体系中，厂商 SDK 会作为独立的 Chunk 存放，按需加载；
- 若打包器关闭了代码分割，打包器会将当前用到的懒加载实现全部合并进主包中。单一 Provider 打包仅包含该厂商 SDK，而 `providers/all` 则会引入所有能静态分析到的 SDK。Bedrock 是唯一的例外：其 AWS SDK 通过动态隔离方式加载，不会意外打入前端包；
- 直接导入 `@earendil-works/pi-ai/api/<api-id>` 会立即全量加载对应的 API 模块及其依赖的官方 SDK。

在新的应用中应避免引入 `@earendil-works/pi-ai/compat`，该入口仅为保留旧版 API，会引入全量的内置目录。

对于单文件的 Node ESM 打包场景，某些上游 SDK 内部可能仍残留了 CommonJS 的动态 `require()` 调用。若遇到类似 `Dynamic require of "child_process" is not supported` 的报错，可以在打包时为 Node 垫入 `require`。使用 esbuild 示例如下：

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

Bedrock 是纯 Node 端功能。注册方式与普通 Provider 无异：

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { amazonBedrockProvider } from '@earendil-works/pi-ai/providers/amazon-bedrock';

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

在常规 Node 运行环境和代码分割打包中，Bedrock 会在首次调用时懒加载其 AWS SDK。如果你需要将项目打包成必须包含 Bedrock 的**单文件独立包**，可显式注册其实装模块：

```typescript
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';

setBedrockProviderModule(bedrockProviderModule);
```

通过显式注入，打包器便能感知并将 AWS SDK 完整打包进单文件中。

### 请求级 Provider 环境变量覆盖

在调用流式方法时，可在配置项中传入 `env` 字段，将特定环境配置的作用域限制在单次请求内。传入的 `env` 优先级高于操作系统环境变量，可用于配置 Provider 认证头、Cloudflare Account ID、Azure OpenAI 选项、Vertex 项目/区域、Bedrock 参数、`PI_CACHE_RETENTION` 以及 `HTTP_PROXY`/`HTTPS_PROXY` 等网络代理：

```typescript
const models = builtinModels();
const model = models.getModel('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6')!;

const response = await models.complete(model, context, {
  env: {
    CLOUDFLARE_API_KEY: '...',
    CLOUDFLARE_ACCOUNT_ID: 'account-id',
    CLOUDFLARE_GATEWAY_ID: 'gateway-id'
  }
});
```

适合在单进程中针对不同多租户请求动态切换上游配置，或避免进程环境变量污染特定外部调用的场景。

---

## OAuth 认证提供商

多个主流提供商原生支持 OAuth 认证，以取代传统的静态 API Key：

- **Anthropic**（Claude Pro/Max 个人订阅）
- **OpenAI**（Sign in with ChatGPT：将 ChatGPT 个人订阅用于 OpenAI 接口）
- **OpenAI Codex (旧版)**（ChatGPT Plus/Pro 订阅，访问 GPT-5.x Codex 系列模型）
- **GitHub Copilot**（Copilot 订阅）
- **OpenRouter**（通过 OAuth PKCE 授权签发用户自定义 API Key）

支持 OAuth 的 Provider 会在其 `provider.auth.oauth` 上挂载一个 `OAuthAuth` 实例，提供三大核心能力：
1. `login(interaction)`：基于通用的 `AuthInteraction.prompt()` / `notify()` 协议驱动交互式授权，并返回持久化凭据；
2. `refresh(credential, signal)`：当 Token 即将过期时自动执行静默刷新；
3. `toAuth(credential)`：将凭据转换为发往上游的实际请求认证（如 GitHub Copilot 的专属子域名端点由此生成）。

交互登录与刷新始终携带显式的取消信号。Token 刷新是在 `CredentialStore` 全局锁下自动完成的：`models.getAuth(providerId)` 和请求发起阶段都会在检测到过期时自动刷新，多请求/多进程并发也不会导致凭据失效。OpenRouter 的 OAuth 流程直接签发永久 Key，因此其刷新为空操作。

```typescript
import { createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

const models = createModels({ credentials: myStore }); // 注入持久化的 CredentialStore
models.setProvider(anthropicProvider());

// 执行登录流程：Models 会自动引导交互并将获取的 Token 保存至存储
await models.login('anthropic', 'oauth', {
  prompt: async (p) => {
    // p.type 支持: 'text' | 'secret' | 'select' | 'manual_code'
    // manual_code 提示会与本地临时回调服务竞争，若本地回调先捕获授权则 p.signal 会触发取消
    return await askUser(p.message);
  },
  notify: (event) => {
    // event.type 包含: 'info' | 'auth_url' | 'device_code' | 'progress'
    if (event.type === 'info') {
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? '更多详情'}: ${link.url}`);
    }
    if (event.type === 'auth_url') console.log(`请在浏览器中打开: ${event.url}`);
    if (event.type === 'device_code') console.log(`设备码: ${event.userCode}，验证地址: ${event.verificationUri}`);
    if (event.type === 'progress') console.log(event.message);
  },
});

// 登录完成后，后续的所有请求均会自动解析并自动静默刷新 Token
const model = models.getModel('anthropic', 'claude-sonnet-4-5')!;
await models.complete(model, context);

// 登出并清理凭证
await models.logout('anthropic');
```

### Vertex AI

Vertex AI 模型同时支持 Google Cloud API Key 与 Application Default Credentials (ADC)。其内置的 API Key 登录流程对两者均进行了适配：

- **API Key 方式**：配置 `GOOGLE_CLOUD_API_KEY` 或在调用选项中传入 `apiKey`；
- **本地开发环境 (ADC)**：在终端执行 `gcloud auth application-default login`；
- **CI / 生产部署环境 (ADC)**：配置 `GOOGLE_APPLICATION_CREDENTIALS` 指向服务账号（Service Account）JSON 密钥文件路径。

使用 ADC 时，还需配置 `GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）与 `GOOGLE_CLOUD_LOCATION`。使用 `GOOGLE_CLOUD_API_KEY` 时，则无需指定项目和区域。

```bash
# 本地开发（使用个人开发者账号凭据）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI / 生产服务器（挂载服务账号密钥文件）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

官方文档参考：[Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

### CLI 登录

命令行快速认证工具：

```bash
npx @earendil-works/pi-ai login              # 交互式选择 Provider 并登录
npx @earendil-works/pi-ai login anthropic    # 登录指定 Provider
npx @earendil-works/pi-ai list               # 列出当前所有可用 Provider
```

获取的凭证将保存在当前目录下的 `auth.json` 中。

### 编程式 OAuth

内置的登录与刷新逻辑属于 Provider 的私有实现。推荐直接借助 `OAuthAuth` 配合 `CredentialStore`，由 `Models` 提供防并发的自动静默刷新。`@earendil-works/pi-ai/oauth` 仅保留 Coding Agent 插件所需的类型声明。

**特定 Provider 注意事项：**

- **OpenAI Codex (旧版)**：现已被 OpenAI Provider 中的“Sign in with ChatGPT”取代。需要 ChatGPT Plus 或 Pro 订阅。可访问具备超长上下文与深度推理能力的 GPT-5.x Codex 模型。在未声明 `cacheRetention: "none"` 的情况下，传入 `sessionId` 会自动开启基于 Session 的 Prompt 缓存。可在流式选项中将 `transport` 设为 `"sse"`、`"websocket"` 或 `"auto"`。使用 WebSocket 并在保持缓存时，连接会按 Session 复用并在空闲 5 分钟后自动断开。使用完毕后请调用 `cleanupSessionResources(sessionId)` 释放连接池，避免阻碍 Node 进程退出。
- **Azure OpenAI (Responses)**：仅支持 Responses 协议。需配置 `AZURE_OPENAI_API_KEY`，以及 `AZURE_OPENAI_BASE_URL` 或 `AZURE_OPENAI_RESOURCE_NAME`。Base URL 同时兼容 `https://<resource>.openai.azure.com` 与 `https://<resource>.cognitiveservices.azure.com`；根路径自动规范化为 `.../openai/v1`。可选配置 `AZURE_OPENAI_API_VERSION`（默认 `v1`）。默认将部署名视作模型 ID，可通过 `azureDeploymentName` 或使用英文逗号分隔的键值对 `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`（例如 `gpt-4o-mini=my-deployment,gpt-4o=prod`）进行映射。不支持旧版的部署路径 URL。
- **GitHub Copilot**：若收到“The requested model is not supported”报错，需在 VS Code 中手动启用该模型：打开 Copilot Chat，点击模型切换菜单，选中对应的模型（带有警告图标），并点击“Enable”。

---

## 从旧版全局 API 迁移

早期版本依赖一套全局单例 API：基于全局注册表按 `model.api` 分发的 `stream()` / `complete()`、全局同步的 `getModel()` / `getModels()` / `getProviders()`、`registerApiProvider()`、`getEnvApiKey()` 等。为了保障向后兼容，这套 API 完整保留在 **compat 入口** 下：

```typescript
// 迁移前
import { getModel, complete } from '@earendil-works/pi-ai';

// 迁移后（API 表现 100% 保持不变，仅需更改一行导入路径）
import { getModel, complete } from '@earendil-works/pi-ai/compat';
```

Compat 入口是主模块的严格超集，可以直接整体替换导入。该入口将在未来版本中废弃，建议尽快迁移至现代的 `createModels()` + Provider 工厂模式：

| 旧版全局写法 | 现代推荐写法 |
|---|---|
| `getModel('openai', 'gpt-4o-mini')` | `models.getModel('openai', 'gpt-4o-mini')` 或从 `providers/all` 导入 `getBuiltinModel()` |
| `getModels('anthropic')` / `getProviders()` | `models.getModels('anthropic')` / `models.getProviders()` 或使用 `getBuiltin*` 静态方法 |
| `stream(model, ctx, opts)` (自动注入 env key) | `models.stream(model, ctx, opts)` (通过 Provider 自动化解析凭证) |
| `registerApiProvider({ api, stream, streamSimple })` | `createProvider({ id, auth, models, api })` + `models.setProvider()` |
| `getEnvApiKey('openai')` | `await models.getAuth(model.provider)` |
| `streamAnthropic(model, ctx, opts)` | 直接导入 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或通过集合调用 |
| `registerFauxProvider()` | `fauxProvider()` + `models.setProvider()` |
| `getImageModel('openrouter', id)` / `generateImages(model, ctx, { apiKey })` | `models.getModelOfType('image', 'openrouter', id)` / `models.generateImages(model, ctx)` |

早前短暂存在的独立 `ImagesModels` / `ImagesProvider` 集合已废弃，图像模型已完全归并至普通 Provider 中。请使用 `builtinModels()` 替代 `builtinImagesModels()`，使用 `models.getModelOfType('image', ...)` 替代 `imagesModels.getModel()`，并在自定义 Provider 时使用 `createProvider({ models, images })`。

---

## 开发指南

### 添加新的 Provider

在类库中新增一个 LLM Provider 需要跨多个分层文件协同修改。项目的分层架构为：底层的线协议通信实现存放在 `src/api/`；Provider 工厂存放在 `src/providers/`；稳定生成的静态模型目录存放在 `src/providers/<id>.models.ts`；并在 `src/models.generated.ts` 中统一注册。

请按照以下检查清单逐步实施：

#### 1. 核心类型定义 (`src/types.ts`)

- 如果这是一个全新的 API 协议，将新协议标识添加到 `KnownApi` 中（例如 `"bedrock-converse-stream"`）；
- 将新 Provider 名称添加到 `KnownProvider` 联合类型中（例如 `"amazon-bedrock"`）；
- 在 `ApiOptionsMap` 中补充新 API 对应的配置选项类型映射。

#### 2. API 通信实装 (`src/api/<api-id>.ts`，仅全新协议需要)

新建对应的通信实现文件（例如 `bedrock-converse-stream.ts`），必须且仅精准导出 `stream` 与 `streamSimple` 函数，并附带：
- 继承自 `StreamOptions` 的选项接口（例如 `BedrockOptions`）；
- 消息格式转换函数，将统一的 `TranscriptContext` 消息转换为厂商上游格式；通过 `getInitialSystemMessage()`、`getCurrentTools()` 与 `resolveTranscript()` 提取 Prompt 与工具；
- 工具定义转换函数（若上游支持 Tool Calling）；
- 响应解析逻辑，规范化发射统一流式事件（`text`、`tool_call`、`thinking`、`usage`、`stop`）。

同时创建懒加载包装模块 `src/api/<api-id>.lazy.ts`（通过 `lazyApi()` 导出 `<name>Api()`），确保外部引用该 Provider 时不会强制同步导入 SDK。在 `src/index.ts` 中重新导出对外暴露的类型声明。

#### 3. 模型目录配置 (`catalog/providers/<id>.ts`)

- 创建 Provider 目录描述，并在 `catalog/providers/index.ts` 中注册；构建顺序与辅助方法可参考 `catalog/README.md`；
- 将支持对话/工具调用的模型映射为 `Model`，图像生成映射为 `ImageModel`，models.dev 中 `type: "decision"` 映射为 `ClassifierModel`；目录构建系统会自动归集生成的 JSON 数据，并在 `src/providers/<id>.models.ts` 产生字面量模型类型；
- 确保同一 Provider 下各模型类型的 ID 唯一；多模态多用模型应生成多条独立记录；
- 在 Provider 定义中妥善处理厂商特有的定价格式、能力标志（Capabilities）及模型 ID 转换规则。

#### 4. Provider 工厂函数 (`src/providers/<id>.ts`)

- 使用 `createProvider()` 组装：模型目录 + 认证逻辑 + 懒加载 API 包装器；
- 认证配置：常规 Key 厂商使用 `envApiKeyAuth`；环境凭据（AWS Profile、ADC）使用自定义 `ApiKeyAuth`；支持 OAuth 的配置 `lazyOAuth`；
- 将新工厂注册到 `src/providers/all.ts` 中；
- 若引入了全新 API：在 `src/compat.ts` 的内置列表中同步补充注册；`package.json` 中的 `./api/*` 导出已能自动匹配到新文件。

#### 5. 测试用例 (`test/`)

编写或更新针对新 Provider 的测试套件：
- `stream.test.ts` - 基础流式输出与工具调用；
- `tokens.test.ts` - Token 使用量统计准确性；
- `abort.test.ts` - 请求中途取消响应；
- `empty.test.ts` - 空消息边界处理；
- `context-overflow.test.ts` - 超出上下文限制的异常处理；
- `unicode-surrogate.test.ts` - Unicode 字符及 Emoji 正确解析；
- `tool-call-without-result.test.ts` - 孤立工具调用的容错；
- `image-tool-result.test.ts` - 工具结果中携带图片的兼容性；
- `total-tokens.test.ts` - 计费 Token 汇总计算；
- `cross-provider-handoff.test.ts` - 跨厂商上下文切换与思维链剥离验证；
- `providers.test.ts` - Provider 发现与认证解析。

针对 `cross-provider-handoff.test.ts`，至少添加一组该 Provider 与其它 Provider 之间的切换用例。若其包含多个模型家族（例如 GPT 和 Claude），每个家族均需覆盖。涉及复杂非标认证时（如 AWS、Google Vertex），在 `bedrock-utils.ts` 等工具模块中补充凭证模拟工具。

#### 6. Coding Agent 集成 (`../coding-agent/`)

- 更新 `src/core/model-resolver.ts`：在 `defaultModelPerProvider` 中配置该 Provider 的默认模型 ID；
- 更新 `src/cli/args.ts`：在命令行 Help 文档中补充该 Provider 环境变量的说明；
- 更新 `docs/providers.md`：记录配置方法、环境变量与 `auth.json` Key 名称。

#### 7. 文档更新

更新 `packages/ai/README.md`（以及中文文档）：
- 补充至支持的提供商列表；
- 补充该厂商专属的配置项或特殊认证说明；
- 在环境变量表格中登记对应的环境变量。

#### 8. 变更日志 (Changelog)

在 `packages/ai/CHANGELOG.md` 的 `## [Unreleased]` 下的 `### Added` 章节追加更新记录：

```markdown
### Added
- Added support for [Provider Name] provider ([#PR](link) by [@author](link))
```

---

## 开源协议

MIT
