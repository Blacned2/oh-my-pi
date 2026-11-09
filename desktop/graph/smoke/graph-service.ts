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
const plannedTask = {
	id: "backend",
	title: "Backend text",
	brief: "Set the backend fixture text",
	dependsOn: [],
	files: [file],
};

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
		const resultTool = ["kostomp_graph_submit_plan", "kostomp_graph_submit_patch", "kostomp_graph_review"].find(
			name => tools.includes(name),
		)!;
		deepStrictEqual([...tools].sort(), ["kostomp_graph_read_file", resultTool].sort());
		const planner = resultTool === "kostomp_graph_submit_plan";
		const responses = body.messages.filter(message => message.role === "tool");
		const steps: [string, object][] = [
			[
				"kostomp_graph_read_file",
				{ path: file, version: resultTool === "kostomp_graph_review" ? "candidate" : "base" },
			],
		];
		if (planner) {
			steps.push(
				["kostomp_graph_submit_plan", { tasks: [{ ...plannedTask, files: ["src/secret.txt"] }] }],
				["kostomp_graph_submit_plan", { tasks: [plannedTask] }],
			);
		} else {
			steps.push([
				resultTool,
				resultTool === "kostomp_graph_review" ? { verdict: "accepted" } : { patch: change.patch },
			]);
		}
		if (responses.length >= 1) {
			const expected = resultTool === "kostomp_graph_review" ? "service fixture" : original[file].trim();
			if (!JSON.stringify(responses[0].content).includes(expected))
				throw new Error("Graph did not provide the expected file version");
		}
		if (
			planner &&
			responses.length >= 2 &&
			!JSON.stringify(responses[1].content).includes("outside the approved scope")
		)
			throw new Error("Graph did not reject the out-of-scope plan");
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
	function startService() {
		const deadline = AbortSignal.timeout(90_000);
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
	await request({
		op: "plan",
		input: { source: source.info().repoRoot, files: [file], objective: "Set the backend fixture text" },
	});
	let status = await settle();
	strictEqual(status.run, undefined, "No run exists before approval");
	const draft = status.draft;
	if (!draft) throw new Error(`Planner produced no draft: ${JSON.stringify(status)}`);
	deepStrictEqual(
		draft.tasks.map(task => [task.id, task.files]),
		[["backend", [file]]],
	);
	deepStrictEqual(toolCalls, ["kostomp_graph_read_file", "kostomp_graph_submit_plan", "kostomp_graph_submit_plan"]);
	await rejects(request({ op: "approve", input: { draft: draft.id, hash: "0".repeat(64) } }), /plan changed/);
	const { id } = await request<{ id: string }>({ op: "approve", input: { draft: draft.id, hash: draft.hash } });
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	strictEqual(status.draft, undefined);
	const artifact = await request<{ patch: string; baseSha: string }>({ op: "patch" });
	strictEqual(artifact.patch.includes("+service fixture"), true);
	strictEqual(artifact.baseSha, await source.headSha());
	strictEqual(await Bun.file(temp.join("source", file)).text(), original[file]);
	strictEqual(await source.isDirty(), false);
	await stopService?.();
	request = startService();
	const saved = await request<{ id: string }[]>({ op: "list" });
	strictEqual(saved[0]?.id, id);
	await request({ op: "open", input: id });
	deepStrictEqual(await request({ op: "patch" }), artifact);
	status = await request<Status>({ op: "status" });
	strictEqual(status.run?.context?.planHash, draft.hash);
	deepStrictEqual(
		status.run?.context?.tasks?.map(task => task.id),
		["backend"],
	);
	await request({ op: "retry", input: "test" });
	await rejects(request({ op: "patch" }), /no verified patch/);
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	const nodes = status.run!.nodes;
	deepStrictEqual(
		["code-backend", "test", "review", "release"].map(node => nodes[node].attempt),
		[1, 2, 1, 1],
	);
	deepStrictEqual(toolCalls.slice(3), [
		"kostomp_graph_read_file",
		"kostomp_graph_submit_patch",
		"kostomp_graph_read_file",
		"kostomp_graph_review",
	]);
	await Bun.write(temp.join("source", file), "new user edit\n");
	await rejects(request({ op: "patch" }), /source changed/);
	strictEqual((await request<{ status: string }>({ op: "status" })).status, "stale_base");
	process.stdout.write("Graph planning, approval, restart, targeted retry and stale release passed\n");
} finally {
	try {
		await stopService?.();
	} finally {
		server.stop(true);
	}
}
