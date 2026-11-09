import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { completion, type CompletionRequest } from "../fixtures/openai";
import { runOmpWorker } from "../omp-worker";
import prompt from "./worker-prompt.md" with { type: "text" };

const provider = "graph-smoke";
const model = "graph-smoke-model";
const toolName = "kostomp_graph_probe";

async function probe(bunPath: string, cliPath: string, scenario: "complete" | "deny" | "cancel"): Promise<void> {
	await using temp = await TempDir.create("@kostomp-graph-smoke-");
	const home = temp.join("home");
	const cwd = temp.join("worker");
	await fs.mkdir(cwd);
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	let toolCalls = 0;
	const requests: CompletionRequest[] = [];
	const routes: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			routes.push(`${request.method} ${new URL(request.url).pathname}`);
			if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
				return new Response(null, { status: 404 });
			}
			const body = (await request.json()) as CompletionRequest;
			requests.push(body);
			if (body.messages.some(message => message.role === "tool")) {
				return completion(model, { content: "Probe finished" }, "stop");
			}
			const call = {
				name: toolName,
				arguments: JSON.stringify({ target: scenario === "deny" ? "../source" : "fixture" }),
			};
			return completion(
				model,
				{ tool_calls: [{ index: 0, id: "call_probe", type: "function", function: call }] },
				"tool_calls",
			);
		},
	});
	const tool: RpcClientCustomTool = {
		name: toolName,
		label: "Graph probe",
		description: "Read the Graph smoke fixture.",
		loadMode: "essential",
		parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
		async execute({ target }, { signal }) {
			toolCalls++;
			if (target !== "fixture") throw new Error("Probe target is outside its scope");
			if (scenario === "cancel") {
				entered.resolve();
				try {
					await untilAborted(signal, () => Promise.withResolvers<void>().promise);
				} finally {
					cancelled.resolve();
				}
			}
			return { content: [{ type: "text", text: "graph-fixture-result" }], details: { value: "fixture" } };
		},
	};
	try {
		if (scenario === "cancel") await Bun.write(path.join(home, "smoke-cli-path"), cliPath);
		await Bun.write(
			path.join(home, ".omp", "agent", "models.yml"),
			JSON.stringify({
				providers: {
					[provider]: {
						baseUrl: `${server.url.origin}/v1`,
						api: "openai-completions",
						apiKey: "smoke-fixture",
						models: [{ id: model, name: "Graph smoke fixture" }],
					},
				},
			}),
		);
		const attempt = runOmpWorker({
			bunPath,
			cliPath: scenario === "cancel" ? path.join(import.meta.dir, "worker-tree.ts") : cliPath,
			home,
			cwd,
			provider,
			model,
			tools: [tool],
			prompt,
			timeoutMs: 45_000,
			signal: controller.signal,
		});
		if (scenario === "cancel") {
			await Promise.race([entered.promise, attempt]);
			const pids = (await Bun.file(path.join(home, "smoke-processes.json")).json()) as number[];
			const processes = pids.map(pid => Process.fromPid(pid));
			try {
				strictEqual(processes.filter(Boolean).length, 2);
			} finally {
				controller.abort(new Error("Graph smoke cancellation"));
				await rejects(attempt, /Graph smoke cancellation/);
			}
			await untilAborted(AbortSignal.timeout(1_000), () => cancelled.promise);
			for (const process of processes) strictEqual(await process?.waitForExit({ timeoutMs: 1000 }), true);
		} else {
			await attempt;
			const results = requests
				.at(-1)
				?.messages.filter(message => message.role === "tool")
				.map(message => message.content);
			strictEqual(results?.length, 1);
			const expected = scenario === "deny" ? /outside its scope/ : /graph-fixture-result/;
			if (!expected.test(JSON.stringify(results))) throw new Error("Unexpected Graph probe result");
		}
		strictEqual(toolCalls, 1);
		for (const request of requests)
			deepStrictEqual(
				request.tools?.map(entry => entry.function.name),
				[toolName],
			);
	} catch (cause) {
		throw new Error(`Graph smoke ${scenario} failed (fixture requests: ${routes.join(", ") || "none"})`, { cause });
	} finally {
		server.stop(true);
	}
}

const runtime = path.resolve(Bun.argv[2] ?? path.join(import.meta.dir, "../../target/release/runtime"));
const bunPath = path.join(runtime, "bun.exe");
const cliPath = path.resolve(Bun.argv[3] ?? path.join(runtime, "node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"));
if (!(await Bun.file(bunPath).exists()) || !(await Bun.file(cliPath).exists())) {
	throw new Error(`Staged Bun or OMP CLI is missing under ${runtime}`);
}
for (const scenario of ["complete", "deny", "cancel"] as const) {
	await probe(bunPath, cliPath, scenario);
	process.stdout.write(`Graph OMP worker ${scenario} passed\n`);
}
