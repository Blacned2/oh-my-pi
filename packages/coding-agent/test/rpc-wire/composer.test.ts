import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	addRpcPromptHistory,
	RpcPathCompleter,
	readRpcPromptHistory,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-composer";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";

describe("complete_path", () => {
	let dir: TempDir;

	beforeEach(async () => {
		dir = TempDir.createSync("@omp-complete-path-");
		await Bun.write(path.join(dir.path(), "foo.ts"), "");
		await Bun.write(path.join(dir.path(), "folder", "inner.ts"), "");
	});

	afterEach(() => {
		dir.removeSync();
	});

	it("completes the @ mention at the cursor, marking directories", async () => {
		const text = "look at @fo please";
		const cursor = "look at @fo".length;
		const completion = await new RpcPathCompleter().complete(dir.path(), text, cursor);
		expect(completion?.prefix).toBe("@fo");
		const values = completion?.items.map(item => [item.value, item.directory]) ?? [];
		expect(values).toContainEqual(["@foo.ts", false]);
		expect(values.some(([value, directory]) => String(value).startsWith("@folder") && directory)).toBe(true);
	});

	it("returns null when the cursor is not in an @ mention", async () => {
		const text = "first line @fo\nplain words";
		expect(await new RpcPathCompleter().complete(dir.path(), text, text.length)).toBeNull();
	});
});

describe("prompt history", () => {
	let dir: TempDir;
	let storage: HistoryStorage;

	beforeEach(() => {
		HistoryStorage.close();
		dir = TempDir.createSync("@omp-prompt-history-");
		storage = HistoryStorage.open(path.join(dir.path(), "history.db"));
	});

	afterEach(() => {
		HistoryStorage.close();
		dir.removeSync();
	});

	it("records prompts with cwd, dedupes repeats and filters by query and cwd", async () => {
		await addRpcPromptHistory("fix the parser", "/work/a", "s1", storage);
		await addRpcPromptHistory("write docs", "/work/b", "s2", storage);
		await addRpcPromptHistory("fix the parser", "/work/a", "s1", storage);

		const all = readRpcPromptHistory({}, storage);
		expect(all.map(entry => entry.prompt).sort()).toEqual(["fix the parser", "write docs"]);
		const parser = all.find(entry => entry.prompt === "fix the parser");
		expect(parser?.useCount).toBe(2);
		expect(parser?.cwd).toBe("/work/a");
		// Epoch milliseconds, not the seconds the database stores.
		expect(Math.abs((parser?.createdAt ?? 0) - Date.now())).toBeLessThan(60_000);

		expect(readRpcPromptHistory({ query: "docs" }, storage).map(entry => entry.prompt)).toEqual(["write docs"]);
		expect(readRpcPromptHistory({ cwd: "/work/a" }, storage).map(entry => entry.prompt)).toEqual(["fix the parser"]);
		expect(readRpcPromptHistory({ limit: 1 }, storage)).toHaveLength(1);
	});
});
