import { deepStrictEqual, rejects, strictEqual } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, ptree, readLines, TempDir } from "@oh-my-pi/pi-utils";
import type { FailureObservation } from "../failure-judge";
import { changeSet, fixture, original } from "../fixtures/git";
import { completion, type CompletionRequest } from "../fixtures/openai";
import type { GraphRun } from "../run-store";
import type { GraphTask } from "../task-plan";

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
const backend = "src/backend.txt";
const initialBackend = "unrestricted refresh endpoint";
const editedBrief = "Serve token refresh and verify authorization";
const finding = {
	file: backend,
	issue: "The refresh endpoint has no guard",
	expectedChange: "Require authenticated refresh",
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
const initialBackendPatch = (
	await changeSet(await fixture(temp.join("initial-backend"), files), "code", {
		[backend]: `${initialBackend}\n`,
	})
).patch;
const data = temp.join("data");
const toolCalls: string[] = [];
const coderStarts: string[] = [];
let repairedBackend = false;
let blockReview = false;
let omitPlan = false;
let requireEditedBrief = true;
let judgeAvailable = true;
const judgeRequests: unknown[] = [];
// Backend and frontend Coders each wait here for the other's first request, which proves they overlap.
const parallel = Promise.withResolvers<void>();
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 120,
	async fetch(request) {
		const route = new URL(request.url).pathname;
		if (request.method === "POST" && route === "/v1/systemone") {
			strictEqual(request.headers.get("authorization"), "Bearer graph-judge-fixture");
			judgeRequests.push(await request.json());
			if (!judgeAvailable) return new Response("private-provider-diagnostic", { status: 401 });
			return Response.json({
				model: "graph-judge-fixture-model",
				answers: {
					test_failure: { type: "choice", choice: "code_regression", confidence: 0.92 },
				},
			});
		}
		if (request.method !== "POST" || route !== "/v1/chat/completions") return new Response(null, { status: 404 });
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
			if (omitPlan) steps.pop();
		} else if (resultTool === "kostomp_graph_submit_patch") {
			const owned = Object.keys(edits).find(file => prompt.includes(`Owned files:\\n[\\"${file}`))!;
			strictEqual(prompt.includes("Pinned source hints"), true, "A new Coder gets the Context Manager's output");
			if (owned === backend) {
				strictEqual(prompt.includes("initial backend"), true, "The owned file excerpt is included");
				strictEqual(prompt.includes("code-contract"), true, "The Coder gets the prerequisite's changed files");
				strictEqual(prompt.includes("token v1"), false, "Prerequisite context cannot supply a stale base excerpt");
			}
			if (owned === backend && requireEditedBrief) {
				strictEqual(prompt.includes(editedBrief), true, "The Coder receives the approved edit");
			}
			if (prompt.includes(finding.expectedChange)) {
				strictEqual(owned, backend, "The review finding must reach only the file owner");
				strictEqual(prompt.includes(initialBackend), true, "The previous patch must reach the Coder");
				repairedBackend = true;
			}
			// Dependent Coders read the contract from their prerequisite's candidate.
			expectedRead = owned === "src/api.txt" ? "token v1" : "token v2 with refresh";
			steps = [
				["kostomp_graph_read_file", { path: "src/api.txt" }],
				[
					"kostomp_graph_submit_patch",
					{ patch: owned === backend && !repairedBackend ? initialBackendPatch : patches[owned] },
				],
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
				["kostomp_graph_read_file", { path: backend, version: "candidate" }],
			];
			const proposedBackend = JSON.stringify(responses[1]?.content) ?? "";
			if (proposedBackend.includes(initialBackend)) {
				steps.push(
					[
						"kostomp_graph_review",
						{ verdict: "changes_requested", findings: [{ ...finding, file: "src/secret.txt" }] },
					],
					["kostomp_graph_review", { verdict: "changes_requested", findings: [finding] }],
				);
				if (responses.length >= 3) {
					strictEqual(JSON.stringify(responses[2].content).includes("outside the owned files"), true);
				}
			} else if (blockReview) {
				steps.push([
					"kostomp_graph_review",
					{
						verdict: "changes_requested",
						findings: [
							finding,
							{
								file: "src/frontend.txt",
								issue: "The client retries indefinitely",
								expectedChange: "Limit retries to one",
							},
						],
					},
				]);
			} else {
				steps.push(["kostomp_graph_review", { verdict: "accepted", findings: [] }]);
			}
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
	const checks = Object.entries(edits).map(([file, text]) => {
		const check = `test "$(cat ${file})" = "${text.trim()}"`;
		return file === backend ? `(${check} || test "$(cat ${backend})" = "${initialBackend}")` : check;
	});
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
			env: { ...Bun.env, TYPESAFE_API_KEY: "graph-judge-fixture" },
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
		reason?: string;
		error?: string;
		planError?: string;
		logs?: string[];
		failureObservation?: FailureObservation;
		draft?: { id: string; hash: string; source: string; tasks: GraphTask[] };
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
	deepStrictEqual(status.logs, ["planner"]);
	const plannerLog = await request<string>({ op: "log", input: "planner" });
	strictEqual(plannerLog.includes("outside the approved scope"), true, plannerLog);
	deepStrictEqual(
		draft.tasks.map(task => task.id),
		["contract", "backend", "frontend"],
	);
	deepStrictEqual(toolCalls, ["kostomp_graph_read_file", "kostomp_graph_submit_plan", "kostomp_graph_submit_plan"]);
	await stopService?.();
	request = startService();
	status = await settle();
	deepStrictEqual(status.draft, draft, "A restart restores the exact proposal without rerunning the Planner");
	strictEqual(await request<string>({ op: "log", input: "planner" }), plannerLog);
	strictEqual(status.run, undefined, "Restoring a draft does not authorize work");
	strictEqual(draft.source, input.source);
	const shownDraft = { draft: draft.id, hash: draft.hash };
	const editedSourceFile = temp.join("source", backend);
	await Bun.write(editedSourceFile, "new user edit\n");
	await rejects(request({ op: "approve", input: shownDraft }), /source changed/);
	deepStrictEqual((await settle()).draft, draft, "Rejected approval leaves the draft available");
	await Bun.write(editedSourceFile, files[backend]);
	const invalidTasks = draft.tasks.map(task =>
		task.id === "backend" ? { ...task, files: ["src/secret.txt"] } : task,
	);
	await rejects(
		request({ op: "edit", input: { ...shownDraft, plan: { tasks: invalidTasks } } }),
		/outside the approved scope/,
	);
	deepStrictEqual((await settle()).draft, draft, "Rejected edits leave the original draft available");
	const editedTasks = draft.tasks.map(task => (task.id === "backend" ? { ...task, brief: editedBrief } : task));
	await request({ op: "edit", input: { ...shownDraft, plan: { tasks: editedTasks } } });
	await stopService?.();
	request = startService();
	status = await settle();
	const edited = status.draft;
	if (!edited) throw new Error("Edited draft did not survive restart");
	deepStrictEqual(edited.tasks, editedTasks);
	strictEqual(status.run, undefined, "Saving edits does not approve a run");
	await rejects(request({ op: "approve", input: shownDraft }), /plan changed/);
	const approveDraft = { op: "approve", input: { draft: edited.id, hash: edited.hash } };
	const { id } = await request<{ id: string }>(approveDraft);
	await rejects(request({ op: "plan", input }), /already active/);
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	deepStrictEqual(coderStarts.sort(), [backend, backend, "src/frontend.txt"]);
	deepStrictEqual(status.logs, ["planner", "code-contract", "code-backend", "code-frontend", "test", "review"]);
	const coderLog = await request<string>({ op: "log", input: "code-backend" });
	strictEqual(/→ kostomp_graph_read_file[\s\S]*← kostomp_graph_submit_patch/.test(coderLog), true, coderLog);
	strictEqual(coderLog.includes("token v2 with refresh"), true, "The Coder log shows the upstream contract it read");
	strictEqual((await request<string>({ op: "log", input: "review" })).includes("kostomp_graph_review"), true);
	const testLog = await request<string>({ op: "log", input: "test" });
	strictEqual(testLog.includes("Exit code 0"), true, testLog);
	strictEqual(/graph-smoke-stdout[\s\S]*graph-smoke-stderr/.test(testLog), true, testLog);
	strictEqual(testLog.includes("\x1b"), false, "ANSI reaches the log");
	await rejects(request({ op: "log", input: "release" }), /no log/);
	const artifact = await request<{ patch: string; baseSha: string }>({ op: "patch" });
	for (const text of Object.values(edits)) strictEqual(artifact.patch.includes(`+${text.trim()}`), true);
	strictEqual(artifact.baseSha, await source.headSha());
	strictEqual(await Bun.file(temp.join("source", "src/api.txt")).text(), files["src/api.txt"]);
	strictEqual(await source.isDirty(), false);
	await stopService?.();
	request = startService();
	const saved = await request<{ id: string }[]>({ op: "list" });
	strictEqual(saved[0]?.id, id);
	strictEqual((await settle()).draft, undefined, "An approved proposal does not return after a restart");
	await rejects(request(approveDraft), /plan changed/);
	await request({ op: "open", input: id });
	deepStrictEqual(await request({ op: "patch" }), artifact);
	status = await request<Status>({ op: "status" });
	strictEqual(status.run?.context?.planHash, edited.hash);
	strictEqual(await request<string>({ op: "log", input: "test" }), testLog, "The log survives a restart");
	strictEqual(
		await request<string>({ op: "log", input: "planner" }),
		plannerLog,
		"Approval attaches the original transcript to the run",
	);
	const reviews = toolCalls.filter(name => name === "kostomp_graph_review").length;
	await request({ op: "retry", input: "code-backend" });
	status = await settle();
	strictEqual(status.status, "ready_to_export", JSON.stringify(status));
	const nodes = status.run!.nodes;
	deepStrictEqual(
		["context", "code-contract", "code-backend", "code-frontend", "test", "review", "release"].map(
			node => nodes[node].attempt,
		),
		[1, 1, 3, 1, 2, 2, 2],
		"The same backend result reruns nothing downstream",
	);
	strictEqual(toolCalls.filter(name => name === "kostomp_graph_review").length, reviews);
	blockReview = true;
	await request({ op: "retry", input: "review" });
	status = await settle();
	strictEqual(status.run?.nodes["code-backend"].attempt, 3);
	strictEqual(status.run?.nodes["code-frontend"].attempt, 1);
	strictEqual(status.status, "needs_input", JSON.stringify(status));
	strictEqual(status.reason, "Review requested changes.");
	await rejects(request({ op: "patch" }), /no verified patch/);
	blockReview = false;
	await request({ op: "retry", input: "review" });
	strictEqual((await settle()).status, "ready_to_export");
	await request({ op: "plan", input });
	const discarded = (await settle()).draft;
	if (!discarded) throw new Error("Planner produced no draft to discard");
	omitPlan = true;
	await request({ op: "plan", input });
	await settle();
	await stopService?.();
	request = startService();
	status = await settle();
	deepStrictEqual(status.draft, discarded, "A failed Planner does not replace the previous draft");
	strictEqual(status.planError?.includes("did not submit a valid Graph plan"), true);
	const failedPlannerLog = await request<string>({ op: "log", input: "planner" });
	strictEqual(failedPlannerLog.includes("outside the approved scope"), true, failedPlannerLog);
	strictEqual(failedPlannerLog.includes(status.planError!), true, failedPlannerLog);
	await request({ op: "discard" });
	await stopService?.();
	request = startService();
	strictEqual((await settle()).draft, undefined, "A discarded proposal stays deleted after restart");
	await Bun.write(editedSourceFile, "new user edit\n");
	await rejects(request({ op: "patch" }), /source changed/);
	strictEqual((await request<{ status: string }>({ op: "status" })).status, "stale_base");
	strictEqual(judgeRequests.length, 0);
	await Bun.write(editedSourceFile, files[backend]);
	omitPlan = false;
	requireEditedBrief = false;
	await Bun.write(
		path.join(data, "profile.json"),
		JSON.stringify({
			provider,
			model,
			tester: {
				dockerPath,
				imageId,
				timeoutMs: 30_000,
				command: ["/bin/sh", "-c", "echo 'AssertionError: private-test-log' >&2; exit 23"],
			},
			failureJudge: { provider: "typesafe", model: "jev-1.14.0", timeoutMs: 2500, baseUrl: server.url.origin },
		}),
	);
	await request({ op: "plan", input });
	const observedDraft = (await settle()).draft;
	if (!observedDraft) throw new Error("Planner produced no draft for the failed test");
	const observedRun = await request<{ id: string }>({
		op: "approve",
		input: { draft: observedDraft.id, hash: observedDraft.hash },
	});
	status = await settle();
	strictEqual(status.status, "needs_input");
	strictEqual(status.reason, "Tests failed (exit code 23).");
	strictEqual(status.run?.nodes["code-backend"].attempt, 1, "A Jev classification cannot choose a Coder");
	strictEqual(status.failureObservation?.status, "observed", JSON.stringify(status.failureObservation));
	if (status.failureObservation.status === "observed") {
		strictEqual(status.failureObservation.choice, "code_regression");
		strictEqual(status.failureObservation.confidence, 0.92);
	}
	strictEqual(judgeRequests.length, 1);
	deepStrictEqual((judgeRequests[0] as { state: unknown }).state, { exitCode: 23, summary: "Assertion failure" });
	strictEqual(JSON.stringify(judgeRequests[0]).includes("private-test-log"), false);
	strictEqual((await request<string>({ op: "log", input: "test" })).includes("private-test-log"), true);
	const observed = status.failureObservation;
	await stopService?.();
	request = startService();
	await request({ op: "open", input: observedRun.id });
	deepStrictEqual((await settle()).failureObservation, observed);
	judgeAvailable = false;
	await request({ op: "retry", input: "test" });
	status = await settle();
	strictEqual(status.status, "needs_input");
	strictEqual(status.run?.nodes.release.attempt, 1, "Jev metadata does not change the test artifact");
	strictEqual(status.failureObservation?.status, "unavailable");
	strictEqual(JSON.stringify(status.failureObservation).includes("private-provider-diagnostic"), false);
	await rejects(request({ op: "patch" }), /no verified patch/);
	process.stdout.write(
		"Graph draft recovery, Context Manager, parallel Coders, scoped repair, logs, Jev observations and release gates passed\n",
	);
} finally {
	try {
		await stopService?.();
	} finally {
		server.stop(true);
	}
}
