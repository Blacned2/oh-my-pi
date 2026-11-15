import { type } from "@oh-my-pi/omptype";
import { isFullyQualifiedPath, ptree, TempDir } from "@oh-my-pi/pi-utils";
import { abortableSource } from "@oh-my-pi/pi-utils/abortable";
import { systemProcessEnv } from "./process-env";
import bootstrap from "./tester-bootstrap.sh" with { type: "text" };
import type { GraphCandidate, GraphWorkspace } from "./workspace";

const localEngine = "npipe:////./pipe/dockerDesktopLinuxEngine";
const imageId = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
const outputHead = 16 * 1024;
const outputTail = 48 * 1024;
const cleanupTimeout = 10_000;
const containerLabel = "dev.kostomp.graph=1";
/** `tester-bootstrap.sh` exits with this code, after a `graph-bootstrap:` stderr line, when the environment failed. */
const bootstrapFailure = 111;

const imageConfigSchema = type({ "Volumes?": "object | null" });
const containerStateSchema = type({
	Status: "string",
	ExitCode: "number.integer",
	Error: "string",
	OOMKilled: "boolean",
});

/** Host-approved settings. Graph plans select a profile ID outside this adapter. */
export interface DockerTestProfile {
	dockerPath: string;
	imageId: string;
	command: readonly [executable: string, ...args: string[]];
	timeoutMs: number;
}

export interface GraphTestResult {
	treeId: string;
	exitCode: number;
	elapsedMs: number;
	stdout: string;
	stderr: string;
}

/** Length of `bytes[0, length)` without an incomplete trailing UTF-8 sequence. */
function completeUtf8Length(bytes: Uint8Array, length: number): number {
	let lead = length - 1;
	while (lead >= 0 && length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
	if (lead < 0) return length;
	const byte = bytes[lead];
	const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
	return lead + size > length ? lead : length;
}

/**
 * Keep the first 16 KiB and the last 48 KiB of `stream`: test runners print their summary last.
 * Reading stops when `signal` aborts, keeping what was read so far.
 */
export async function captureOutput(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<string> {
	const head = new Uint8Array(outputHead);
	let headLength = 0;
	const tail: Uint8Array[] = [];
	let tailLength = 0;
	let total = 0;
	try {
		for await (const chunk of abortableSource(stream, signal)) {
			total += chunk.byteLength;
			const count = Math.min(outputHead - headLength, chunk.byteLength);
			head.set(chunk.subarray(0, count), headLength);
			headLength += count;
			if (count === chunk.byteLength) continue;
			tail.push(chunk.subarray(count));
			tailLength += chunk.byteLength - count;
			while (tailLength - tail[0].byteLength >= outputTail) tailLength -= tail.shift()!.byteLength;
		}
	} catch (error) {
		if (!signal?.aborted) throw error;
	}
	const joined = Buffer.concat(tail);
	const end = joined.subarray(Math.max(0, joined.byteLength - outputTail));
	const decoder = new TextDecoder();
	if (total === headLength + end.byteLength) return decoder.decode(Buffer.concat([head.subarray(0, headLength), end]));
	const headEnd = completeUtf8Length(head, headLength);
	let tailStart = 0;
	while (tailStart < 3 && tailStart < end.byteLength && (end[tailStart] & 0xc0) === 0x80) tailStart++;
	const omitted = total - headEnd - (end.byteLength - tailStart);
	return `${decoder.decode(head.subarray(0, headEnd))}\n[… ${omitted} bytes omitted …]\n${decoder.decode(end.subarray(tailStart))}`;
}

/** Throws an `Error` naming the first invalid field. */
export function validateDockerProfile(profile: DockerTestProfile): void {
	const { dockerPath, command, timeoutMs } = profile;
	if (typeof dockerPath !== "string" || !isFullyQualifiedPath(dockerPath))
		throw new Error("Graph Tester dockerPath must be a fully qualified path");
	if (typeof profile.imageId !== "string" || !imageId.test(profile.imageId))
		throw new Error("Graph Tester imageId must be sha256:<64 lowercase hex digits>");
	if (!Array.isArray(command) || typeof command[0] !== "string" || !command[0].startsWith("/"))
		throw new Error("Graph Tester command[0] must be an absolute container path");
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("Graph Tester timeoutMs must be an integer from 1 to 300000");
}

/** Execute one candidate in the local Linux Docker Desktop engine without exposing host paths. */
export async function testCandidateInDocker(
	workspace: GraphWorkspace,
	candidate: GraphCandidate,
	profile: DockerTestProfile,
	signal?: AbortSignal,
): Promise<GraphTestResult> {
	if (process.platform !== "win32") throw new Error("Graph Tester requires the local Windows Docker Desktop engine");
	validateDockerProfile(profile);
	const { dockerPath, timeoutMs } = profile;
	const image = profile.imageId;
	const command = [...profile.command];
	const bounded = (ms: number) =>
		signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
	// Preparation gets its own bound; the test deadline starts with the container.
	const prepareSignal = bounded(timeoutMs);
	prepareSignal.throwIfAborted();
	const started = performance.now();
	await using run = await TempDir.create("@kostomp-graph-tester-");
	const prefix = [dockerPath, "--host", localEngine, "--config", run.path()];
	const env = { ...systemProcessEnv(), TEMP: run.path(), TMP: run.path() };
	const docker = <Input extends "pipe" | "ignore">(args: string[], abort: AbortSignal, stdin: Input) => {
		abort.throwIfAborted();
		return ptree.spawn([...prefix, ...args], { cwd: run.path(), env, signal: abort, stdin });
	};
	const operatingSystem = await docker(["info", "--format", "{{.OSType}}"], prepareSignal, "ignore").text();
	if (operatingSystem.trim() !== "linux") throw new Error("Graph Tester requires the Linux Docker Desktop engine");
	const inspectImage = await docker(
		["image", "inspect", "--format", "{{json .Config}}", image],
		prepareSignal,
		"ignore",
	).text();
	const imageConfig = imageConfigSchema.assert(JSON.parse(inspectImage));
	if (imageConfig.Volumes && Object.keys(imageConfig.Volumes).length !== 0)
		throw new Error("Graph test image declares volumes");
	const archive = await workspace.testSnapshot(candidate, prepareSignal);
	// /work's tmpfs pages count against the container memory limit.
	const snapshotMiB = Math.ceil(archive.size / (1024 * 1024));
	const workspaceMiB = Math.max(384, snapshotMiB + Math.max(128, Math.ceil(snapshotMiB / 2)));
	const memoryMiB = workspaceMiB + 384;
	// The sidecar runs one test at a time, so every labelled container is a leftover of a killed sidecar.
	try {
		const leftoverSignal = bounded(cleanupTimeout);
		const listed = await docker(
			["container", "ls", "--all", "--quiet", "--filter", `label=${containerLabel}`],
			leftoverSignal,
			"ignore",
		).text();
		const leftovers = listed.split(/\s+/).filter(entry => /^[a-f0-9]+$/.test(entry));
		if (leftovers.length > 0) {
			await docker(["container", "rm", "--force", "--volumes", ...leftovers], leftoverSignal, "ignore").wait({
				allowNonZero: true,
			});
		}
	} catch {
		// Best effort: a leftover costs only resources and never shares state with this run.
	}
	const name = `kostomp-graph-${crypto.randomUUID()}`;
	let id: string | undefined;
	const removeContainer = async () => {
		const cleanup = await docker(
			["container", "rm", "--force", "--volumes", id ?? name],
			AbortSignal.timeout(cleanupTimeout),
			"ignore",
		).wait({ allowNonZero: true });
		if (!cleanup.ok && !cleanup.stderr.includes("No such container")) {
			throw new Error(`Graph test container cleanup failed for ${name}`);
		}
	};
	/** `note` becomes the final stderr line. */
	const result = (exitCode: number, stdout: string, stderr: string, note?: string): GraphTestResult => ({
		treeId: candidate.treeId,
		exitCode,
		elapsedMs: performance.now() - started,
		stdout,
		stderr: note ? `${stderr}${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}` : stderr,
	});
	try {
		const created = await docker(
			[
				"container",
				"create",
				"--name",
				name,
				`--label=${containerLabel}`,
				"--pull=never",
				"--interactive",
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges=true",
				"--user=65532:65532",
				"--no-healthcheck",
				"--log-driver=none",
				`--memory=${memoryMiB}m`,
				`--memory-swap=${memoryMiB}m`,
				"--cpus=1",
				"--pids-limit=128",
				"--env=HOME=/tmp",
				// UID 65532 has no passwd entry, so user-name lookups need these.
				"--env=USER=graph",
				"--env=LOGNAME=graph",
				`--tmpfs=/work:rw,exec,nosuid,nodev,size=${workspaceMiB}m,uid=65532,gid=65532,mode=0700`,
				"--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
				"--entrypoint=/bin/sh",
				image,
				"-c",
				bootstrap,
				"graph-test",
				...command,
			],
			prepareSignal,
			"ignore",
		).text();
		if (!containerId.test(created.trim())) throw new Error("Graph Tester received an invalid container ID");
		id = created.trim();
		const deadline = AbortSignal.timeout(timeoutMs);
		const testSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
		using child = docker(["container", "start", "--attach", "--interactive", id], testSignal, "pipe");
		const feedArchive = async () => {
			for await (const chunk of abortableSource(archive.stream(), testSignal)) {
				try {
					await child.stdin.write(chunk);
					await child.stdin.flush();
				} catch {
					// The container closed its input (it exited early); its own exit state decides the result.
					return;
				}
			}
			try {
				await child.stdin.end();
			} catch {}
		};
		const [stdout, exit] = await Promise.all([
			captureOutput(child.stdout, testSignal),
			child.exited.catch((error: unknown) => {
				if (!testSignal.aborted) throw error;
				return undefined;
			}),
			feedArchive().catch((error: unknown) => {
				if (!testSignal.aborted) throw error;
			}),
		]);
		signal?.throwIfAborted();
		const stderr = child.peekStderr();
		if (exit === undefined) return result(124, stdout, stderr, `Graph test timed out after ${timeoutMs} ms`);
		const inspectState = await docker(
			["container", "inspect", "--format", "{{json .State}}", id],
			bounded(cleanupTimeout),
			"ignore",
		).text();
		const state = containerStateSchema.assert(JSON.parse(inspectState));
		if (state.OOMKilled) {
			return result(137, stdout, stderr, `Graph test container ran out of memory (${memoryMiB} MiB)`);
		}
		if (state.Status !== "exited" || state.Error || (state.ExitCode === 0 && exit !== 0)) {
			const error = state.Error ? `, error ${JSON.stringify(state.Error)}` : "";
			throw new Error(
				`Graph test container did not finish normally (status ${state.Status}, exit code ${state.ExitCode}${error})`,
			);
		}
		if (state.ExitCode === bootstrapFailure && stderr.includes("graph-bootstrap: ")) {
			throw new Error(`Graph test environment failed before the test ran: ${stderr.slice(-2000).trim()}`);
		}
		return result(state.ExitCode, stdout, stderr);
	} finally {
		await removeContainer();
	}
}
