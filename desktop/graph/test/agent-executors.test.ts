import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { readTool, snapshotDatabase } from "../agent-executors";

const context = { toolCallId: "call", signal: new AbortController().signal, sendUpdate() {} };

/** A read tool over an in-memory tree: `files` maps paths to contents; directories are derived. */
function fixtureTool(files: Record<string, string>, versioned = false) {
	const reads: string[] = [];
	const lists: string[] = [];
	const tool = readTool(
		async file => {
			reads.push(file);
			if (!(file in files)) throw new Error("Path is not in the Graph snapshot");
			return { data: new TextEncoder().encode(files[file]) };
		},
		directory => {
			lists.push(directory);
			const prefix = directory.replace(/\/+$/, "");
			const children = new Set<string>();
			for (const file of Object.keys(files)) {
				if (prefix && !file.startsWith(`${prefix}/`)) continue;
				const rest = file.slice(prefix ? prefix.length + 1 : 0);
				const slash = rest.indexOf("/");
				children.add(slash === -1 ? rest : rest.slice(0, slash + 1));
			}
			return [...children].sort();
		},
		versioned,
	);
	const execute = (params: Record<string, unknown>) => tool.execute(params, context);
	return { tool, reads, lists, execute };
}

test("common model spellings of a path reach the snapshot as the canonical path", async () => {
	const { execute, reads, lists } = fixtureTool({ "src/a.ts": "a\n" });
	for (const spelling of ["./src/a.ts", "src\\a.ts", "src//a.ts", ".\\src\\a.ts"]) {
		expect(await execute({ path: spelling })).toBe("a\n");
	}
	expect(reads).toEqual(["src/a.ts", "src/a.ts", "src/a.ts", "src/a.ts"]);
	expect(await execute({ path: "." })).toBe("src/");
	expect(await execute({ path: "./" })).toBe("src/");
	expect(lists).toEqual(["", ""]);
});

test("reading a directory without a trailing slash explains how to list it", async () => {
	const { execute } = fixtureTool({ "src/a.ts": "a\n" });
	await expect(execute({ path: "src" })).rejects.toThrow("src is a directory; add a trailing / to list it");
	await expect(execute({ path: "missing.ts" })).rejects.toThrow("Path is not in the Graph snapshot");
});

test("a file over 64 KiB is read in line windows that continue where the last one stopped", async () => {
	const line = `${"x".repeat(99)}\n`;
	const text = line.repeat(1000);
	const { execute } = fixtureTool({ "big.txt": text });
	const first = String(await execute({ path: "big.txt" }));
	expect(first).toBe(`${line.repeat(655)}[lines 1–655 of 1000; continue with offset 656]`);
	expect(await execute({ path: "big.txt", offset: 656 })).toBe(line.repeat(345));
	expect(await execute({ path: "big.txt", offset: 10, limit: 2 })).toBe(
		`${line.repeat(2)}[lines 10–11 of 1000; continue with offset 12]`,
	);
	await expect(execute({ path: "big.txt", offset: 1001 })).rejects.toThrow("offset 1001 is past the last line (1000)");
	await expect(execute({ path: "big.txt", limit: 0 })).rejects.toThrow("limit must be a positive integer");
});

test("a listing over 500 entries continues from an entry offset", async () => {
	const files = Object.fromEntries(
		Array.from({ length: 600 }, (_, index) => [`f${String(index).padStart(3, "0")}`, ""]),
	);
	const { execute } = fixtureTool(files);
	const first = String(await execute({ path: "" })).split("\n");
	expect(first).toHaveLength(501);
	expect(first.at(-1)).toBe("[entries 1–500 of 600; continue with offset 501]");
	const rest = String(await execute({ path: "", offset: 501 })).split("\n");
	expect(rest).toEqual(Array.from({ length: 100 }, (_, index) => `f${500 + index}`));
});

test("only the Reviewer's read tool advertises and honours version", async () => {
	expect(fixtureTool({}).tool.parameters.properties).not.toHaveProperty("version");
	expect(fixtureTool({}, true).tool.parameters).toMatchObject({
		properties: { version: { enum: ["base", "candidate"], description: expect.any(String) } },
	});
	const seen: boolean[] = [];
	const coder = readTool(
		async (_file, candidate) => {
			seen.push(candidate);
			return { data: new Uint8Array() };
		},
		() => [],
	);
	await coder.execute({ path: "a.ts", version: "candidate" }, context);
	expect(seen).toEqual([false]);
});

test("worker credentials snapshot includes writes not yet checkpointed from the app's WAL", async () => {
	await using temp = await TempDir.create("@kostomp-graph-snapshot-");
	const source = temp.join("agent.db");
	const writer = new Database(source);
	try {
		writer.run("PRAGMA journal_mode = WAL");
		writer.run("PRAGMA wal_autocheckpoint = 0");
		writer.run("CREATE TABLE credentials (value TEXT)");
		writer.run("INSERT INTO credentials VALUES ('checkpointed')");
		writer.run("PRAGMA wal_checkpoint(TRUNCATE)");
		writer.run("INSERT INTO credentials VALUES ('in the WAL only')");
		const values = (file: string) => {
			const db = new Database(file, { readonly: true });
			try {
				return db
					.query<{ value: string }, []>("SELECT value FROM credentials")
					.all()
					.map(row => row.value);
			} finally {
				db.close();
			}
		};
		// The failure mode: copying the main file loses the uncheckpointed row.
		await fs.copyFile(source, temp.join("plain.db"));
		expect(values(temp.join("plain.db"))).toEqual(["checkpointed"]);
		await snapshotDatabase(source, temp.join("snapshot.db"));
		expect(values(temp.join("snapshot.db"))).toEqual(["checkpointed", "in the WAL only"]);
	} finally {
		writer.close();
	}
	await snapshotDatabase(temp.join("missing.db"), temp.join("none.db"));
	expect(await Bun.file(temp.join("none.db")).exists()).toBe(false);
});
