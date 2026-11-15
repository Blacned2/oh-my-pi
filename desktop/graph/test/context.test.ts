import { expect, test } from "bun:test";
import { buildGraphContext } from "../context";
import type { GraphWork } from "../workflow";

/** A pinned base with only the members the Context Manager reads. */
function stubWorkspace(files: Record<string, string>) {
	return {
		baseSha: "0".repeat(40),
		files: () => Object.keys(files),
		async readBaseFile(file: string) {
			const text = files[file];
			if (text === undefined) throw new Error(`missing ${file}`);
			return { blobId: file, data: new TextEncoder().encode(text) };
		},
	};
}

function work(objective: string, files: string[]): GraphWork {
	return { source: "C:\\repo", objective, tasks: [{ nodeId: "code-a", title: objective, brief: objective, files }] };
}

test("an owned file whose lines match no term contributes no references, not its licence header and imports", async () => {
	const workspace = stubWorkspace({
		"src/router.ts":
			"// Copyright 2026 Example Ltd.\nimport { listen } from './server';\n\nexport const port = 8080;\n",
	});
	const manifest = await buildGraphContext(
		workspace,
		work("Fix the payment retry", ["src/router.ts"]),
		AbortSignal.timeout(5_000),
	);
	expect(manifest.references).toEqual({ "code-a": [] });
});

test("a Turkish dotted capital matches the same word in any case", async () => {
	const workspace = stubWorkspace({
		"src/router.ts": "export const port = 8080;\n",
		"src/istek.ts": "// Licence header\nexport const ISTEK_YOLU = '/v1';\n",
	});
	const manifest = await buildGraphContext(
		workspace,
		work("İstek yolunu düzelt", ["src/router.ts"]),
		AbortSignal.timeout(5_000),
	);
	expect(manifest.references["code-a"]).toEqual([
		{ file: "src/istek.ts", line: 2, excerpt: "export const ISTEK_YOLU = '/v1';" },
	]);
});
