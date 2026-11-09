import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { author, changeSet, fixture, original } from "../fixtures/git";
import { buildTestSnapshot } from "../test-snapshot";
import { GraphWorkspace } from "../workspace";

test("combines two disjoint changes privately and releases only with matching evidence on a clean source", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	const backend = await fixture(temp.join("backend"));
	const frontend = await fixture(temp.join("frontend"));
	const sourceRoot = source.info().repoRoot;
	const index = Bun.file(path.join(source.info().gitDir, "index"));
	const before = await index.bytes();
	await using workspace = await GraphWorkspace.pin(sourceRoot);
	const sets = await Promise.all([
		changeSet(backend, "backend", { "src/backend.txt": "new backend\n" }),
		changeSet(frontend, "frontend", { "src/frontend.txt": "new frontend\n" }),
	]);
	const scopes = new Map(sets.map(set => [set.nodeId, set.changes.map(change => change.path)]));
	const candidate = await workspace.compose(scopes, sets);
	const snapshot = await (await workspace.testSnapshot(candidate)).files();
	expect(await snapshot.get("project/src/backend.txt")?.text()).toBe("new backend\n");
	expect(await snapshot.get("project/src/frontend.txt")?.text()).toBe("new frontend\n");
	expect([...snapshot.keys()].sort()).toEqual([
		"graph-executables",
		"project/src/backend.txt",
		"project/src/frontend.txt",
	]);
	const candidateFile = await workspace.readCandidateFile(candidate, "src/backend.txt");
	expect(candidateFile.blobId).toBe(sets[0].changes[0].newBlob!);
	expect(new TextDecoder().decode(candidateFile.data)).toBe("new backend\n");
	await expect(workspace.readCandidateFile(candidate, "../source/src/backend.txt")).rejects.toThrow(/portable/);
	const testEvidence = { treeId: candidate.treeId, exitCode: 0 };
	const review = { treeId: candidate.treeId, verdict: "accepted" as const };
	expect(await workspace.release(candidate, { test: testEvidence })).toEqual({ status: "needs_input" });
	expect(await workspace.release(candidate, { test: { ...testEvidence, treeId: candidate.baseSha }, review })).toEqual(
		{ status: "needs_input" },
	);
	const release = await workspace.release(candidate, { test: testEvidence, review });
	expect(release.status).toBe("ready_to_export");
	if (release.status !== "ready_to_export") throw new Error("Expected a releasable candidate");
	expect(release.artifact.patch).toContain("+new backend");
	expect(release.artifact.patch).toContain("+new frontend");
	expect(await source.headSha()).toBe(candidate.baseSha);
	expect(await source.isDirty()).toBe(false);
	expect(await index.bytes()).toEqual(before);
	await Bun.write(path.join(sourceRoot, "src/backend.txt"), "unsaved user change\n");
	expect(await workspace.release(candidate, { test: testEvidence, review })).toEqual({ status: "stale_base" });
	expect(new TextDecoder().decode((await workspace.readBaseFile("src/backend.txt")).data)).toBe(
		original["src/backend.txt"],
	);
	expect(await Bun.file(path.join(sourceRoot, "src/backend.txt")).text()).toBe("unsaved user change\n");
	await source.stageFiles(["src/backend.txt"]);
	await source.commitCreate("User advances source", { author });
	expect(await source.isDirty()).toBe(false);
	expect(await workspace.release(candidate, { test: testEvidence, review })).toEqual({ status: "stale_base" });
});

test("rejects overlapping ownership, a wrong preimage, and changes hidden outside the declared scope", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	const edited = await fixture(temp.join("edited"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const artifact = await changeSet(edited, "code", {
		"src/backend.txt": "new backend\n",
		"src/frontend.txt": "hidden\n",
	});
	const scope = new Map([["code", ["src/backend.txt"]]]);
	await expect(workspace.compose(new Map([...scope, ["other", ["SRC/frontend.txt"]]]), [])).rejects.toThrow(/collide/);
	await expect(workspace.compose(new Map([...scope, ["other", ["src/backend.txt"]]]), [])).rejects.toThrow(/overlaps/);
	await expect(
		workspace.compose(scope, [{ ...artifact, changes: [{ ...artifact.changes[0], baseBlob: "1".repeat(40) }] }]),
	).rejects.toThrow(/expected base blob/);
	await expect(workspace.compose(scope, [{ ...artifact, changes: artifact.changes.slice(0, 1) }])).rejects.toThrow(
		/undeclared files/,
	);
	await expect(workspace.captureChangeSet("code", ["src/backend.txt"], artifact.patch)).rejects.toThrow(
		/only approved files/,
	);
	expect(await source.isDirty()).toBe(false);
});

test("a dirty source cannot be pinned, even when the changed file is untracked", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	const root = source.info().repoRoot;
	await Bun.write(path.join(root, "local.txt"), "local only");
	await expect(GraphWorkspace.pin(root)).rejects.toThrow(/clean, stable/);
	expect(await Bun.file(path.join(root, "local.txt")).text()).toBe("local only");
});

test("a declared patch cannot introduce a symlink into the candidate", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const patch =
		"diff --git a/alias b/alias\nnew file mode 120000\n--- /dev/null\n+++ b/alias\n@@ -0,0 +1 @@\n+outside\n";
	const changes = [{ path: "alias", baseBlob: null, newBlob: "1".repeat(40) }];
	await expect(
		workspace.compose(new Map([["code", ["alias"]]]), [{ nodeId: "code", changes, patch }]),
	).rejects.toThrow(/symlink/);
	expect(await source.isDirty()).toBe(false);
});

test("a snapshot refuses a pre-existing Git symlink instead of materializing its target as file data", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const repo = await fixture(temp.join("source"));
	const indexPath = temp.join("snapshot.index");
	await repo.readTree("HEAD", indexPath);
	await repo.applyPatch("diff --git a/src/backend.txt b/src/backend.txt\nold mode 100644\nnew mode 120000\n", {
		cached: true,
		indexPath,
	});
	await expect(buildTestSnapshot(repo, indexPath)).rejects.toThrow(/symlinks and submodules/);
});

test("concurrent captures and compositions writing the same objects stay reproducible", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-concurrent-");
	const source = await fixture(temp.join("source"));
	const file = "src/backend.txt";
	const patches = await Promise.all(
		["a", "b"].map(
			async name => (await changeSet(await fixture(temp.join(name)), "code", { [file]: `${name}\n` })).patch,
		),
	);
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const scopes = new Map([["code", [file]]]);
	const trees = await Promise.all(
		Array.from({ length: 8 }, async (_, index) => {
			const changes = await workspace.captureChangeSet("code", [file], patches[index % 2]);
			return (await workspace.compose(scopes, [changes])).treeId;
		}),
	);
	expect(new Set(trees.filter((_, index) => index % 2 === 0)).size).toBe(1);
	expect(new Set(trees.filter((_, index) => index % 2 === 1)).size).toBe(1);
	expect(trees[0]).not.toBe(trees[1]);
	expect(await source.isDirty()).toBe(false);
});
