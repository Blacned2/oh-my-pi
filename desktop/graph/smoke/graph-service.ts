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

// JWT refresh: the shared API contract has one owner, backend and frontend depend on it and run in parallel.
const files = { ...original, "src/api.txt": "token v1\n" };
const edits: Record<string, string> = {
	"src/api.txt": "token v2 with refresh\n",
	"src/backend.txt": "refresh endpoint\n",
	"src/frontend.txt": "retry on 401\n",
};
const tasks = [
	{
		id: "contract",
		title: "API contract",
		brief: "Add refresh to the token contract",
		dependsOn: [],
		files: ["src/api.txt"],
	},
	{
		id: "backend",
		title: "Backend",
		brief: "Serve token refresh",
		dependsOn: ["contract"],
		files: ["src/backend.txt"],
	},
	{
		id: "frontend",
		title: "Frontend",
		brief: "Retry once on 401",
		dependsOn: ["contract"],
		files: ["src/frontend.txt"],
	},
];

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
const source = await fixture(temp.join("source"), files);
const patches: Record<string, string> = {};
for (const [index, [file, text]] of Object.entries(edits).entries()) {
	patches[file] = (await changeSet(await fixture(temp.join(`edit-${index}`), files), "code", { [file]: text })).patch;
}
const data = temp.join("data");
const toolCalls: string[] = [];
const coderStarts: string[] = [];
// Backend and frontend Coders each wait here for the other's first request, which proves they overlap.
const parallel = Promise.withResolvers<void>();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 120,
	async fetch(request) {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
			return new Response(null, { status: 404 });
		const body = (await request.json()) as CompletionRequest;
		const tools = body.tools?.map(tool => tool.function.name) ?? [];
		const resultTool = ["kostomp_graph_submit_plan", "kostomp_graph_submit_patch", "kostomp_graph_review"].find(
			name => tools.includes(name),
		)!;
		deepStrictEqual([...tools].sort(), ["kostomp_graph_read_file", resultTool].sort());
		const responses = body.messages.filter(message => message.role === "tool");
		const prompt = JSON.stringify(body.messages);
		let steps: [string, object][];
		let expectedRead: string;
		if (resultTool === "kostomp_graph_submit_plan") {
			expectedRead = "token v1";
			steps = [
				["kostomp_graph_read_file", { path: "src/api.txt", version: "base" }],
				["kostomp_graph_submit_plan", { tasks: [{ ...tasks[0], files: ["src/secret.txt"] }] }],
				["kostomp_graph_submit_plan", { tasks }],
			];
			if (responses.length >= 2 && !JSON.stringify(responses[1].content).includes("outside the approved scope"))
				throw new Error("Graph did not reject the out-of-scope plan");
		} else if (resultTool === "kostomp_graph_submit_patch") {
			const owned = Object.keys(edits).find(file => prompt.includes(`Owned files:\\n[\\"${file}`))!;
			// Dependent Coders read the contract from their prerequisite's candidate.
			expectedRead = owned === "src/api.txt" ? "token v1" : "token v2 with refresh";
			steps = [
				["kostomp_graph_read_file", { path: "src/api.txt" }],
				["kostomp_graph_submit_patch", { patch: patches[owned] }],
			];
			if (responses.length === 0 && owned !== "src/api.txt") {
				coderStarts.push(owned);
				if (new Set(coderStarts).size === 2) parallel.resolve();
				await parallel.promise;
			}
		} else {
			expectedRead = "retry on 401";
			steps = [
				["kostomp_graph_read_file", { path: "src/frontend.txt", version: "candidate" }],
				["kostomp_graph_review", { verdict: "accepted" }],
			];
		}
		if (responses.length >= 1 && !JSON.stringify(responses[0].content).includes(expectedRead))
			throw new Error(`Graph did not provide ${expectedRead}`);
		const step = steps[responses.length];
		if (!step) return completion(model, { content: "Done" }, "stop");
		const [name, args] = step;
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
	const checks = Object.entries(edits).map(([file, text]) => `test "$(cat ${file})" = "${text.trim()}"`);
	// Colored stdout and a stderr line reach the Desktop log only as plain text.
	const output = ["printf '\\033[32mgraph-smoke-stdout\\033[0m\\n'", "echo graph-smoke-stderr >&2"];
	await Bun.write(
		path.join(data, "profile.json"),
		JSON.stringify({
			provider,
			model,
			tester: {
				dockerPath,
				imageId,
				timeoutMs: 30000,
				command: ["/bin/sh", "-c", [...output, ...checks].join(" && ")],
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
	function startService() {
		const deadline = AbortSignal.timeout(180_000);
		const child = ptree.spawn([bunPath, "--no-env-file", service, data, cliPath], {
			stdin: "pipe",
			signal: deadline,
		});
		stopService = async () => {
			child.stdin.end();
			await child.exited;
		};
		const lines = readLines(child.stdout, deadline);
		const decoder = new TextDecoder();
		return async function request<T>(value: object): Promise<T> {
			child.stdin.write(`${JSON.stringify(value)}\n`);
			child.stdin.flush();
			const line = await lines.next();
			if (line.done) throw new Error(`Graph sidecar exited: ${child.peekStderr()}`);
			const result = JSON.parse(decoder.decode(line.value)) as { ok: boolean; data: T; error?: string };
			if (!result.ok) throw new Error(result.error);
			return result.data;
		};
	}
	let request = startService();
	type Status = {
		run?: GraphRun;
		running?: boolean;
		planning: boolean;
		status?: string;
		error?: string;
		planError?: string;
		logs?: string[];
		draft?: { id: string; hash: string; tasks: { id: string; files: string[] }[] };
	};
	const settle = async () => {
		let status: Status;
		do {
			await Bun.sleep(200);
			status = await request<Status>({ op: "status" });
		} while (status.running || status.planning);
		return status;
	};
	const input = { source: source.info().repoRoot, files: Object.keys(edits), objective: "Fix JWT refresh" };
	await request({ op: "plan", input });
	let status = await settle();
	strictEqual(status.run, undefined, "No run exists before approval");
	const draft = status.draft;
	if (!draft) throw new Error(`Planner produced no draft: ${JSON.stringify(status)}`);
	deepStrictEqual(
		draft.tasks.map(task => task.id),
		["contract", "backend", "frontend"],
	);
	deepStrictEqual(toolCalls, ["kostomp_graph_read_file", "kostomp_graph_submit_plan", "kostomp_graph_submit_plan"]);
	await rejects(request({ op: "approve", input: { draft: draft.id, hash: "0".repeat(64) } }), /plan changed/);
	const { id } = await request<{ id: string }>({ op: "approve", input: { draft: draft.id, hash: draft.hash } });
	await rejects(request({ op: "plan", input }), /already active/);
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	deepStrictEqual(coderStarts.sort(), ["src/backend.txt", "src/frontend.txt"]);
	deepStrictEqual(status.logs, ["test"]);
	const testLog = await request<string>({ op: "log", input: "test" });
	strictEqual(testLog.includes("Exit code 0"), true, testLog);
	strictEqual(/graph-smoke-stdout[\s\S]*graph-smoke-stderr/.test(testLog), true, testLog);
	strictEqual(testLog.includes("\x1b"), false, "ANSI reaches the log");
	await rejects(request({ op: "log", input: "review" }), /no log/);
	const artifact = await request<{ patch: string; baseSha: string }>({ op: "patch" });
	for (const text of Object.values(edits)) strictEqual(artifact.patch.includes(`+${text.trim()}`), true);
	strictEqual(artifact.baseSha, await source.headSha());
	strictEqual(await Bun.file(temp.join("source", "src/api.txt")).text(), files["src/api.txt"]);
	strictEqual(await source.isDirty(), false);
	await stopService?.();
	request = startService();
	const saved = await request<{ id: string }[]>({ op: "list" });
	strictEqual(saved[0]?.id, id);
	await request({ op: "open", input: id });
	deepStrictEqual(await request({ op: "patch" }), artifact);
	status = await request<Status>({ op: "status" });
	strictEqual(status.run?.context?.planHash, draft.hash);
	strictEqual(await request<string>({ op: "log", input: "test" }), testLog, "The log survives a restart");
	const reviews = toolCalls.filter(name => name === "kostomp_graph_review").length;
	await request({ op: "retry", input: "code-backend" });
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	const nodes = status.run!.nodes;
	deepStrictEqual(
		["code-contract", "code-backend", "code-frontend", "test", "review", "release"].map(node => nodes[node].attempt),
		[1, 2, 1, 1, 1, 1],
		"The same backend result reruns nothing downstream",
	);
	strictEqual(toolCalls.filter(name => name === "kostomp_graph_review").length, reviews);
	await Bun.write(temp.join("source", "src/backend.txt"), "new user edit\n");
	await rejects(request({ op: "patch" }), /source changed/);
	strictEqual((await request<{ status: string }>({ op: "status" })).status, "stale_base");
	process.stdout.write(
		"Graph planning, approval, parallel Coders, test log, restart, targeted retry and stale release passed\n",
	);
} finally {
	try {
		await stopService?.();
	} finally {
		server.stop(true);
	}
}
