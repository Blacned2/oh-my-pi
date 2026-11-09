import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, ptree, readLines, TempDir } from "@oh-my-pi/pi-utils";
import { changeSet, fixture, original } from "../fixtures/git";
import { completion, type CompletionRequest } from "../fixtures/openai";
import type { GraphRun } from "../run-store";

const imageId = Bun.argv[2];
const dockerPath = await $which("docker");
if (!imageId || !dockerPath) throw new Error("Provide a preloaded Linux Docker image ID");
const runtime = path.resolve(Bun.argv[3] ?? path.join(import.meta.dir, "../../target/release/runtime"));
const bunPath = path.join(runtime, "bun.exe");
const cliPath = path.join(runtime, "node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts");
const provider = "graph-smoke";
const model = "graph-smoke-model";
const file = "src/backend.txt";

await using temp = await TempDir.create("@kostomp-graph-service-smoke-");
const bundle = temp.join("runtime");
const graphSource = path.join(import.meta.dir, "..");
const graphTarget = path.join(bundle, "graph");
await fs.mkdir(graphTarget, { recursive: true });
await fs.symlink(path.join(runtime, "node_modules"), path.join(bundle, "node_modules"), "junction");
for (const entry of await fs.readdir(graphSource, { withFileTypes: true })) {
	if (entry.isFile() && entry.name.endsWith(".ts"))
		await fs.copyFile(path.join(graphSource, entry.name), path.join(graphTarget, entry.name));
}
for (const asset of ["prompts", "questions", "tester-bootstrap.sh"]) {
	await fs.cp(path.join(graphSource, asset), path.join(graphTarget, asset), { recursive: true });
}
const service = path.join(graphTarget, "service.ts");
const source = await fixture(temp.join("source"));
const edited = await fixture(temp.join("edited"));
const change = await changeSet(edited, "code", { [file]: "service fixture\n" });
const data = temp.join("data");
const toolCalls: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
			return new Response(null, { status: 404 });
		const body = (await request.json()) as CompletionRequest;
		const tools = body.tools?.map(tool => tool.function.name) ?? [];
		const coder = tools.includes("kostomp_graph_submit_patch");
		const resultTool = coder ? "kostomp_graph_submit_patch" : "kostomp_graph_review";
		deepStrictEqual([...tools].sort(), ["kostomp_graph_read_file", resultTool].sort());
		const responses = body.messages.filter(message => message.role === "tool");
		if (responses.length > 1) return completion(model, { content: "Done" }, "stop");
		if (responses.length === 1) {
			const expected = coder ? original[file].trim() : "service fixture";
			if (!JSON.stringify(responses[0].content).includes(expected))
				throw new Error("Graph did not provide the expected file version");
		}
		const name = responses.length === 0 ? "kostomp_graph_read_file" : resultTool;
		const args =
			responses.length === 0
				? { path: file, version: coder ? "base" : "candidate" }
				: coder
					? { patch: change.patch }
					: { verdict: "accepted" };
		toolCalls.push(name);
		return completion(
			model,
			{
				tool_calls: [
					{
						index: 0,
						id: `call_${responses.length}`,
						type: "function",
						function: { name, arguments: JSON.stringify(args) },
					},
				],
			},
			"tool_calls",
		);
	},
});
let stopService: (() => Promise<void>) | undefined;
try {
	await Bun.write(
		path.join(data, "profile.json"),
		JSON.stringify({
			provider,
			model,
			tester: {
				dockerPath,
				imageId,
				timeoutMs: 30000,
				command: ["/bin/sh", "-c", 'test "$(cat src/backend.txt)" = "service fixture"'],
			},
		}),
	);
	await Bun.write(
		path.join(data, "profile-home/.omp/agent/models.yml"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl: `${server.url.origin}/v1`,
					api: "openai-completions",
					apiKey: "smoke-fixture",
					models: [{ id: model, name: "Graph fixture" }],
				},
			},
		}),
	);
	const deadline = AbortSignal.timeout(90_000);
	const child = ptree.spawn([bunPath, "--no-env-file", service, data, cliPath], { stdin: "pipe", signal: deadline });
	stopService = async () => {
		child.stdin.end();
		await child.exited;
	};
	const lines = readLines(child.stdout, deadline);
	const decoder = new TextDecoder();
	async function request<T>(value: object): Promise<T> {
		child.stdin.write(`${JSON.stringify(value)}\n`);
		child.stdin.flush();
		const line = await lines.next();
		if (line.done) throw new Error(`Graph sidecar exited: ${child.peekStderr()}`);
		const result = JSON.parse(decoder.decode(line.value)) as { ok: boolean; data: T; error?: string };
		if (!result.ok) throw new Error(result.error);
		return result.data;
	}
	await request({
		op: "start",
		input: { source: source.info().repoRoot, files: [file], objective: "Set the backend fixture text" },
	});
	let status: { run: GraphRun; running: boolean; status?: string; error?: string };
	do {
		await Bun.sleep(200);
		status = await request({ op: "status" });
	} while (status.running);
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	const artifact = await request<{ patch: string; baseSha: string }>({ op: "patch" });
	strictEqual(artifact.patch.includes("+service fixture"), true);
	strictEqual(artifact.baseSha, await source.headSha());
	strictEqual(await Bun.file(temp.join("source", file)).text(), original[file]);
	strictEqual(await source.isDirty(), false);
	deepStrictEqual(toolCalls, [
		"kostomp_graph_read_file",
		"kostomp_graph_submit_patch",
		"kostomp_graph_read_file",
		"kostomp_graph_review",
	]);
	await Bun.write(temp.join("source", file), "new user edit\n");
	await rejects(request({ op: "patch" }), /source changed/);
	strictEqual((await request<{ status: string }>({ op: "status" })).status, "stale_base");
	process.stdout.write("Graph sidecar Coder → Docker Tester → Reviewer → verified patch passed\n");
} finally {
	try {
		await stopService?.();
	} finally {
		server.stop(true);
	}
}
