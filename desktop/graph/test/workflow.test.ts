import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { changeSet, fixture } from "../fixtures/git";
import { GraphRunStore } from "../run-store";
import { type ApprovedGraphExecutors, approvedGraphPlan, readGraphRelease, runApprovedGraph } from "../workflow";
import { GraphWorkspace } from "../workspace";

test("retry rebuilds the saved candidate and a changed test result withdraws the prior release", async () => {
	await using temp = await TempDir.create("@kostomp-graph-retry-");
	const source = await fixture(temp.join("source"));
	const edited = await fixture(temp.join("edited"));
	const file = "src/backend.txt";
	const { patch } = await changeSet(edited, "code", { [file]: "retry fixture\n" });
	const input = { source: source.info().repoRoot, objective: "Change the fixture", files: [file] };
	const db = temp.join("runs.sqlite");
	let exitCode = 0;
	let codeCalls = 0;
	let reviewCalls = 0;
	const executors: ApprovedGraphExecutors = {
		async code() {
			codeCalls++;
			return patch;
		},
		async test(workspace, candidate) {
			const { data } = await workspace.readCandidateFile(candidate, file);
			expect(new TextDecoder().decode(data)).toBe("retry fixture\n");
			return { treeId: candidate.treeId, exitCode, elapsedMs: 1, stdout: "", stderr: "" };
		},
		async review() {
			reviewCalls++;
			return "accepted";
		},
	};
	let id: string;
	{
		using store = new GraphRunStore(db);
		await using workspace = await GraphWorkspace.pin(input.source);
		id = store.create(approvedGraphPlan).id;
		await runApprovedGraph(store, id, workspace, input, executors);
		expect(readGraphRelease(store, id)?.status).toBe("ready_to_export");
	}
	using store = new GraphRunStore(db);
	await using workspace = await GraphWorkspace.pin(input.source);
	expect(store.retry(id, "test")).toBe(true);
	expect(readGraphRelease(store, id)).toBeUndefined();
	exitCode = 23;
	await runApprovedGraph(store, id, workspace, input, executors);
	expect(readGraphRelease(store, id)?.status).toBe("needs_input");
	expect(codeCalls).toBe(1);
	expect(reviewCalls).toBe(1);
	expect(await source.isDirty()).toBe(false);
});
