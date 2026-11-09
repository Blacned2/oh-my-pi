import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("RPC session accounts", () => {
	it("lists the model provider's accounts and refuses to pin a credential that is not stored", async () => {
		await using temp = await TempDir.create("@rpc-session-accounts-");
		const child = Bun.spawn(
			[process.execPath, CLI, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
			{
				cwd: temp.path(),
				env: {
					PATH: Bun.env.PATH,
					HOME: temp.join("home"),
					PI_CODING_AGENT_DIR: temp.join("agent"),
					XDG_CONFIG_HOME: temp.join("config"),
					XDG_DATA_HOME: temp.join("data"),
					XDG_CACHE_HOME: temp.join("cache"),
					CI: "true",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			},
		);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		let listed: unknown;
		let pinned: unknown;
		let malformed: unknown;

		try {
			await send({ type: "get_session_accounts", id: "list" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame) || frame.type !== "response") continue;
				if (frame.id === "list") {
					listed = frame;
					await send({ type: "pin_session_account", credentialId: 987654, id: "pin" });
				} else if (frame.id === "pin") {
					pinned = frame;
					await send({ type: "pin_session_account", credentialId: "x", id: "bad" });
				} else if (frame.id === "bad") {
					malformed = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!malformed) throw new Error(`RPC session-accounts fixture did not finish: ${await stderr}`);
		await stderr;
		expect(listed).toMatchObject({
			command: "get_session_accounts",
			success: true,
			data: { provider: "anthropic", accounts: [] },
		});
		expect(pinned).toMatchObject({ command: "pin_session_account", success: false });
		expect(malformed).toMatchObject({ command: "pin_session_account", success: false });
	}, 30_000);
});
