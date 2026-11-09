import { describe, expect, test } from "bun:test";
import type { Extension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { Settings } from "../../src/config/settings";
import type { CustomTool } from "../../src/extensibility/custom-tools/types";
import { cfgDisabledExtensions } from "../../src/extensibility/settings";
import {
	getRpcExtensions,
	type RpcExtensionsContext,
	type RpcExtensionsMcpManager,
	reconnectRpcMcpServer,
	recordMcpStatus,
	setRpcExtensionEnabled,
} from "../../src/modes/rpc/rpc-extensions";

function ext(kind: Extension["kind"], name: string, extra: Partial<Extension> = {}): Extension {
	return {
		id: `${kind}:${name}`,
		kind,
		name,
		displayName: name,
		path: `/x/${name}`,
		source: { provider: "native", providerName: "OMP", level: "user" },
		state: "active",
		raw: {},
		...extra,
	};
}

function fakeManager(status: Record<string, "connected" | "connecting" | "disconnected">) {
	const calls: string[] = [];
	const tools = [{ mcpServerName: "alpha" }, { mcpServerName: "alpha" }, { name: "local" }] as unknown as CustomTool[];
	const manager: RpcExtensionsMcpManager = {
		getConnectionStatus: name => status[name] ?? "disconnected",
		getTools: () => tools,
		disconnectServer: async name => {
			calls.push(`disconnect:${name}`);
		},
		connectServers: async () => ({ errors: new Map() }),
		getAllServerNames: () => Object.keys(status),
		reconnectServer: async name => {
			calls.push(`reconnect:${name}`);
			return status[name] === "connected" ? {} : null;
		},
	};
	return { manager, calls };
}

function context(extensions: Extension[], overrides: Partial<RpcExtensionsContext> = {}): RpcExtensionsContext {
	return {
		cwd: "/project",
		settings: Settings.isolated(),
		mcpErrors: new Map(),
		refreshMCPTools: () => {},
		browserMcpFilter: false,
		loadExtensions: async (_cwd, disabled) =>
			extensions.map(e =>
				disabled.includes(e.id) ? { ...e, state: "disabled", disabledReason: "item-disabled" } : e,
			),
		...overrides,
	};
}

describe("get_extensions", () => {
	test("joins active MCP rows with live status, tool count and last failure", async () => {
		const { manager } = fakeManager({ alpha: "connected", beta: "disconnected" });
		const errors = new Map<string, string>();
		recordMcpStatus(errors, { type: "failed", serverName: "beta", error: "spawn ENOENT" });
		recordMcpStatus(errors, { type: "failed", serverName: "alpha", error: "old" });
		recordMcpStatus(errors, { type: "connected", serverName: "alpha" });
		const rows = await getRpcExtensions(
			context([ext("mcp", "alpha"), ext("mcp", "beta"), ext("skill", "review")], { manager, mcpErrors: errors }),
		);
		const byId = new Map(rows.map(r => [r.id, r]));
		expect(byId.get("mcp:alpha")).toMatchObject({ mcpStatus: "connected", mcpTools: 2 });
		expect(byId.get("mcp:alpha")?.mcpError).toBeUndefined();
		expect(byId.get("mcp:beta")).toMatchObject({ mcpStatus: "disconnected", mcpError: "spawn ENOENT" });
		expect(byId.get("skill:review")?.mcpStatus).toBeUndefined();
	});

	test("disabled and shadowed MCP rows carry no live status", async () => {
		const { manager } = fakeManager({ alpha: "connected" });
		const settings = Settings.isolated();
		cfgDisabledExtensions.set(settings, ["mcp:alpha"]);
		const rows = await getRpcExtensions(
			context([ext("mcp", "alpha"), ext("mcp", "alpha", { id: "mcp:alpha#2", shadowedBy: "native" })], {
				manager,
				settings,
			}),
		);
		expect(rows.map(r => [r.state, r.mcpStatus])).toEqual([
			["disabled", undefined],
			["active", undefined],
		]);
	});
});

describe("set_extension_enabled", () => {
	test("non-MCP toggles round-trip through disabledExtensions and are not live", async () => {
		const ctx = context([ext("skill", "review")]);
		expect(await setRpcExtensionEnabled(ctx, "skill:review", false)).toEqual({ live: false });
		expect(cfgDisabledExtensions.get(ctx.settings)).toEqual(["skill:review"]);
		expect((await getRpcExtensions(ctx))[0]?.state).toBe("disabled");
		await setRpcExtensionEnabled(ctx, "skill:review", true);
		expect(cfgDisabledExtensions.get(ctx.settings)).toEqual([]);
	});

	test("rejects unknown and shadowed ids without touching settings", async () => {
		const ctx = context([ext("rule", "style", { shadowedBy: "project" })]);
		await expect(setRpcExtensionEnabled(ctx, "skill:nope", false)).rejects.toThrow('Unknown extension "skill:nope"');
		await expect(setRpcExtensionEnabled(ctx, "rule:style", false)).rejects.toThrow("shadowed");
		expect(cfgDisabledExtensions.get(ctx.settings)).toEqual([]);
	});
});

describe("reconnect_mcp_server", () => {
	test("reconnects a known server and rebinds tools; rejects unknown names", async () => {
		const { manager, calls } = fakeManager({ alpha: "connected" });
		let refreshed = 0;
		const ctx = context([], { manager, refreshMCPTools: () => void refreshed++ });
		expect(await reconnectRpcMcpServer(ctx, "alpha")).toEqual({ connected: true });
		expect(calls).toEqual(["reconnect:alpha"]);
		expect(refreshed).toBe(1);
		await expect(reconnectRpcMcpServer(ctx, "ghost")).rejects.toThrow('Unknown MCP server "ghost"');
	});

	test("fails when the session runs without MCP", async () => {
		await expect(reconnectRpcMcpServer(context([]), "alpha")).rejects.toThrow("MCP is not running");
	});
});
