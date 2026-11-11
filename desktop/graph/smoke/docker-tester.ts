import { rejects, strictEqual } from "node:assert";
import { $which, ptree, TempDir, windowsPathToWslMount } from "@oh-my-pi/pi-utils";
import { type DockerTestProfile, testCandidateInDocker } from "../docker-tester";
import { author, changeSet, fixture, original } from "../fixtures/git";
import { GraphWorkspace } from "../workspace";
import probe from "./isolation-probe.sh" with { type: "text" };

const dockerPath = await $which("docker");
const imageId = Bun.argv[2];
if (!dockerPath || !imageId) throw new Error("Provide a preloaded Linux Docker image ID with sh, tar and xargs");

await using temp = await TempDir.create("@kostomp-graph-docker-smoke-");
const source = await fixture(temp.join("source"));
const edited = await fixture(temp.join("edited"));
const anotherRun = temp.join("another-run", "sentinel.txt");
const sourceFile = temp.join("source", "src", "backend.txt");
await Bun.write(anotherRun, "another run sentinel\n");

await using workspace = await GraphWorkspace.pin(source.info().repoRoot);
const patch = await changeSet(edited, "code", { "src/backend.txt": "isolated candidate\n" });
const executable = "#!/bin/sh\nprintf 'fixture executed\\n'\n";
const executableBlob = new Bun.CryptoHasher("sha1")
	.update(`blob ${Buffer.byteLength(executable)}\0`)
	.update(executable)
	.digest("hex");
const executablePatch =
	"diff --git a/executable.sh b/executable.sh\nnew file mode 100755\n--- /dev/null\n+++ b/executable.sh\n@@ -0,0 +1,2 @@\n+#!/bin/sh\n+printf 'fixture executed\\n'\n";
const candidate = await workspace.compose(new Map([["code", ["src/backend.txt", "executable.sh"]]]), [
	{
		...patch,
		patch: patch.patch + executablePatch,
		changes: [...patch.changes, { path: "executable.sh", baseBlob: null, newBlob: executableBlob }],
	},
]);
const hostPaths = [sourceFile, anotherRun].flatMap(file => {
	const wsl = windowsPathToWslMount(file);
	if (!wsl) throw new Error("Probe requires disposable fixtures on a local drive");
	const suffix = wsl.slice("/mnt".length);
	return [wsl, `/run/desktop/mnt/host${suffix}`, `/host_mnt${suffix}`];
});
const profile = { dockerPath, imageId, timeoutMs: 30_000 };
const result = await testCandidateInDocker(workspace, candidate, {
	...profile,
	command: ["/bin/sh", "-c", probe, "isolation-probe", ...hostPaths],
});
strictEqual(result.treeId, candidate.treeId);
strictEqual(result.exitCode, 0, result.stderr || result.stdout);
strictEqual(result.stdout.trim(), "Graph Tester isolation verified");
strictEqual(await Bun.file(sourceFile).text(), original["src/backend.txt"]);
strictEqual(await Bun.file(anotherRun).text(), "another run sentinel\n");
strictEqual(await source.isDirty(), false);
const review = { treeId: candidate.treeId, verdict: "accepted" as const };
strictEqual((await workspace.release(candidate, { test: result, review })).status, "ready_to_export");

const failing: DockerTestProfile = { ...profile, command: ["/bin/sh", "-c", "exit 23"] };
const failed = await testCandidateInDocker(workspace, candidate, failing);
strictEqual(failed.exitCode, 23);
strictEqual((await workspace.release(candidate, { test: failed, review })).status, "needs_input");

const controller = new AbortController();
const waitSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
const marker = crypto.randomUUID();
const docker = (args: string[], signal: AbortSignal) => ptree.spawn([dockerPath, ...args], { signal });
const running = testCandidateInDocker(
	workspace,
	candidate,
	{
		...profile,
		command: ["/bin/sh", "-c", "exec sleep 60", marker],
	},
	controller.signal,
);
async function findRunningProbe(): Promise<string> {
	for (;;) {
		waitSignal.throwIfAborted();
		const listed = await docker(
			["container", "ls", "--no-trunc", "-q", "--filter", "name=kostomp-graph-"],
			waitSignal,
		).text();
		for (const id of listed.trim().split(/\s+/).filter(Boolean)) {
			const inspected = await docker(
				["container", "inspect", "--format", "{{json .Config.Cmd}}", id],
				waitSignal,
			).wait({ allowNonZero: true });
			if (inspected.ok && (JSON.parse(inspected.stdout) as string[]).includes(marker)) return id;
		}
		await Bun.sleep(100);
	}
}
try {
	const id = await Promise.race([
		findRunningProbe(),
		running.then(() => {
			throw new Error("Cancellation probe exited before it was cancelled");
		}),
	]);
	controller.abort();
	await rejects(running);
	const inspected = await docker(["container", "inspect", id], AbortSignal.timeout(3000)).wait({ allowNonZero: true });
	strictEqual(inspected.ok, false);
	strictEqual(inspected.stderr.includes("No such object") || inspected.stderr.includes("No such container"), true);
} finally {
	controller.abort();
	await running.catch(() => {});
}
// Exceeds both the old 256 MiB snapshot cap and the old 384 MiB /work tmpfs.
{
	const largeSource = await fixture(temp.join("large-source"));
	const files = Array.from({ length: 5 }, (_, index) => `assets/part-${index}.bin`);
	const asset = new Uint8Array(80 * 1024 * 1024).fill(0x61);
	const hash = new Bun.CryptoHasher("sha256").update(asset).digest("hex");
	for (const file of files) await Bun.write(temp.join("large-source", file), asset);
	await Bun.write(
		temp.join("large-source", "assets", "SHA256SUMS"),
		files.map(file => `${hash}  ${file}\n`).join(""),
	);
	await largeSource.stageFiles([...files, "assets/SHA256SUMS"]);
	await largeSource.commitCreate("Large game assets", { author });
	await using largeWorkspace = await GraphWorkspace.pin(largeSource.info().repoRoot);
	const scopes = new Map([["code", ["src/backend.txt"]]]);
	const changes = await largeWorkspace.captureChangeSet("code", ["src/backend.txt"], patch.patch);
	const largeCandidate = await largeWorkspace.compose(scopes, [changes]);
	const largeResult = await testCandidateInDocker(largeWorkspace, largeCandidate, {
		...profile,
		timeoutMs: 120_000,
		command: ["/bin/sh", "-c", "sha256sum --check assets/SHA256SUMS"],
	});
	strictEqual(largeResult.treeId, largeCandidate.treeId);
	strictEqual(largeResult.exitCode, 0, largeResult.stderr || largeResult.stdout);
	strictEqual(largeResult.stdout.trim(), files.map(file => `${file}: OK`).join("\n"));
	strictEqual(await largeSource.isDirty(), false);
}
process.stdout.write("Graph Tester isolation, release evidence, cancellation and 400 MiB snapshot passed\n");
