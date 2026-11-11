import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";

const CLI = path.join(import.meta.dir, "..", "..", "src", "cli.ts");

const PENDING_LOGIN_EXTENSION = `
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Offline login fixture refuses network"); };
  pi.registerProvider("rpc-pending", {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    models: [{
      id: "fixture",
      name: "Offline fixture",
      reasoning: false,
      input: ["text"],
      contextWindow: 4096,
      maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }],
    oauth: {
      name: "rpc-pending",
      // Ignores any abort signal: the RPC login must still settle on cancel.
      login: async callbacks => {
        callbacks.onAuth({ url: "https://example.invalid/authorize" });
        return callbacks.onPrompt({ message: "code" });
      }
    }
  });
}
`;

function spawnRpc(temp: TempDir, extensionPath: string) {
	return Bun.spawn(
		[
			process.execPath,
			CLI,
			"--trusted-extension",
			extensionPath,
			"--mode",
			"rpc",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
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
				// Leases are keyed by this dir; the child must share the test process's.
				PI_TEST_SESSION_OWNERS_DIR: Bun.env.PI_TEST_SESSION_OWNERS_DIR,
				PI_NO_TITLE: "1",
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 20_000,
		},
	);
}

describe("RPC login_cancel and rename_session", () => {
	it("cancels a pending login and reports whether one was running", async () => {
		await using temp = await TempDir.create("@rpc-login-cancel-");
		const extensionPath = temp.join("login.mjs");
		await Bun.write(extensionPath, PENDING_LOGIN_EXTENSION);
		const child = spawnRpc(temp, extensionPath);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		let idleCancel: unknown;
		let activeCancel: unknown;
		let loginResponse: unknown;
		let promptId: unknown;
		let dialogCancelTarget: unknown;

		try {
			await send({ type: "login_cancel", id: "idle" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame)) continue;
				if (frame.type === "response" && frame.id === "idle") {
					idleCancel = frame;
					await send({ type: "login", providerId: "rpc-pending", id: "login" });
				} else if (frame.type === "extension_ui_request" && frame.method === "input") {
					promptId = frame.id;
					// Leave the prompt unanswered: only login_cancel can end this login.
					await send({ type: "login_cancel", id: "cancel" });
				} else if (frame.type === "extension_ui_request" && frame.method === "cancel") {
					dialogCancelTarget = frame.targetId;
				} else if (frame.type === "response" && frame.id === "cancel") {
					activeCancel = frame;
				} else if (frame.type === "response" && frame.id === "login") {
					loginResponse = frame;
				}
				if (activeCancel && loginResponse) break;
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!activeCancel || !loginResponse) throw new Error(`RPC login fixture did not finish: ${await stderr}`);
		await stderr;
		expect(idleCancel).toMatchObject({ command: "login_cancel", success: true, data: { cancelled: false } });
		expect(activeCancel).toMatchObject({ command: "login_cancel", success: true, data: { cancelled: true } });
		expect(loginResponse).toMatchObject({ command: "login", success: false, code: "cancelled" });
		// The host's open prompt is told to close.
		expect(dialogCancelTarget).toBe(promptId);
	}, 30_000);

	it("renames a session file that is not loaded and rejects an empty name", async () => {
		await using temp = await TempDir.create("@rpc-rename-session-");
		const extensionPath = temp.join("none.mjs");
		await Bun.write(extensionPath, "export default function() {}\n");
		const otherDir = temp.join("other");
		const creator = SessionManager.create(otherDir, otherDir, new FileSessionStorage());
		await creator.ensureOnDisk();
		creator.appendMessage({ role: "user", content: "before", timestamp: Date.now() });
		const sessionFile = creator.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");
		await creator.close();

		const child = spawnRpc(temp, extensionPath);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		let emptyResponse: unknown;
		let renameResponse: unknown;

		try {
			await send({ type: "rename_session", path: sessionFile, name: "   ", id: "empty" });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame) || frame.type !== "response") continue;
				if (frame.id === "empty") {
					emptyResponse = frame;
					await send({ type: "rename_session", path: sessionFile, name: "  Renamed  ", id: "rename" });
				} else if (frame.id === "rename") {
					renameResponse = frame;
					break;
				}
			}
		} finally {
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (!renameResponse) throw new Error(`RPC rename fixture did not finish: ${await stderr}`);
		await stderr;
		expect(emptyResponse).toMatchObject({ command: "rename_session", success: false });
		expect(renameResponse).toMatchObject({ command: "rename_session", success: true, data: { title: "Renamed" } });
		const reopened = await SessionManager.open(sessionFile, otherDir, new FileSessionStorage(), {
			suppressBreadcrumb: true,
		});
		try {
			expect(reopened.getSessionName()).toBe("Renamed");
		} finally {
			await reopened.close();
		}
	}, 30_000);

	it("deletes a closed session with artifacts and refuses leased or missing ones", async () => {
		await using temp = await TempDir.create("@rpc-delete-session-");
		const extensionPath = temp.join("none.mjs");
		await Bun.write(extensionPath, "export default function() {}\n");
		const otherDir = temp.join("other");
		const make = async (text: string) => {
			const manager = SessionManager.create(otherDir, otherDir, new FileSessionStorage());
			await manager.ensureOnDisk();
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected session file");
			const id = manager.getSessionId();
			await manager.close();
			return { file, id };
		};
		const closed = await make("closed");
		const leased = await make("leased");
		const artifacts = closed.file.replace(/\.jsonl$/, "");
		await Bun.write(path.join(artifacts, "note.txt"), "artifact");
		const release = new FileSessionStorage().claimSession(leased.id, leased.file);
		if (!release) throw new Error("Expected to claim lease");

		const child = spawnRpc(temp, extensionPath);
		const stdout = new Response(child.stdout).body;
		if (!stdout) throw new Error("RPC fixture did not expose stdout");
		const stderr = new Response(child.stderr).text();
		const send = async (frame: object) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			await child.stdin.flush();
		};
		const responses = new Map<string, unknown>();
		const steps = [
			{ id: "closed", path: closed.file },
			{ id: "leased", path: leased.file },
			{ id: "missing", path: closed.file },
		];
		try {
			await send({ type: "delete_session", ...steps[0] });
			for await (const frame of readJsonl<unknown>(stdout)) {
				if (!isRecord(frame) || frame.type !== "response" || typeof frame.id !== "string") continue;
				responses.set(frame.id, frame);
				const next = steps[responses.size];
				if (!next) break;
				await send({ type: "delete_session", ...next });
			}
		} finally {
			release();
			child.stdin.end();
			child.kill();
			await child.exited;
		}

		if (responses.size < steps.length) throw new Error(`RPC delete fixture did not finish: ${await stderr}`);
		await stderr;
		expect(responses.get("closed")).toMatchObject({ command: "delete_session", success: true });
		expect(responses.get("leased")).toMatchObject({ command: "delete_session", success: false });
		expect(responses.get("missing")).toMatchObject({ command: "delete_session", success: false });
		expect(await Bun.file(closed.file).exists()).toBe(false);
		expect(await Bun.file(path.join(artifacts, "note.txt")).exists()).toBe(false);
		expect(await Bun.file(leased.file).exists()).toBe(true);
	}, 30_000);
});
