/**
 * Extension inventory for RPC hosts: the data behind the CLI's `/extensions`
 * dashboard (skills, MCP servers, extension modules, rules, ...) and the
 * `/mcp reconnect` action, without the TUI.
 */
import type { Extension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { isShadowedExtension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import { cfgDisabledExtensions } from "../../extensibility/settings";
import { setMcpServerEnabled } from "../../mcp/config-writer";
import { cfgMcpEnableProjectConfig } from "../../mcp/settings";
import type { McpConnectionStatusEvent } from "../../mcp/startup-events";
import { applyMcpToggleRuntime, type MCPToggleManager } from "../components/extensions/mcp-runtime";
import { loadAllExtensions } from "../components/extensions/state-manager";

export type RpcExtensionKind = Extension["kind"];
export type RpcExtensionState = Extension["state"];
export type RpcMcpStatus = "connected" | "connecting" | "disconnected";

export interface RpcExtensionEntry {
	/** `${kind}:${name}`; the key `set_extension_enabled` takes. */
	id: string;
	kind: RpcExtensionKind;
	name: string;
	displayName: string;
	description?: string;
	trigger?: string;
	path: string;
	provider: string;
	providerName: string;
	level: "user" | "project" | "native";
	state: RpcExtensionState;
	disabledReason?: string;
	shadowedBy?: string;
	/** Live MCP connection state; MCP rows only, when a manager runs. */
	mcpStatus?: RpcMcpStatus;
	/** Tools the connected MCP server exposes. */
	mcpTools?: number;
	/** Last connection failure of the MCP server, cleared on connect. */
	mcpError?: string;
}

/** Manager surface the RPC extension commands read and drive. */
export interface RpcExtensionsMcpManager extends MCPToggleManager {
	getAllServerNames(): string[];
	reconnectServer(name: string, options: { manual?: boolean }): Promise<unknown>;
}

export interface RpcExtensionsContext {
	cwd: string;
	settings: Settings;
	manager?: RpcExtensionsMcpManager;
	/** Last failure per MCP server, fed by the manager's connection-status events. */
	mcpErrors: ReadonlyMap<string, string>;
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
	browserMcpFilter: boolean;
	onMcpStatus?: (event: McpConnectionStatusEvent) => void;
	/** Test seam; defaults to the `/extensions` dashboard loader. */
	loadExtensions?: (cwd: string, disabledIds: string[]) => Promise<Extension[]>;
}

/** Track the latest MCP connection failure per server. */
export function recordMcpStatus(errors: Map<string, string>, event: McpConnectionStatusEvent): void {
	if (event.type === "failed") errors.set(event.serverName, event.error);
	else if (event.type === "connected") errors.delete(event.serverName);
}

function toEntry(ext: Extension, ctx: RpcExtensionsContext, tools: Map<string, number>): RpcExtensionEntry {
	const entry: RpcExtensionEntry = {
		id: ext.id,
		kind: ext.kind,
		name: ext.name,
		displayName: ext.displayName,
		path: ext.path,
		provider: ext.source.provider,
		providerName: ext.source.providerName,
		level: ext.source.level,
		state: ext.state,
	};
	if (ext.description) entry.description = ext.description;
	if (ext.trigger) entry.trigger = ext.trigger;
	if (ext.disabledReason) entry.disabledReason = ext.disabledReason;
	if (ext.shadowedBy) entry.shadowedBy = ext.shadowedBy;
	if (ext.kind === "mcp" && ctx.manager && ext.state === "active" && !isShadowedExtension(ext)) {
		const status = ctx.manager.getConnectionStatus(ext.name);
		entry.mcpStatus = status;
		if (status === "connected") entry.mcpTools = tools.get(ext.name) ?? 0;
		const failure = ctx.mcpErrors.get(ext.name);
		if (failure && status !== "connected") entry.mcpError = failure;
	}
	return entry;
}

/** Every discovered capability, MCP rows joined with live connection state. */
export async function getRpcExtensions(ctx: RpcExtensionsContext): Promise<RpcExtensionEntry[]> {
	const load = ctx.loadExtensions ?? loadAllExtensions;
	const extensions = await load(ctx.cwd, [...cfgDisabledExtensions.get(ctx.settings)]);
	const tools = new Map<string, number>();
	for (const tool of ctx.manager?.getTools() ?? []) {
		const server = tool.mcpServerName;
		if (server) tools.set(server, (tools.get(server) ?? 0) + 1);
	}
	return extensions.map(ext => toEntry(ext, ctx, tools));
}

export interface RpcSetExtensionResult {
	/** True when the change already applies to this session (MCP connect/disconnect). */
	live: boolean;
}

/**
 * Enable or disable one capability the way the `/extensions` dashboard does:
 * MCP servers through the canonical `mcp.json` deny/allow lists plus a live
 * connect/disconnect; everything else through `disabledExtensions`, which
 * takes effect on the next session or reload.
 */
export async function setRpcExtensionEnabled(
	ctx: RpcExtensionsContext,
	id: string,
	enabled: boolean,
): Promise<RpcSetExtensionResult> {
	const load = ctx.loadExtensions ?? loadAllExtensions;
	const disabled = [...cfgDisabledExtensions.get(ctx.settings)];
	const extensions = await load(ctx.cwd, disabled);
	const target = extensions.find(ext => ext.id === id && !isShadowedExtension(ext));
	if (!target) {
		if (extensions.some(ext => ext.id === id)) throw new Error(`"${id}" is shadowed by another definition.`);
		throw new Error(`Unknown extension "${id}".`);
	}

	if (target.kind === "mcp") {
		const writable = target.source.provider === "native" || target.source.provider === "mcp-json";
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", ctx.cwd),
			projectPath: getMCPConfigPath("project", ctx.cwd),
			sourcePath: writable ? target.path : undefined,
			name: target.name,
			enabled,
		});
		// A legacy `mcp:<name>` entry in `disabledExtensions` would keep the row disabled.
		const legacy = disabled.indexOf(id);
		if (enabled && legacy !== -1) {
			disabled.splice(legacy, 1);
			cfgDisabledExtensions.set(ctx.settings, disabled);
		}
		await applyMcpToggleRuntime({
			name: target.name,
			enabled,
			cwd: ctx.cwd,
			manager: ctx.manager,
			session: { refreshMCPTools: ctx.refreshMCPTools },
			discovery: {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(ctx.settings),
				filterExa: true,
				filterBrowser: ctx.browserMcpFilter,
			},
			onStatus: ctx.onMcpStatus,
		});
		return { live: ctx.manager !== undefined };
	}

	const index = disabled.indexOf(id);
	if (enabled && index !== -1) disabled.splice(index, 1);
	else if (!enabled && index === -1) disabled.push(id);
	else return { live: false };
	cfgDisabledExtensions.set(ctx.settings, disabled);
	return { live: false };
}

/** `/mcp reconnect <name>`: drop and re-open one server, then rebind its tools. */
export async function reconnectRpcMcpServer(ctx: RpcExtensionsContext, name: string): Promise<{ connected: boolean }> {
	const manager = ctx.manager;
	if (!manager) throw new Error("MCP is not running in this session.");
	if (!manager.getAllServerNames().includes(name)) throw new Error(`Unknown MCP server "${name}".`);
	const connection = await manager.reconnectServer(name, { manual: true });
	await ctx.refreshMCPTools(manager.getTools());
	return { connected: Boolean(connection) };
}
