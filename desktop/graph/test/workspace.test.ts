import { expect, test } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { author, changeSet, fixture, original } from "../fixtures/git";
import { graphBaseIsCurrent, GraphObjectCache, GraphWorkspace } from "../workspace";

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
	const archive = await workspace.testSnapshot(candidate);
	const snapshot = await new Bun.Archive(await archive.bytes()).files();
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

test("workspaces pinned with a shared object cache each read their own base", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	await using objectCache = new GraphObjectCache();
	const source = await fixture(temp.join("source"));
	const root = source.info().repoRoot;
	const decoder = new TextDecoder();
	const first = await GraphWorkspace.pin(root, { objectCache });
	const baseSha = first.baseSha;
	await first[Symbol.asyncDispose]();
	{
		await using second = await GraphWorkspace.pin(root, { objectCache });
		expect(second.baseSha).toBe(baseSha);
		expect(decoder.decode((await second.readBaseFile("src/backend.txt")).data)).toBe(original["src/backend.txt"]);
		expect(second.files().sort()).toEqual(["src/backend.txt", "src/frontend.txt"]);
	}
	await Bun.write(path.join(root, "src/backend.txt"), "advanced backend\n");
	await source.stageFiles(["src/backend.txt"]);
	await source.commitCreate("Advance backend", { author });
	await using third = await GraphWorkspace.pin(root, { objectCache });
	expect(third.baseSha).not.toBe(baseSha);
	expect(decoder.decode((await third.readBaseFile("src/backend.txt")).data)).toBe("advanced backend\n");
});

test("a candidate's test archive keeps its content across calls and after an aborted build", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	const edited = await fixture(temp.join("edited"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const set = await changeSet(edited, "code", { "src/backend.txt": "new backend\n" });
	const candidate = await workspace.compose(new Map([["code", ["src/backend.txt"]]]), [set]);
	await expect(workspace.testSnapshot(candidate, AbortSignal.abort())).rejects.toThrow();
	const first = await (await workspace.testSnapshot(candidate)).bytes();
	const second = await (await workspace.testSnapshot(candidate)).bytes();
	expect(second).toEqual(first);
	const snapshot = await new Bun.Archive(second).files();
	expect(await snapshot.get("project/src/backend.txt")?.text()).toBe("new backend\n");
	expect(await snapshot.get("project/src/frontend.txt")?.text()).toBe(original["src/frontend.txt"]);
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
		"Graph patch must change only approved files; remove the changes to src/frontend.txt. Approved files: src/backend.txt",
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

test("allowDirty pins the committed HEAD without the local edits and keeps the base current", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	const root = source.info().repoRoot;
	await Bun.write(path.join(root, "local.txt"), "local only");
	await using workspace = await GraphWorkspace.pin(root, { allowDirty: true });
	expect(workspace.list("")).toEqual(["src/"]);
	expect(await graphBaseIsCurrent(root, workspace.baseSha)).toBe(false);
	expect(await graphBaseIsCurrent(root, workspace.baseSha, { allowDirty: true })).toBe(true);
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

test("a source whose committed tree holds a Git symlink is refused at pin, before any model work", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const repo = await fixture(temp.join("source"));
	await repo.applyPatch("diff --git a/src/backend.txt b/src/backend.txt\nold mode 100644\nnew mode 120000\n", {
		cached: true,
	});
	await repo.commitCreate("Turn backend into a symlink", { author });
	await expect(GraphWorkspace.pin(repo.info().repoRoot, { allowDirty: true })).rejects.toThrow(
		"Graph Tester requires regular tracked files and rejects symlinks and submodules",
	);
});

test("a source that borrows objects from another repository is refused at pin", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const lender = await fixture(temp.join("lender"));
	const source = await fixture(temp.join("source"));
	await Bun.write(
		path.join(source.info().commonDir, "objects", "info", "alternates"),
		`${path.join(lender.info().commonDir, "objects")}\n`,
	);
	await expect(GraphWorkspace.pin(source.info().repoRoot)).rejects.toThrow(
		"Graph does not support repositories that borrow objects from another repository (git clone --shared/--reference)",
	);
});

test("a scope that owns a base directory, or a path beneath a base file, is refused before any Coder runs", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	expect(() => workspace.checkScopes(new Map([["code", ["src"]]]))).toThrow(
		"Graph path src is a directory in the base snapshot",
	);
	expect(() => workspace.checkScopes(new Map([["code", ["src/backend.txt/inner.txt"]]]))).toThrow(
		"Graph path src/backend.txt/inner.txt lies under src/backend.txt, which is a file in the base snapshot",
	);
	expect(() => workspace.checkScopes(new Map([["code", ["src/new.txt"]]]))).not.toThrow();
});

test("a patch that changes an existing file's mode is rejected at capture, but a new executable file is accepted", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const files = ["src/backend.txt"];
	const header = "diff --git a/src/backend.txt b/src/backend.txt\nold mode 100644\nnew mode 100755\n";
	const hunk = "--- a/src/backend.txt\n+++ b/src/backend.txt\n@@ -1 +1 @@\n-initial backend\n+new backend\n";
	for (const patch of [header, header + hunk]) {
		await expect(workspace.captureChangeSet("code", files, patch)).rejects.toThrow(
			"Graph does not support file mode changes; submit content changes only",
		);
	}
	const script =
		"diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+echo\n";
	const captured = await workspace.captureChangeSet("code", ["run.sh"], script);
	expect(captured.changes).toEqual([{ path: "run.sh", baseBlob: null, newBlob: expect.any(String) }]);
});

test("capture names the reason a patch is rejected so the Coder can fix it", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"));
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const files = ["src/backend.txt", "src/moved.txt"];
	await expect(workspace.captureChangeSet("code", files, " \n")).rejects.toThrow(/^Graph patch is empty;/);
	await expect(workspace.captureChangeSet("code", files, "x".repeat(1024 * 1024 + 1))).rejects.toThrow(
		"Graph patch is 1048577 bytes, over the 1 MiB limit",
	);
	const rename =
		"diff --git a/src/backend.txt b/src/moved.txt\nsimilarity index 100%\nrename from src/backend.txt\nrename to src/moved.txt\n";
	await expect(workspace.captureChangeSet("code", files, rename)).rejects.toThrow(
		"Graph does not support rename/copy changes (diff --git a/src/backend.txt b/src/moved.txt)",
	);
	const symlink =
		"diff --git a/src/moved.txt b/src/moved.txt\nnew file mode 120000\n--- /dev/null\n+++ b/src/moved.txt\n@@ -0,0 +1 @@\n+backend.txt\n";
	await expect(workspace.captureChangeSet("code", files, symlink)).rejects.toThrow(
		"Graph does not support symlink changes (diff --git a/src/moved.txt b/src/moved.txt)",
	);
	expect(await source.isDirty()).toBe(false);
});

test("a submitted patch whose blank context line lost its leading space still applies", async () => {
	await using temp = await TempDir.create("@kostomp-graph-workspace-test-");
	const source = await fixture(temp.join("source"), { "notes.txt": "one\n\nthree\n" });
	await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
	const patch =
		"diff --git a/notes.txt b/notes.txt\n--- a/notes.txt\n+++ b/notes.txt\n@@ -1,3 +1,3 @@\n one\n\n-three\n+3\n";
	const captured = await workspace.captureChangeSet("code", ["notes.txt"], patch);
	expect(captured.patch).toContain("-three\n+3\n");
	const candidate = await workspace.compose(new Map([["code", ["notes.txt"]]]), [captured]);
	const file = await workspace.readCandidateFile(candidate, "notes.txt");
	expect(new TextDecoder().decode(file.data)).toBe("one\n\n3\n");
	expect(workspace.candidatePatch(candidate)).toContain("+3\n");
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
