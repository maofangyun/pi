# 第 1 周：TypeScript 速成（练习题与思考题解答）

对应学习计划：[学习计划.md](学习计划.md#第-1-周typescript-速成面向-java-开发者)

---

## D1：环境搭建与源码运行 pi

### 练习题

#### 1. `packages/` 目录结构说明
根据根目录 [package.json](../package.json#L15) 的构建依赖顺序（自底向上），`packages/` 下各子包的职责如下：

| 目录 | 包名 | 职责（附 Java 类比） |
|---|---|---|
| [packages/telemetry](../packages/telemetry) | `@earendil-works/pi-telemetry` | 链路追踪（Span）、指标与日志抽象（类比 OpenTelemetry API / SLF4J） |
| [packages/schema](../packages/schema) | `@earendil-works/pi-schema` | JSON Schema 构建器与无 `eval` 闭包编译器/运行时校验（类比 Jackson + Hibernate Validator） |
| [packages/chord](../packages/chord) | `@earendil-works/pi-chord` | 分布式/持久化编排与 RPC 基础协议组件 |
| [packages/tui](../packages/tui) | `@earendil-works/pi-tui` | 终端 UI 渲染框架、组件与快捷键管理 |
| [packages/codemode](../packages/codemode) | `@earendil-works/pi-codemode` | 代码模式执行沙箱与工具调用编排 |
| [packages/mcp](../packages/mcp) | `@earendil-works/pi-mcp` | Model Context Protocol (MCP) 客户端与协议实现 |
| [packages/ai](../packages/ai) | `@earendil-works/pi-ai` | **核心底座**：统一多厂商 LLM 调用、流式事件、工具定义、Token 计费（类比 JDBC） |
| [packages/durable](../packages/durable) | `@earendil-works/pi-durable` | 持久化执行引擎（状态恢复、可靠执行） |
| [packages/env](../packages/env) | `@earendil-works/pi-env` | 进程与运行环境抽象隔离 |
| [packages/agent](../packages/agent) | `@earendil-works/pi-agent-core` | **核心循环**：无 UI 状态的 Agent Loop（模型流式响应 $\rightarrow$ 工具执行 $\rightarrow$ 循环调度） |
| [packages/coding-agent](../packages/coding-agent) | `@earendil-works/pi` | **顶层应用**：装配会话树、内置工具（`read`/`edit`/`bash`）、上下文压缩、插件系统与 TUI/RPC/SDK 入口（类比 Spring Boot 主工程） |
| [packages/evals](../packages/evals) | `@earendil-works/pi-evals` | Agent 基准评测套件 |

#### 2. `/model` 查看可用的 DeepSeek 模型
在 [packages/ai/src/providers/deepseek.ts](../packages/ai/src/providers/deepseek.ts#L6-L15) 中，DeepSeek Provider 复用了 `openai-completions` 协议并加载本地模型目录：
- `deepseek/deepseek-flash`（DeepSeek V4.1 Flash）：支持推理思考，输入/输出/缓存读价格为 `$0.3 / $1.2 / $0.006` 每百万 token。
- `deepseek/deepseek-v4-pro`（DeepSeek V4 Pro）：输入/输出/缓存读价格为 `$1.32 / $3.96 / $0.044` 每百万 token。

---

### 思考题：`../package.json` 的 `workspaces` 和 Maven 多模块有什么对应关系？

| 维度 | Maven 多模块（Multi-Module） | npm Workspaces（[package.json](../package.json#L5-L12)） |
|---|---|---|
| **根配置声明** | 根 `pom.xml` 中 `<packaging>pom</packaging>` + `<modules><module>packages/ai</module>...</modules>` | 根 `package.json` 中 `"private": true` + `"workspaces": ["packages/*", "apps/*", ...]` |
| **子模块依赖引用** | 子模块 `pom.xml` 通过 `<dependency>` 声明同仓库的 `groupId:artifactId:version` | 子包 `package.json` 的 `dependencies` 声明 `"@earendil-works/pi-ai": "1.5.0"`，npm 自动在 `node_modules` 下创建指向本地源码目录的软链接（symlink），无需发布到远程私服即可本地联调 |
| **依赖去重与锁文件** | 根 `pom.xml` 用 `<dependencyManagement>` 统一版本 | 根目录统一生成一份 `package-lock.json`，公共依赖被提升（hoist）到根目录 `node_modules` |
| **批量命令执行** | `mvn clean test` 按 Reactor 拓扑顺序在所有子模块执行 | `npm run test --workspaces --if-present` 遍历子包执行对应 `scripts` |

---

## D2：类型系统与标签联合（`AgentEvent`）

### 练习题：`AgentEvent` 事件类型表

源码位于 [packages/agent/src/types.ts](../packages/agent/src/types.ts#L528-L551)，按生命周期分为 4 层共 10 种事件：

| 生命周期层级 | `type` 字面量（判别字段） | 附加字段（Payload） | 触发时机与含义 |
|---|---|---|---|
| **1. Agent 运行级** | `"agent_start"` | 无 | 一次完整 Agent 运行开始 |
| | `"agent_end"` | `messages: AgentMessage[]` | 本次运行结束，携带期间产生的消息列表 |
| **2. Turn（轮次）级** | `"turn_start"` | 无 | 单轮循环开始（1 次模型响应 + N 个工具调用算一轮） |
| | `"turn_end"` | `message: AgentMessage`<br>`toolResults: ToolResultMessage[]` | 单轮循环结束，携带本轮助手回复和所有工具结果 |
| **3. Message（消息）级** | `"message_start"` | `message: AgentMessage` | 消息开始（适用于 `system`、`user`、`assistant`、`toolResult`） |
| | `"message_update"` | `message: AgentMessage`<br>`assistantMessageEvent: AssistantMessageEvent` | **仅 `assistant` 流式输出期间触发**，携带当前增量事件与累积快照 |
| | `"message_end"` | `message: AgentMessage` | 消息完成落定 |
| **4. Tool（工具执行）级** | `"tool_execution_start"` | `toolCallId: string`<br>`toolName: string`<br>`args: any` | 单个工具开始执行 |
| | `"tool_execution_update"` | `toolCallId: string`<br>`toolName: string`<br>`args: any`<br>`partialResult: any` | 工具执行过程中的流式进度更新（如 `bash` 实时输出） |
| | `"tool_execution_end"` | `toolCallId: string`<br>`toolName: string`<br>`result: any`<br>`isError: boolean`<br>`durationMs?: number` | 工具执行结束，携带结果、是否报错及耗时（毫秒） |

---

### 思考题：为什么 TS 用 `type: "xxx"` 字段做标签联合（Tagged Union），而 Java 常用继承 + `instanceof`？各有什么优劣？

**原因背景**：
- **Java 是名义类型系统（Nominal Typing）且对象在运行时带有 Class 元数据（对象头 Klass Word）**：JVM 天然支持在运行时通过 `obj instanceof TurnEndEvent` 检查对象的运行时类信息。但在 JSON 反序列化（如 Jackson）时，纯接口继承需要额外配置 `@JsonTypeInfo(use = Id.NAME, property = "type")` 才能知道实例化哪个子类。
- **TypeScript 是结构化类型系统（Structural Typing），且编译后类型信息完全擦除，运行时的对象只是普通 JSON 对象（Plain Object）**：网络流（如 SSE、RPC 的 JSONL）解析出来的对象没有原型链（`prototype`），`instanceof` 对反序列化后的普通 JSON 对象无效。使用普通字段 `type: "turn_end"` 作为判别标签（Discriminator），既能在编译期让 TS 编译器在 `switch (event.type)` 分支中自动收窄类型，又能在运行时零成本直接序列化/反序列化为 JSON。

**优劣对比（结合 Java 17+ `sealed interface` + `record`）**：

| 维度 | TS 标签联合（`type E = { type: "a"; x: number } \| { type: "b" }`） | Java 传统继承 + `instanceof` | Java 17+ `sealed interface` + `record` + `switch` 模式匹配 |
|---|---|---|---|
| **JSON 序列化/网络传输** | **极简**：天然就是普通 JSON 对象，无需任何转换器或反射 | **繁琐**：需声明父类、子类及 Jackson 多态注解 | **较好**：配合 Record 简洁，但仍需配置序列化多态标签 |
| **穷尽性检查（Exhaustiveness）** | **支持**：配合 `default: const _: never = event` 在编译期报错 | **不支持**：新增子类时，漏写 `if-else` 分支不会触发编译错误 | **支持**：`switch` 覆盖所有 `permits` 子类型时无需 `default`，新增子类编译期直接报错 |
| **内存与结构开销** | 无多余包装类定义，文件内几行声明即可 | 每个事件都要定义独立的 `class`，模板代码多 | 单文件内可用 `record` 紧凑定义，已非常接近代数数据类型（ADT） |
| **封装与行为绑定** | 纯数据导向（Data-oriented），方法与数据分离 | 面向对象，可在子类内重写虚方法（多态分发） | 兼顾数据导向与接口默认方法 |

---

## D3：泛型、工具类型与类型收窄

### 练习题：逐步拆解 `AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>`

定义位于 [packages/agent/src/types.ts](../packages/agent/src/types.ts#L58)：
```ts
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
```

分 4 步拆解：

1. **取接口属性类型（索引访问类型 `T["prop"]`）**：
   查看 [packages/ai/src/types.ts](../packages/ai/src/types.ts#L585-L587) 中的 `AssistantMessage`，其 `content` 属性定义为：
   ```ts
   content: (TextContent | ThinkingContent | ToolCall)[];
   ```
   因此 `AssistantMessage["content"]` 取出的是这个**联合类型的数组类型**：`(TextContent | ThinkingContent | ToolCall)[]`。

2. **取数组元素类型（`[number]` 下标索引）**：
   在 TS 中，对数组类型用 `[number]` 索引表示“用数字下标取出的元素类型”。
   因此 `AssistantMessage["content"][number]` 剥离了外层数组 `[]`，得到数组元素的联合类型：
   ```ts
   TextContent | ThinkingContent | ToolCall
   ```

3. **利用 `Extract<T, U>` 过滤联合类型分支**：
   TS 内置工具类型 `Extract<T, U>` 的定义是：
   ```ts
   type Extract<T, U> = T extends U ? T : never;
   ```
   它会对联合类型 `T` 的每一个成员逐一判断是否可赋值给 `{ type: "toolCall" }`：
   - `TextContent`（`type: "text"`）不匹配 $\rightarrow$ `never`
   - `ThinkingContent`（`type: "thinking"`）不匹配 $\rightarrow$ `never`
   - `ToolCall`（`type: "toolCall"`）匹配 $\rightarrow$ 保留 `ToolCall`

4. **最终结果**：
   `AgentToolCall` 等价于 `ToolCall`。这种写法的工程意义在于**保持单一事实来源（Single Source of Truth）**：只要 `AssistantMessage["content"]` 中关于工具调用块的类型定义发生变化，`AgentToolCall` 会自动同步，无需手动维护两处对齐。

---

### 思考题：TS 的泛型在运行时被擦除，和 Java 泛型擦除有何异同？

#### 相同点
1. **运行时无泛型类型参数**：编译后泛型参数（如 `<T>`）都会被擦除，不会像 C# 那样在运行时为 `List<Integer>` 和 `List<String>` 生成两套独立的特化类型（Reified Generics）。
2. **不能直接对泛型参数做运行时操作**：在两者中都不能直接写 `new T()` 或 `obj instanceof T`。

#### 不同点

| 维度 | Java 泛型擦除 | TypeScript 类型擦除 |
|---|---|---|
| **擦除范围** | **仅擦除泛型类型参数**（如 `List<String>` 擦除为原始类型 `List`，`<T extends Number>` 擦除为上界 `Number`），**类、接口、方法签名本身在字节码和运行时完整保留** | **全量类型擦除**：不仅是泛型 `<T>`，连 `interface`、`type`、参数类型注解、返回值类型全部从生成的 JS 代码中彻底消失 |
| **边界处的强制转换（Bridge Cast）** | 编译器会在字节码中自动插入 `checkcast` 指令（如从 `List<String>` 取出元素时在运行时校验是否为 `String`），确保堆污染在取出时立刻抛出 `ClassCastException` | 编译器**不生成任何运行时检查指令**。如果外部 JSON 数据与泛型声明 `<User>` 不符，运行时不会报错，直到访问不存在的属性出现 `undefined`（因此在信任边界必须配合 Schema 做运行时校验） |
| **泛型的表达能力** | 仅支持上下界约束（`extends` / `super` 通配符），无类型计算能力 | 支持**类型级编程（Type-level Programming）**：泛型可以配合 `keyof`、条件类型（`T extends U ? X : Y`）、映射类型（`{ [K in keyof T]: ... }`）、`infer` 在编译期计算出全新的复杂类型（如上面的 `Extract`） |
| **反射获取泛型元信息** | 子类继承泛型父类（如 `new TypeReference<List<String>>() {}`）或字段签名上，仍可通过 `ParameterizedType` 反射拿到泛型参数 | 运行时没有任何反射表记录泛型，完全不存在 |

---

## D4：异步编程与 `AbortSignal`

### 练习题：写一个 `sleep(ms, signal)`，支持被 `AbortController` 取消

实现可取消的 `sleep` 有三个关键细节：
1. **入口预检查**：如果调用时 `signal.aborted` 已经为 `true`，应立即 `reject`，不启动定时器。
2. **中断时清理定时器**：收到 `abort` 事件时必须调用 `clearTimeout`，否则 Node.js 事件循环会被未到期的定时器挂住无法退出。
3. **正常结束时移除监听器**：定时器正常触发后必须移除 `abort` 监听（`{ once: true }` + `removeEventListener`），防止长生命周期的 `signal` 被复用时发生内存泄漏。

```ts
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
			return;
		}

		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
		};

		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// 调用与取消示例：
const controller = new AbortController();
setTimeout(() => controller.abort(new Error("User pressed Esc")), 200);

try {
	await sleep(1000, controller.signal);
} catch (err) {
	console.log("Cancelled:", (err as Error).message); // 200ms 后输出: Cancelled: User pressed Esc
}
```

> [!TIP]
> 在 Node.js 22+ 标准库中，`node:timers/promises` 也原生提供了等价实现：`import { setTimeout as sleep } from "node:timers/promises"; await sleep(1000, undefined, { signal });`。

---

### 思考题：`AbortSignal` 对应 Java 的什么？为什么 Agent 里取消如此重要？

#### 1. 与 Java 机制的对应关系
`AbortController` + `AbortSignal` 采用**控制器与只读信号分离**的设计（类似 Go 的 `context.WithCancel`）：
- **`AbortController`（写端）**：由调用方持有，调用 `controller.abort()` 触发取消，对应 Java 的 `Future.cancel(true)` 或 `Thread.interrupt()`。
- **`AbortSignal`（只读端）**：向下游函数层层传递：
  - `signal.aborted` 轮询检查 $\leftrightarrow$ Java 的 `Thread.currentThread().isInterrupted()`。
  - `signal.addEventListener("abort", ...)` 事件回调 $\leftrightarrow$ Java NIO 的 `InterruptibleChannel` 或 Netty 的 `ChannelFutureListener`（因为 Node.js 是单线程事件循环，无法像 JVM 那样向阻塞线程发操作系统信号，必须靠回调主动关闭底层 socket / kill 子进程）。

#### 2. 为什么在 Agent 中取消机制至关重要？
Agent 的一次运行包含**长耗时、高成本、有副作用**的多步操作，一旦用户按 `Esc` / `Ctrl+C` 或发生超时，如果不能沿着调用链彻底传播 `AbortSignal`：
1. **Token 持续计费浪费**：LLM 流式生成可能长达数十秒（尤其是 DeepSeek 思考模式），不立即断开底层 HTTP/SSE 连接（`fetch(..., { signal })`），服务端会继续生成并计费。
2. **僵尸子进程与脏写风险**：Agent 正在执行的 `bash` 工具（如 `mvn test`、构建脚本）若不通过 `signal` 杀掉子进程树，后台进程会持续占用 CPU/文件锁，甚至在用户开始下一轮对话后继续修改工作区文件，造成状态错乱。
3. **半截工具调用污染上下文**：取消发生时，Agent 循环需要根据 `signal.aborted` 将当前未完成的响应标记为 `stopReason: "aborted"` 并安全收尾，保证会话历史（Transcript）结构合法。

---

## D5：模块与运行（ESM 与 JSON Schema）

### 练习题：编写 `hello.ts`，定义 JSON Schema 并打印

> [!NOTE]
> 学习计划编写时使用的是早期重导出的 `Type`（见 [hello.ts](../packages/coding-agent/examples/extensions/hello.ts#L5)）。在当前仓库的最新代码中，JSON Schema 已独立为专门的子包 [`@earendil-works/pi-schema`](../packages/schema/src/index.ts)（见 [ai/README.md](../packages/ai/README.md#L106-L130)），同时也兼容 `typebox`。下面展示两者的等价写法。

用 Node 22+ 原生类型剥离直接运行（无需 `npx tsx`）：
```powershell
node hello.ts
```

```ts
// hello.ts
import { int, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import { Type } from "typebox";

// 方式 1：使用本仓库原生的 @earendil-works/pi-schema 构建器（推荐）
const WeatherParamsSchema = obj({
	city: str({ description: "城市名称，如 Beijing" }),
	days: opt(int({ description: "预报天数", minimum: 1, maximum: 7 })),
});

// 从运行时 Schema 直接推导出编译期 TypeScript 类型（无需重复写 interface！）
type WeatherParams = Static<typeof WeatherParamsSchema>;
// 等价于: { city: string; days?: number | undefined }

console.log("=== @earendil-works/pi-schema 输出 ===");
console.log(JSON.stringify(WeatherParamsSchema, null, 2));

// 方式 2：使用 TypeBox (Type.Object)
const TypeBoxSchema = Type.Object({
	city: Type.String({ description: "城市名称，如 Beijing" }),
	days: Type.Optional(Type.Integer({ description: "预报天数", minimum: 1, maximum: 7 })),
});

console.log("=== TypeBox 输出 ===");
console.log(JSON.stringify(TypeBoxSchema, null, 2));
```

两者打印出的产物都是标准的 JSON Schema 对象（可直接发给 LLM 的 `tools[].parameters`）：
```json
{
  "type": "object",
  "properties": {
    "city": {
      "type": "string",
      "description": "城市名称，如 Beijing"
    },
    "days": {
      "type": "integer",
      "description": "预报天数",
      "minimum": 1,
      "maximum": 7
    }
  },
  "required": ["city"],
  "additionalProperties": false
}
```

---

### 思考题：为什么项目规则禁止 `enum`、参数属性等语法？（见 [AGENTS.md](../AGENTS.md) 中 “erasable TypeScript syntax”）

#### 1. 什么是可擦除语法（Erasable TypeScript Syntax）？
Node.js 22.6+ 引入了原生运行 `.ts` 文件的能力（**Strip-Only Mode，仅剥离模式**），TypeScript 5.8+ 也配套推出了 `--erasableSyntaxOnly` 编译器选项。
- **原理**：Node.js 在加载 `.ts` 文件时，不做复杂的语法树转译（Transpilation），只是把类型注解（如 `: string`、`interface Foo {...}`、`as number`）直接替换为空白字符（擦除），剩下的代码直接作为原生 JavaScript 执行。
- **为什么禁止 `enum`、构造器参数属性（`constructor(private x: number)`）、`namespace`？**
  因为这些语法**不是纯类型注解，它们会生成额外的运行时 JavaScript 代码**：
  - 例如 `enum Role { User, Admin }` 编译后需要生成一个立即执行函数（IIFE）和双向映射对象 `Role[Role["User"] = 0] = "User"`。
  - 例如 `constructor(public name: string) {}` 需要在函数体内凭空插入一行赋值语句 `this.name = name;`。
  在仅做字符擦除的 Node strip-only 模式下，这些语法无法通过简单擦除变成合法的 JS，运行时会直接报语法错误。

#### 2. 这样设计有什么工程收益？
1. **零构建直接运行源码**：测试、脚本（如 [`generate-models`](../packages/ai/package.json#L60) 中的 `node catalog/generate.ts`）和开发调试可以直接用 `node xxx.ts` 启动，不再依赖 `ts-node`、`tsx` 或构建步骤。
2. **行号与源码 1:1 严格对齐**：因为只把类型替换为空格而不增删代码行，报错堆栈行号、调试器断点与源码完全一致，甚至不需要 SourceMap。
3. **更友好的 Tree-Shaking 与类型推导**：用字面量联合类型 `type Role = "user" | "admin"`（或 `as const` 对象）替代 `enum`，不仅没有运行时闭包开销，而且与 JSON 协议天然契合。
