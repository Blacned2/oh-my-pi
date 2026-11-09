import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { listRpcSessions } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-sessions";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const DIR = "/sessions/proj";

function header(id: string, title?: string): string {
	return `${JSON.stringify({ type: "session", id, cwd: "/work/proj", title, timestamp: "2026-01-01T00:00:00.000Z" })}\n`;
}

describe("list_sessions", () => {
	let agentDir: TempDir;
	let storage: MemorySessionStorage;

	beforeEach(async () => {
		agentDir = TempDir.createSync("@omp-list-sessions-");
		storage = new MemorySessionStorage();
		storage.writeTextSync(`${DIR}/titled.jsonl`, header("titled", "Alpha"));
		await Bun.sleep(5);
		storage.writeTextSync(`${DIR}/stub.jsonl`, header("stub"));
		await Bun.sleep(5);
		storage.writeTextSync(`${DIR}/pinned-stub.jsonl`, header("pinned-stub"));
		await Bun.write(path.join(agentDir.path(), "session-pins.json"), JSON.stringify(["titled"]));
	});

	afterEach(() => {
		agentDir.removeSync();
	});

	it("drops untitled empty sessions, floats pinned ones and reports picker fields", async () => {
		const sessions = await listRpcSessions({}, { currentSessionDir: DIR, storage, agentDir: agentDir.path() });

		expect(sessions.map(s => s.id)).toEqual(["titled"]);
		expect(sessions[0]).toMatchObject({
			path: `${DIR}/titled.jsonl`,
			title: "Alpha",
			cwd: "/work/proj",
			pinned: true,
		});
		expect(typeof sessions[0]?.mtime).toBe("number");
	});

	it("keeps a pinned untitled session above newer ones and honours limit", async () => {
		await Bun.write(path.join(agentDir.path(), "session-pins.json"), JSON.stringify(["pinned-stub"]));
		storage.writeTextSync(`${DIR}/beta.jsonl`, header("beta", "Beta"));

		const all = await listRpcSessions({}, { currentSessionDir: DIR, storage, agentDir: agentDir.path() });
		expect(all.map(s => s.id)).toEqual(["pinned-stub", "beta", "titled"]);

		const limited = await listRpcSessions(
			{ limit: 2 },
			{ currentSessionDir: DIR, storage, agentDir: agentDir.path() },
		);
		expect(limited.map(s => s.id)).toEqual(["pinned-stub", "beta"]);
	});

	it("merges the folder's sessions from other worktrees like the resume picker", async () => {
		const SIBLING = "/sessions/proj-worktree";
		storage.writeTextSync(`${SIBLING}/wt.jsonl`, header("wt", "Worktree"));
		const asked: Array<[string, string]> = [];

		const sessions = await listRpcSessions(
			{},
			{
				currentSessionDir: DIR,
				currentCwd: "/work/proj",
				storage,
				agentDir: agentDir.path(),
				worktreeDirs: async (cwd, sessionDir) => {
					asked.push([cwd, sessionDir]);
					return [SIBLING];
				},
			},
		);

		expect(asked).toEqual([["/work/proj", DIR]]);
		expect(sessions.map(s => s.id)).toEqual(["titled", "wt"]);
		expect(sessions.find(s => s.id === "wt")?.path).toBe(`${SIBLING}/wt.jsonl`);
	});

	it("does not promote orphaned backups while listing", async () => {
		const primary = `${DIR}/orphan.jsonl`;
		const backup = `${primary}.1700000000000.bak`;
		storage.writeTextSync(backup, header("orphan", "Orphan"));

		const sessions = await listRpcSessions({}, { currentSessionDir: DIR, storage, agentDir: agentDir.path() });

		expect(sessions.some(s => s.id === "orphan")).toBe(false);
		expect(storage.existsSync(primary)).toBe(false);
		expect(storage.existsSync(backup)).toBe(true);
	});
});
