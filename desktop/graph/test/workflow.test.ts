import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { changeSet, fixture } from "../fixtures/git";
import { type CoderRepairFeedback, GraphRunStore } from "../run-store";
import { graphPlanForTasks } from "../task-plan";
import {
	type ApprovedGraphExecutors,
	graphWork,
	proposeGraphPlan,
	readGraphRelease,
	retryGraphNode,
	runApprovedGraph,
} from "../workflow";
import { GraphWorkspace } from "../workspace";

const backend = "src/backend.txt";
const frontend = "src/frontend.txt";
const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const unusedPlanner: ApprovedGraphExecutors["plan"] = async () => {
	throw new Error("Planner is not part of this run");
};

/** The fixed plan stored by runs created before planning was added. */
const savedSingleCoderPlan = {
	version: 1,
	nodes: [
		{ id: "code", role: "coder", dependsOn: [], maxAttempts: 3 },
		{ id: "test", role: "tester", dependsOn: ["code"], maxAttempts: 3 },
		{ id: "review", role: "reviewer", dependsOn: ["code", "test"], maxAttempts: 3 },
		{ id: "release", role: "gate", dependsOn: ["code", "test", "review"], maxAttempts: 3 },
	],
};

test("a reopened run withdraws its prior release and stops after bounded repairs of a failing test", async () => {
	await using temp = await TempDir.create("@kostomp-graph-retry-");
	const source = await fixture(temp.join("source"));
	const edited = await fixture(temp.join("edited"));
	const { patch } = await changeSet(edited, "code", { [backend]: "retry fixture\n" });
	const sourceRoot = source.info().repoRoot;
	const context = {
		sourceRoot,
		baseSha: (await source.headSha())!,
		objective: "Change the fixture",
		files: [backend],
		profileHash: "fixture",
	};
	const db = temp.join("runs.sqlite");
	let exitCode = 0;
	let codeCalls = 0;
	let reviewCalls = 0;
	const feedback: CoderRepairFeedback[] = [];
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		async code(_view, _task, _work, _signal, _log, repair) {
			codeCalls++;
			if (repair) feedback.push(repair.feedback);
			return patch;
		},
		async test(workspace, candidate) {
			const { data } = await workspace.readCandidateFile(candidate, backend);
			expect(decode(data)).toBe("retry fixture\n");
			return {
				treeId: candidate.treeId,
				exitCode,
				elapsedMs: 1,
				stdout: "",
				stderr: "\u001b[31mJWT fixture failed\u001b[0m",
			};
		},
		async review() {
			reviewCalls++;
			return { verdict: "accepted", findings: [] };
		},
	};
	let id: string;
	{
		using store = new GraphRunStore(db);
		await using workspace = await GraphWorkspace.pin(sourceRoot);
		id = store.create(savedSingleCoderPlan, context).id;
		await runApprovedGraph(store, id, workspace, graphWork(context), executors);
		expect(readGraphRelease(store, id)?.status).toBe("ready_to_export");
	}
	using store = new GraphRunStore(db);
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	expect(store.retry(id, "test")).toBe(true);
	expect(readGraphRelease(store, id)).toBeUndefined();
	exitCode = 23;
	await runApprovedGraph(store, id, workspace, graphWork(store.get(id)!.context!), executors);
	expect(readGraphRelease(store, id)).toEqual({ status: "needs_input", reason: "Tests failed (exit code 23)." });
	expect(codeCalls).toBe(3);
	expect(feedback).toHaveLength(2);
	for (const input of feedback) {
		expect(input).toMatchObject({ testExitCode: 23 });
		const log = "log" in input ? input.log : "";
		expect(log).toContain("JWT fixture failed");
		expect(log).not.toContain("\u001b");
	}
	expect(reviewCalls).toBe(1);
	expect(await source.isDirty()).toBe(false);
});

test("an approved plan runs dependent Coders on upstream results and a same-result retry reruns nothing", async () => {
	await using temp = await TempDir.create("@kostomp-graph-plan-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const backendChange = await changeSet(await fixture(temp.join("backend")), "code-api", {
		[backend]: "api v2\n",
	});
	const frontendRepo = await fixture(temp.join("frontend"));
	const input = { source: sourceRoot, objective: "Upgrade the API and its client" };
	const calls: string[] = [];
	const executors: ApprovedGraphExecutors = {
		async plan(_workspace, _input, validate) {
			expect(() =>
				validate({ tasks: [{ id: "x", title: "X", brief: "X", dependsOn: ["x"], files: [backend] }] }),
			).toThrow(/itself/);
			return {
				tasks: [
					{ id: "ui", title: "Client", brief: "Follow the API", dependsOn: ["api"], files: [frontend] },
					{ id: "api", title: "API", brief: "Bump the API", dependsOn: [], files: [backend] },
				],
			};
		},
		async code(view, task, work, signal, _log, _repair, context) {
			calls.push(task.nodeId);
			if (task.nodeId === "code-api") return backendChange.patch;
			expect(context).toEqual({
				references: [{ file: frontend, line: 1, excerpt: "initial frontend" }],
				upstream: [{ nodeId: "code-api", files: [backend] }],
			});
			const upstream = decode((await view.read(backend, signal)).data).trim();
			const { patch } = await changeSet(frontendRepo, task.nodeId, { [frontend]: `client of ${upstream}\n` });
			return patch;
		},
		async test(workspace, candidate) {
			calls.push("test");
			const read = async (file: string) => decode((await workspace.readCandidateFile(candidate, file)).data);
			expect([await read(backend), await read(frontend)]).toEqual(["api v2\n", "client of api v2\n"]);
			return { treeId: candidate.treeId, exitCode: 0, elapsedMs: 1, stdout: "", stderr: "" };
		},
		async review(_workspace, _candidate, work) {
			calls.push("review");
			expect(work.tasks.map(task => task.files)).toEqual([[backend], [frontend]]);
			return { verdict: "accepted", findings: [] };
		},
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const plan = await proposeGraphPlan(workspace, input, executors, AbortSignal.timeout(30_000));
	expect(calls).toEqual([]);
	const context = { sourceRoot, baseSha: workspace.baseSha, objective: input.objective, files: [] };
	const { id } = store.create(graphPlanForTasks(plan), { ...context, profileHash: "fixture", tasks: plan.tasks });
	const work = graphWork(store.get(id)!.context!);
	await runApprovedGraph(store, id, workspace, work, executors);
	expect(calls).toEqual(["code-api", "code-ui", "test", "review"]);
	const release = readGraphRelease(store, id);
	expect(release?.status).toBe("ready_to_export");
	expect(store.retry(id, "code-api")).toBe(true);
	calls.length = 0;
	await runApprovedGraph(store, id, workspace, work, executors);
	expect(calls).toEqual(["code-api"]);
	expect(readGraphRelease(store, id)).toEqual(release!);
	expect(await source.isDirty()).toBe(false);
	expect(await Bun.file(path.join(sourceRoot, frontend)).text()).toBe("initial frontend\n");
});

test("a proposed path that collides with the pinned tree on Windows is rejected", async () => {
	await using temp = await TempDir.create("@kostomp-graph-plan-collision-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const executors = {
		async plan(_workspace, _input, validate) {
			return validate({
				tasks: [{ id: "case", title: "Case", brief: "Edit", dependsOn: [], files: ["SRC/backend.txt"] }],
			});
		},
	} as unknown as ApprovedGraphExecutors;
	const input = { source: source.info().repoRoot, objective: "Edit" };
	await expect(proposeGraphPlan(workspace, input, executors, AbortSignal.timeout(30_000))).rejects.toThrow(
		/collide on Windows/,
	);
});

test("listing a directory shows its immediate children in the pinned base", async () => {
	await using temp = await TempDir.create("@kostomp-graph-list-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	expect(workspace.list("")).toEqual(["src/"]);
	expect(workspace.list("src/")).toEqual(["backend.txt", "frontend.txt"]);
	expect(() => workspace.list("missing/")).toThrow(/does not exist/);
	expect(workspace.files().sort()).toEqual([backend, frontend]);
});

test("parallel Coders reach one candidate, and an unattributed test failure waits for the user to pick a Coder", async () => {
	await using temp = await TempDir.create("@kostomp-graph-parallel-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const patches = {
		"code-back": (await changeSet(await fixture(temp.join("back")), "code-back", { [backend]: "jwt refresh\n" }))
			.patch,
		"code-front": (await changeSet(await fixture(temp.join("front")), "code-front", { [frontend]: "retry on 401\n" }))
			.patch,
	};
	const tasks = [
		{ id: "back", title: "Backend", brief: "Refresh tokens", dependsOn: [], files: [backend] },
		{ id: "front", title: "Frontend", brief: "Retry once", dependsOn: [], files: [frontend] },
	];
	const bothCoding = Promise.withResolvers<void>();
	let coding = 0;
	let exitCode = 0;
	const repairs: string[] = [];
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		async code(_view, task, _work, _signal, _log, repair) {
			if (++coding === 2) bothCoding.resolve();
			if (repair && "log" in repair.feedback && repair.feedback.log.includes("401 fixture failed")) {
				repairs.push(task.nodeId);
			}
			// With one Coder at a time the second never starts, so this barrier hangs and the test times out.
			await bothCoding.promise;
			return patches[task.nodeId as keyof typeof patches];
		},
		async test(workspace, candidate) {
			const read = async (file: string) => decode((await workspace.readCandidateFile(candidate, file)).data);
			expect([await read(backend), await read(frontend)]).toEqual(["jwt refresh\n", "retry on 401\n"]);
			return { treeId: candidate.treeId, exitCode, elapsedMs: 1, stdout: "", stderr: "401 fixture failed" };
		},
		review: async () => ({ verdict: "accepted", findings: [] }),
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const context = {
		sourceRoot,
		baseSha: workspace.baseSha,
		objective: "Fix JWT refresh",
		files: [backend, frontend],
		profileHash: "fixture",
		tasks,
	};
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks }), context);
	await runApprovedGraph(store, id, workspace, graphWork(context), executors, { maxCoders: 2 });
	expect(readGraphRelease(store, id)?.status).toBe("ready_to_export");
	expect(store.retry(id, "test")).toBe(true);
	exitCode = 1;
	const work = graphWork(context);
	await runApprovedGraph(store, id, workspace, work, executors);
	expect(readGraphRelease(store, id)?.status).toBe("needs_input");
	expect(coding).toBe(2);
	expect(retryGraphNode(store, id, work, "code-front")).toBe(true);
	await runApprovedGraph(store, id, workspace, work, executors);
	expect(repairs).toEqual(["code-front"]);
	expect(await source.isDirty()).toBe(false);
});

test("a file-specific review finding repairs only its owning Coder and verifies the new candidate", async () => {
	await using temp = await TempDir.create("@kostomp-graph-review-repair-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const before = await changeSet(await fixture(temp.join("back")), "code-back", { [backend]: "log token\n" });
	const after = await changeSet(await fixture(temp.join("repaired")), "code-back", { [backend]: "rotate token\n" });
	const client = await changeSet(await fixture(temp.join("front")), "code-front", { [frontend]: "retry on 401\n" });
	const tasks = [
		{ id: "back", title: "Backend", brief: "Refresh tokens", dependsOn: [], files: [backend] },
		{ id: "front", title: "Frontend", brief: "Retry once", dependsOn: [], files: [frontend] },
	];
	const finding = { file: backend, issue: "Token is logged", expectedChange: "Rotate without logging it" };
	const tested: string[] = [];
	let frontendCalls = 0;
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		async code(_view, task, _work, _signal, _log, repair) {
			if (task.nodeId === "code-front") {
				frontendCalls++;
				return client.patch;
			}
			if (!repair) return before.patch;
			expect(repair.feedback).toEqual({ findings: [finding] });
			expect(repair.previousPatch).toContain("+log token");
			return after.patch;
		},
		async test(workspace, candidate) {
			tested.push(decode((await workspace.readCandidateFile(candidate, backend)).data));
			expect(decode((await workspace.readCandidateFile(candidate, frontend)).data)).toBe("retry on 401\n");
			return { treeId: candidate.treeId, exitCode: 0, elapsedMs: 1, stdout: "", stderr: "" };
		},
		async review(workspace, candidate) {
			const text = decode((await workspace.readCandidateFile(candidate, backend)).data);
			return text === "rotate token\n"
				? { verdict: "accepted", findings: [] }
				: { verdict: "changes_requested", findings: [finding] };
		},
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const context = {
		sourceRoot,
		baseSha: workspace.baseSha,
		objective: "Fix JWT refresh",
		files: [backend, frontend],
		profileHash: "",
		tasks,
	};
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks }), context);
	await runApprovedGraph(store, id, workspace, graphWork(context), executors);
	expect(tested).toEqual(["log token\n", "rotate token\n"]);
	expect(frontendCalls).toBe(1);
	const release = readGraphRelease(store, id);
	expect(release?.status === "ready_to_export" && release.artifact.patch).toContain("+rotate token");
	expect(await source.isDirty()).toBe(false);
});

test("a parallel Coder that writes outside its scope fails alone and its sibling's change is kept", async () => {
	await using temp = await TempDir.create("@kostomp-graph-parallel-scope-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const intruding = (await changeSet(await fixture(temp.join("back")), "x", { [frontend]: "backend wrote this\n" }))
		.patch;
	const own = (await changeSet(await fixture(temp.join("front")), "x", { [frontend]: "retry on 401\n" })).patch;
	const tasks = [
		{ id: "back", title: "Backend", brief: "Refresh tokens", dependsOn: [], files: [backend] },
		{ id: "front", title: "Frontend", brief: "Retry once", dependsOn: [], files: [frontend] },
	];
	let tested = false;
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		code: async (_view, task) => (task.nodeId === "code-back" ? intruding : own),
		async test() {
			tested = true;
			throw new Error("test must wait for every Coder");
		},
		review: async () => ({ verdict: "accepted", findings: [] }),
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const context = { sourceRoot, baseSha: workspace.baseSha, objective: "Fix", files: [backend, frontend] };
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks }), { ...context, profileHash: "", tasks });
	await runApprovedGraph(store, id, workspace, graphWork(store.get(id)!.context!), executors, { maxCoders: 2 });
	const nodes = store.get(id)!.nodes;
	expect(nodes["code-back"]).toMatchObject({ status: "failed", error: "Graph patch must change only approved files" });
	expect(nodes["code-front"].status).toBe("succeeded");
	expect(tested).toBe(false);
});

test("test output is kept as a sanitized log, and a rerun with new output but the same exit code reuses the review", async () => {
	await using temp = await TempDir.create("@kostomp-graph-log-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const { patch } = await changeSet(await fixture(temp.join("edited")), "x", { [backend]: "logged\n" });
	const tasks = [{ id: "api", title: "API", brief: "Change the API", dependsOn: [], files: [backend] }];
	const outputs = ["\x1b[31mFAIL\x1b[0m first run\r\n", "second run\n"];
	let reviews = 0;
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		code: async () => patch,
		test: async (_workspace, candidate) => ({
			treeId: candidate.treeId,
			exitCode: 0,
			elapsedMs: 7.4,
			stdout: outputs.shift()!,
			stderr: "warning\x07\n",
		}),
		async review() {
			reviews++;
			return { verdict: "accepted", findings: [] };
		},
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const context = { sourceRoot, baseSha: workspace.baseSha, objective: "Log", files: [backend], profileHash: "" };
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks }), { ...context, tasks });
	const work = graphWork(store.get(id)!.context!);
	await runApprovedGraph(store, id, workspace, work, executors);
	const first = store.log(store.get(id)!, "test")!;
	expect(first).toContain("Exit code 0 after 7 ms");
	expect(first).toContain("FAIL first run");
	expect(first).toContain("warning");
	expect(first).not.toMatch(/[\x1b\r\x07]/);
	expect(store.retry(id, "test")).toBe(true);
	await runApprovedGraph(store, id, workspace, work, executors);
	const run = store.get(id)!;
	expect(store.loggedNodes(run)).toEqual(["test"]);
	expect(store.log(run, "test")).toContain("second run");
	expect(reviews).toBe(1);
	expect(readGraphRelease(store, id)?.status).toBe("ready_to_export");
});

test("a failed Coder keeps its sanitized worker log with the attempt", async () => {
	await using temp = await TempDir.create("@kostomp-graph-coder-log-");
	const source = await fixture(temp.join("source"));
	const sourceRoot = source.info().repoRoot;
	const tasks = [{ id: "api", title: "API", brief: "Change the API", dependsOn: [], files: [backend] }];
	const executors: ApprovedGraphExecutors = {
		plan: unusedPlanner,
		async code(_view, _task, _work, _signal, log) {
			log("→ kostomp_graph_read_file\n\x1b[31m✗ kostomp_graph_submit_patch: rejected\x1b[0m");
			throw new Error("Coder did not submit a Graph patch");
		},
		test: async () => {
			throw new Error("unreachable");
		},
		review: async () => ({ verdict: "accepted", findings: [] }),
	};
	using store = new GraphRunStore(":memory:");
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const context = { sourceRoot, baseSha: workspace.baseSha, objective: "Log", files: [backend], profileHash: "" };
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks }), { ...context, tasks });
	await runApprovedGraph(store, id, workspace, graphWork(store.get(id)!.context!), executors);
	const run = store.get(id)!;
	expect(run.nodes["code-api"]).toMatchObject({ status: "failed", error: "Coder did not submit a Graph patch" });
	expect(store.log(run, "code-api")).toBe("→ kostomp_graph_read_file\n✗ kostomp_graph_submit_patch: rejected");
});
