import { expect, test } from "bun:test";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { type GraphNode, parseGraphPlan } from "../plan";
import { type GraphDraft, GraphRunStore } from "../run-store";
import { driveGraphRun } from "../scheduler";
import { graphPlanForTasks } from "../task-plan";

function node(id: string, role: GraphNode["role"], dependsOn: string[] = [], maxAttempts = 2): GraphNode {
	return { id, role, dependsOn, maxAttempts };
}

test("rejects a graph with a cyclic dependency before any node can be scheduled", () => {
	expect(() =>
		parseGraphPlan({ version: 1, nodes: [node("code", "coder", ["test"]), node("test", "tester", ["code"])] }),
	).toThrow(/cycle/);
});

test("join waits for both artifacts and Coders without approved scopes are serialized", () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({
		version: 1,
		nodes: [node("test", "tester", ["back", "front"]), node("back", "coder"), node("front", "coder")],
	});
	const [back, ...others] = store.claimReady(id, 3);
	expect(back.nodeId).toBe("back");
	expect(others).toEqual([]);
	expect(store.claimReady(id, 3)).toEqual([]);
	store.complete(back, "back change");
	const [front] = store.claimReady(id, 3);
	expect(front.nodeId).toBe("front");
	store.complete(front, "front change");
	const [joined] = store.claimReady(id, 3);
	expect(joined.nodeId).toBe("test");
	expect(joined.inputs.map(input => store.artifact(id, input))).toEqual(["back change", "front change"]);
});

test("reuses an independent result and rechecks only descendants with changed inputs", async () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({
		version: 1,
		nodes: [node("code", "coder", [], 3), node("context", "context"), node("test", "tester", ["code", "context"], 1)],
	});
	await driveGraphRun(store, id, 2, async attempt => attempt.nodeId);
	expect(store.retry(id, "code")).toBe(true);
	expect([...store.currentArtifacts(id).keys()]).toEqual(["context"]);
	const rerun: string[] = [];
	await driveGraphRun(store, id, 2, async attempt => {
		rerun.push(attempt.nodeId);
		return attempt.nodeId;
	});
	expect(rerun).toEqual(["code"]);
	expect(store.retry(id, "code")).toBe(true);
	rerun.length = 0;
	await driveGraphRun(store, id, 2, async attempt => {
		rerun.push(attempt.nodeId);
		return `${attempt.nodeId} revised`;
	});
	expect(rerun).toEqual(["code", "test"]);
	expect(store.retry(id, "code")).toBe(false);
});

test("reopen keeps durable artifacts and rejects results from the interrupted attempt", async () => {
	await using temp = await TempDir.create("@kostomp-graph-db-");
	const db = temp.join("graph.sqlite");
	const plan = { version: 1, nodes: [node("code", "coder"), node("test", "tester", ["code"])] };
	const interrupted = (() => {
		using store = new GraphRunStore(db);
		const { id } = store.create(plan);
		const [code] = store.claimReady(id, 1);
		store.complete(code, "verified patch");
		return store.claimReady(id, 1)[0];
	})();
	using store = new GraphRunStore(db);
	const { runId } = interrupted;
	store.recoverInterrupted(runId);
	expect(store.retry(runId, "test")).toBe(true);
	const [next] = store.claimReady(runId, 1);
	expect(store.complete(interrupted, "obsolete result")).toBe(false);
	expect(store.artifact(runId, next.inputs[0])).toBe("verified patch");
	store.complete(next, "new test result");
	const events = store.events(runId, 0);
	expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	expect(events.slice(-4).map(event => event.kind)).toEqual(["interrupted", "retried", "claimed", "succeeded"]);
	expect(store.get(runId)?.sequence).toBe(events.at(-1)?.sequence);
});

test("cancellation reaches the executor and prevents publishing a late artifact", async () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({ version: 1, nodes: [node("code", "coder")] });
	const controller = new AbortController();
	const started = Promise.withResolvers<void>();
	const pending = Promise.withResolvers<void>();
	let executorCancelled = false;
	let lateResultAccepted: boolean | undefined;
	const running = driveGraphRun(
		store,
		id,
		1,
		async (attempt, signal) => {
			started.resolve();
			try {
				await untilAborted(signal, pending.promise);
			} finally {
				executorCancelled = signal.aborted;
				lateResultAccepted = store.complete(attempt, "late result");
			}
			return "unused";
		},
		controller.signal,
	);
	await Promise.race([started.promise, running]);
	controller.abort();
	await running;
	expect(executorCancelled).toBe(true);
	expect(lateResultAccepted).toBe(false);
	expect(store.currentArtifacts(id).size).toBe(0);
	expect(store.events(id, 2).map(event => event.kind)).toEqual(["cancelled"]);
});

test("a failed node blocks its dependents while an independent node can still finish", async () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({
		version: 1,
		nodes: [node("code", "coder"), node("test", "tester", ["code"]), node("context", "context")],
	});
	const dispatched: string[] = [];
	await driveGraphRun(store, id, 2, async attempt => {
		dispatched.push(attempt.nodeId);
		if (attempt.nodeId === "code") throw new Error("fixture failure");
		return "independent result";
	});
	expect(dispatched).toEqual(["code", "context"]);
	expect(store.get(id)?.nodes.code).toMatchObject({ status: "failed", error: "fixture failure" });
	expect([...store.currentArtifacts(id).keys()]).toEqual(["context"]);
});

test("an oversized artifact fails the attempt and is never passed to a dependent", async () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({ version: 1, nodes: [node("code", "coder"), node("test", "tester", ["code"])] });
	const dispatched: string[] = [];
	await driveGraphRun(store, id, 1, async attempt => {
		dispatched.push(attempt.nodeId);
		return "é".repeat(600_000);
	});
	expect(dispatched).toEqual(["code"]);
	expect(store.get(id)?.nodes.code).toMatchObject({ status: "failed", error: "Graph artifact exceeds 1 MiB" });
	expect(store.currentArtifacts(id).size).toBe(0);
});

function taskRun(store: GraphRunStore, tasks: { id: string; files: string[]; dependsOn?: string[] }[]): string {
	const approved = tasks.map(task => ({ title: task.id, brief: task.id, dependsOn: [], ...task }));
	// The plan is not re-validated here: the store must enforce disjoint scopes on its own at dispatch.
	const context = {
		sourceRoot: "C:\\repo",
		baseSha: "0".repeat(40),
		objective: "fixture",
		files: [],
		profileHash: "",
	};
	const { id } = store.create(graphPlanForTasks({ version: 1, tasks: approved }), { ...context, tasks: approved });
	// These cases begin after the read-only context node so they can exercise concurrent dispatch directly.
	const [contextAttempt] = store.claimReady(id, 1);
	store.complete(contextAttempt, "context fixture");
	return id;
}

test("dispatch admits disjoint Coders together and holds back a scope that collides on Windows", () => {
	using store = new GraphRunStore(":memory:");
	const id = taskRun(store, [
		{ id: "api", files: ["src/api.txt"] },
		{ id: "ui", files: ["web/ui.txt"] },
		{ id: "case", files: ["SRC/Api.txt"] },
		{ id: "dir", files: ["web"] },
	]);
	const first = store.claimReady(id, 4);
	expect(first.map(attempt => attempt.nodeId)).toEqual(["code-api", "code-ui"]);
	store.complete(first[0], "api change");
	expect(store.claimReady(id, 4).map(attempt => attempt.nodeId)).toEqual(["code-case"]);
	store.complete(first[1], "ui change");
	expect(store.claimReady(id, 4).map(attempt => attempt.nodeId)).toEqual(["code-dir"]);
});

test("independent Coders overlap, a failing sibling does not stop the other and blocks the joined test", async () => {
	using store = new GraphRunStore(":memory:");
	const id = taskRun(store, [
		{ id: "back", files: ["src/back.txt"] },
		{ id: "front", files: ["src/front.txt"] },
	]);
	const bothRunning = Promise.withResolvers<void>();
	let inFlight = 0;
	const dispatched: string[] = [];
	await driveGraphRun(store, id, 2, async ({ nodeId }) => {
		dispatched.push(nodeId);
		if (++inFlight === 2) bothRunning.resolve();
		// Serialized dispatch never reaches the second Coder, so this barrier hangs and the test times out.
		await bothRunning.promise;
		if (nodeId === "code-back") throw new Error("backend failed");
		return "frontend change";
	});
	expect(dispatched).toEqual(["code-back", "code-front"]);
	const nodes = store.get(id)!.nodes;
	expect([nodes["code-back"].status, nodes["code-front"].status, nodes.test.status]).toEqual([
		"failed",
		"succeeded",
		"queued",
	]);
});

test("cancelling two running Coders stops both, and a restart marks both interrupted", async () => {
	await using temp = await TempDir.create("@kostomp-graph-parallel-db-");
	const db = temp.join("graph.sqlite");
	const tasks = [
		{ id: "back", files: ["src/back.txt"] },
		{ id: "front", files: ["src/front.txt"] },
	];
	{
		using store = new GraphRunStore(db);
		const id = taskRun(store, tasks);
		const controller = new AbortController();
		const started: string[] = [];
		const aborted: string[] = [];
		const bothStarted = Promise.withResolvers<void>();
		const running = driveGraphRun(
			store,
			id,
			2,
			async ({ nodeId }, signal) => {
				started.push(nodeId);
				if (started.length === 2) bothStarted.resolve();
				try {
					await untilAborted(signal, Promise.withResolvers<void>().promise);
				} finally {
					if (signal.aborted) aborted.push(nodeId);
				}
				return "unused";
			},
			controller.signal,
		);
		await Promise.race([bothStarted.promise, running]);
		controller.abort();
		await running;
		expect(aborted.sort()).toEqual(["code-back", "code-front"]);
		expect(store.get(id)!.nodes["code-front"].status).toBe("cancelled");
	}
	const crashed = (() => {
		using store = new GraphRunStore(db);
		const id = taskRun(store, tasks);
		expect(store.claimReady(id, 2)).toHaveLength(2);
		return id;
	})();
	using reopened = new GraphRunStore(db);
	reopened.recoverInterrupted(crashed);
	const nodes = reopened.get(crashed)!.nodes;
	expect([nodes["code-back"].status, nodes["code-front"].status]).toEqual(["interrupted", "interrupted"]);
});

test("a log from an interrupted attempt is rejected and never shown for the node", () => {
	using store = new GraphRunStore(":memory:");
	const { id } = store.create({ version: 1, nodes: [node("test", "tester")] });
	const [stale] = store.claimReady(id, 1);
	store.recoverInterrupted(id);
	expect(store.recordLog(stale, "late output")).toBe(false);
	expect(store.retry(id, "test")).toBe(true);
	const [current] = store.claimReady(id, 1);
	expect(store.recordLog(current, "current output")).toBe(true);
	const run = store.get(id)!;
	expect(store.log(run, "test")).toBe("current output");
	expect(store.loggedNodes(run)).toEqual(["test"]);
});

test("deleting a run removes all its data permanently and leaves other runs, drafts and planning untouched", async () => {
	await using temp = await TempDir.create("@kostomp-graph-delete-db-");
	const db = temp.join("graph.sqlite");
	const plan = { version: 1, nodes: [node("test", "tester")] };
	const draft: GraphDraft = {
		id: "draft", hash: "hash", plannerLog: "plan",
		input: { objective: "Keep this proposal", source: temp.join("source") },
		baseSha: "0".repeat(40), profileHash: "profile",
		plan: { version: 1, tasks: [{ id: "task", title: "Task", brief: "Change a file", files: ["file.txt"], dependsOn: [] }] },
	};
	const planning = { id: "planning", log: "planning" };
	let doomed: string;
	let kept: string;
	{
		using store = new GraphRunStore(db);
		const seed = (id: string) => {
			const [attempt] = store.claimReady(id, 1);
			expect(store.recordLog(attempt, `log ${id}`)).toBe(true);
			store.recordTestObservation(attempt, {
				status: "unavailable", reason: "missing_credentials", questionVersion: 1, model: "fixture", elapsedMs: 0,
			});
			expect(store.complete(attempt, `artifact ${id}`)).toBe(true);
			return attempt;
		};
		doomed = store.create(plan).id;
		kept = store.create(plan).id;
		const doomedAttempt = seed(doomed);
		seed(kept);
		store.saveDraft(draft);
		store.recordPlanning(planning);
		const artifactId = new Bun.CryptoHasher("sha256").update(`artifact ${doomed}`).digest("hex");
		expect(store.artifact(doomed, artifactId)).not.toBeNull();

		store.delete(doomed);
		expect(store.get(doomed)).toBeNull();
		expect(store.recent().map(run => run.id)).toEqual([kept]);
		expect(store.events(doomed, 0)).toEqual([]);
		expect(store.artifact(doomed, artifactId)).toBeNull();
		expect(() => store.cancel(doomed)).toThrow(/Unknown Graph run/);
		expect(() => store.claimReady(doomed, 1)).toThrow(/Unknown Graph run/);
		expect(() => store.delete(doomed)).toThrow(/Unknown Graph run/);
		// Late writes cannot recreate the deleted run's rows.
		expect(store.recordLog(doomedAttempt, "late")).toBe(false);
		expect(() => store.complete(doomedAttempt, "late")).toThrow(/Unknown Graph run/);
	}
	using reopened = new GraphRunStore(db);
	expect(reopened.get(doomed)).toBeNull();
	expect(reopened.recent().map(run => run.id)).toEqual([kept]);
	expect(reopened.events(doomed, 0)).toEqual([]);
	const keptRun = reopened.get(kept)!;
	expect(reopened.log(keptRun, "test")).toBe(`log ${kept}`);
	expect(reopened.events(kept, 0).map(event => event.kind)).toEqual(["created", "claimed", "succeeded"]);
	expect(reopened.testObservation(keptRun)).toMatchObject({ status: "unavailable", reason: "missing_credentials" });
	expect(reopened.draft()).toEqual(draft);
	expect(reopened.latestPlanning()).toEqual(planning);
});
