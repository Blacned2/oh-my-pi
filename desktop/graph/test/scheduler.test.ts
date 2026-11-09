import { expect, test } from "bun:test";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { type GraphNode, parseGraphPlan } from "../plan";
import { GraphRunStore } from "../run-store";
import { driveGraphRun } from "../scheduler";

function node(id: string, role: GraphNode["role"], dependsOn: string[] = [], maxAttempts = 2): GraphNode {
	return { id, role, dependsOn, maxAttempts };
}

test("rejects a graph with a cyclic dependency before any node can be scheduled", () => {
	expect(() =>
		parseGraphPlan({ version: 1, nodes: [node("code", "coder", ["test"]), node("test", "tester", ["code"])] }),
	).toThrow(/cycle/);
});

test("join waits for both artifacts and independent coders are serialized", () => {
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
