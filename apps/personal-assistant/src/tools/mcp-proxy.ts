// Lazy-start, on-demand discovery MCP proxy (mcp_discover, mcp_call) with supply-chain pinning
// and human review gates so static prefixes stay small and KV Cache stays warm.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AssistantRuntime } from "../extension.ts";

export interface McpToolSchemaSummary {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface McpServerManifestEntry {
	name: string;
	version: string;
	reviewed: boolean;
	reviewedAt?: string;
	description?: string;
	command?: string;
	args?: string[];
	url?: string;
	tools?: McpToolSchemaSummary[];
}

export interface McpRegistryManifest {
	version: 1;
	servers: McpServerManifestEntry[];
}

export interface McpServerConnector {
	listTools(server: McpServerManifestEntry): Promise<McpToolSchemaSummary[]>;
	callTool(server: McpServerManifestEntry, toolName: string, args: Record<string, unknown>): Promise<string>;
}

export interface AttachMcpProxyOptions {
	manifestPath?: string;
	connector?: McpServerConnector;
}

const EXACT_PINNED_VERSION_REGEX = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const McpDiscoverParams = Type.Object({
	server: Type.Optional(Type.String({ description: "目标 MCP 服务器名；省略时仅列出已审查锁定的轻量索引" })),
	query: Type.Optional(Type.String({ description: "按关键词过滤工具名称与描述" })),
});

const McpCallParams = Type.Object({
	server: Type.String({ description: "已审查并锁版本的 MCP 服务器名称" }),
	tool: Type.String({ description: "目标工具名称（先通过 mcp_discover 获取参数 schema）" }),
	arguments: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), { description: "透传给目标 MCP 工具的 JSON 参数" }),
	),
});

/** Validate supply-chain gate: third-party MCP servers must be human-reviewed and exact-version pinned. */
export function validateMcpSupplyChainGate(
	entry: McpServerManifestEntry,
): { ok: true } | { ok: false; reason: string } {
	if (!entry.reviewed) {
		return {
			ok: false,
			reason: `MCP 服务器 "${entry.name}" 尚未通过人工安全审查（reviewed !== true），禁止启动或调用。`,
		};
	}
	if (!EXACT_PINNED_VERSION_REGEX.test(entry.version.trim())) {
		return {
			ok: false,
			reason: `MCP 服务器 "${entry.name}" 版本 "${entry.version}" 未精确锁定（禁止使用 latest/*/^/~ 等浮动版本）。`,
		};
	}
	return { ok: true };
}

/** Lazy-loading MCP proxy keeping tool schemas out of the static system prefix until discovered on demand. */
export class LazyMcpProxy {
	private readonly manifestPath: string;
	private readonly connector: McpServerConnector | undefined;
	private readonly startedServers = new Set<string>();
	private readonly cachedTools = new Map<string, McpToolSchemaSummary[]>();

	constructor(manifestPath: string, connector?: McpServerConnector) {
		this.manifestPath = manifestPath;
		this.connector = connector;
	}

	/** Load the local MCP registry manifest (returns empty manifest when not configured). */
	loadManifest(): McpRegistryManifest {
		if (!existsSync(this.manifestPath)) {
			return { version: 1, servers: [] };
		}
		const parsed = JSON.parse(readFileSync(this.manifestPath, "utf8")) as Partial<McpRegistryManifest>;
		return {
			version: 1,
			servers: Array.isArray(parsed.servers) ? parsed.servers : [],
		};
	}

	/** Discover lightweight server index or lazily load target tool schemas on demand. */
	async discover(serverName?: string, query?: string): Promise<string> {
		const manifest = this.loadManifest();
		if (manifest.servers.length === 0) {
			return `当前未配置任何延迟 MCP 服务器（清单路径：${this.manifestPath}）。优先使用本地脚本 + Skills。`;
		}

		if (!serverName) {
			const lines = ["已登记的 MCP 服务器轻量索引（按需传入 server 名称才延迟加载 schema）："];
			for (const srv of manifest.servers) {
				const gate = validateMcpSupplyChainGate(srv);
				const status = gate.ok ? `已审查@${srv.version}` : `已阻止(${gate.reason})`;
				lines.push(`- ${srv.name} [${status}]: ${srv.description ?? "(无描述)"}`);
			}
			return lines.join("\n");
		}

		const entry = manifest.servers.find((s) => s.name === serverName);
		if (!entry) {
			return `未找到名为 "${serverName}" 的 MCP 服务器。`;
		}

		const gate = validateMcpSupplyChainGate(entry);
		if (!gate.ok) {
			return `供应链守门拦截：${gate.reason}`;
		}

		let tools = this.cachedTools.get(entry.name);
		if (!tools) {
			this.startedServers.add(entry.name);
			if (this.connector) {
				tools = await this.connector.listTools(entry);
			} else {
				tools = entry.tools ?? [];
			}
			this.cachedTools.set(entry.name, tools);
		}

		const q = query?.trim().toLowerCase();
		const filtered = q
			? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
			: tools;

		if (filtered.length === 0) {
			return `MCP 服务器 "${entry.name}" 中未匹配到工具${q ? `（query="${query}"）` : ""}。`;
		}

		const rendered = filtered.map(
			(t) => `### ${entry.name}.${t.name}\n${t.description}\nSchema: ${JSON.stringify(t.inputSchema)}`,
		);
		return `已按需拉取 MCP "${entry.name}@${entry.version}" 的 ${filtered.length} 个工具定义：\n\n${rendered.join("\n\n")}`;
	}

	/** Lazily invoke a tool on a reviewed, version-pinned MCP server. */
	async call(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
		const manifest = this.loadManifest();
		const entry = manifest.servers.find((s) => s.name === serverName);
		if (!entry) {
			return `错误：未找到 MCP 服务器 "${serverName}"。`;
		}

		const gate = validateMcpSupplyChainGate(entry);
		if (!gate.ok) {
			return `供应链守门拦截：${gate.reason}`;
		}

		if (!this.connector) {
			return `MCP 服务器 "${entry.name}@${entry.version}" 已通过审查，但当前会话未挂载运行时连接器。`;
		}

		this.startedServers.add(entry.name);
		return this.connector.callTool(entry, toolName, args);
	}

	/** Check whether a server has been lazily started during this session. */
	isServerStarted(serverName: string): boolean {
		return this.startedServers.has(serverName);
	}
}

/** Register mcp_discover and mcp_call proxy tools onto pi's ExtensionAPI. */
export function attachMcpProxyTools(
	pi: ExtensionAPI,
	runtime: AssistantRuntime,
	options: AttachMcpProxyOptions = {},
): LazyMcpProxy {
	const manifestPath = options.manifestPath ?? join(runtime.workspace.root, ".pi", "mcp-registry.json");
	const proxy = new LazyMcpProxy(manifestPath, options.connector);

	pi.registerTool({
		name: "mcp_discover",
		label: "MCP Discover",
		description: "延迟发现已审查并锁定版本的 MCP 服务器与工具 schema（按需追加至轨迹末尾，避免会话启动时前缀膨胀）。",
		promptSnippet: "按需延迟发现已审查 MCP 服务器的工具 schema",
		parameters: McpDiscoverParams,
		async execute(_toolCallId, params) {
			const text = await proxy.discover(params.server, params.query);
			return { content: [{ type: "text", text }], details: { server: params.server } };
		},
	});

	pi.registerTool({
		name: "mcp_call",
		label: "MCP Call",
		description: "按需调用已通过人工审查与版本锁定的 MCP 工具。",
		promptSnippet: "调用经 mcp_discover 发现的已审查 MCP 工具",
		parameters: McpCallParams,
		async execute(_toolCallId, params) {
			const text = await proxy.call(params.server, params.tool, params.arguments ?? {});
			return { content: [{ type: "text", text }], details: { server: params.server, tool: params.tool } };
		},
	});

	return proxy;
}
