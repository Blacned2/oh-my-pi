import { type } from "@oh-my-pi/omptype";
import { isFullyQualifiedPath, ptree, TempDir } from "@oh-my-pi/pi-utils";
import { abortableSource } from "@oh-my-pi/pi-utils/abortable";
import { systemProcessEnv } from "./process-env";
import bootstrap from "./tester-bootstrap.sh" with { type: "text" };
import type { GraphCandidate, GraphWorkspace } from "./workspace";

const localEngine = "npipe:////./pipe/dockerDesktopLinuxEngine";
const imageId = /^sha256:[a-f0-9]{64}$/;
const containerId = /^[a-f0-9]{64}$/;
const outputLimit = 64 * 1024;
const cleanupTimeout = 10_000;

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

async function captureOutput(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
	const decoder = new TextDecoder();
	let remaining = outputLimit;
	let output = "";
	let truncated = false;
	for await (const chunk of abortableSource(stream, signal)) {
		const count = Math.min(remaining, chunk.byteLength);
		if (count > 0) output += decoder.decode(chunk.subarray(0, count), { stream: true });
		remaining -= count;
		truncated ||= count < chunk.byteLength;
	}
	return output + decoder.decode() + (truncated ? "\n[Graph test output truncated]" : "");
}

/** Execute one candidate in the local Linux Docker Desktop engine without exposing host paths. */
export async function testCandidateInDocker(
	workspace: GraphWorkspace,
	candidate: GraphCandidate,
	profile: DockerTestProfile,
	signal?: AbortSignal,
): Promise<GraphTestResult> {
	const { dockerPath, timeoutMs } = profile;
	const image = profile.imageId;
	const command = [...profile.command];
	if (
		process.platform !== "win32" ||
		!isFullyQualifiedPath(dockerPath) ||
		!imageId.test(image) ||
		!command[0]?.startsWith("/")
	) {
		throw new Error(
			"Graph Tester requires a local Windows Docker Desktop profile, an image ID and an absolute container command",
		);
	}
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
		throw new Error("Invalid Graph test timeout");
	const deadline = AbortSignal.timeout(timeoutMs);
	const runSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	runSignal.throwIfAborted();
	const started = performance.now();
	await using run = await TempDir.create("@kostomp-graph-tester-");
	const prefix = [dockerPath, "--host", localEngine, "--config", run.path()];
	const env = { ...systemProcessEnv(), TEMP: run.path(), TMP: run.path() };
	const docker = (args: string[], abort: AbortSignal, input?: Uint8Array) => {
		abort.throwIfAborted();
		return ptree.spawn([...prefix, ...args], { cwd: run.path(), env, signal: abort, stdin: input ?? "ignore" });
	};
	const operatingSystem = await docker(["info", "--format", "{{.OSType}}"], runSignal).text();
	if (operatingSystem.trim() !== "linux") throw new Error("Graph Tester requires the Linux Docker Desktop engine");
	const inspectImage = await docker(["image", "inspect", "--format", "{{json .Config}}", image], runSignal).text();
	const imageConfig = imageConfigSchema.assert(JSON.parse(inspectImage));
	if (imageConfig.Volumes && Object.keys(imageConfig.Volumes).length !== 0)
		throw new Error("Graph test image declares volumes");
	const archive = await (await workspace.testSnapshot(candidate, runSignal)).bytes();
	const name = `kostomp-graph-${crypto.randomUUID()}`;
	let id: string | undefined;
	const removeContainer = async () => {
		const cleanup = await docker(
			["container", "rm", "--force", "--volumes", id ?? name],
			AbortSignal.timeout(cleanupTimeout),
		).wait({ allowNonZero: true });
		if (!cleanup.ok && !cleanup.stderr.includes("No such container")) {
			throw new Error(`Graph test container cleanup failed for ${name}`);
		}
	};
	try {
		const created = await docker(
			[
				"container",
				"create",
				"--name",
				name,
				"--pull=never",
				"--interactive",
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges=true",
				"--user=65532:65532",
				"--no-healthcheck",
				"--log-driver=none",
				"--memory=512m",
				"--memory-swap=512m",
				"--cpus=1",
				"--pids-limit=128",
				"--env=HOME=/tmp",
				"--tmpfs=/work:rw,exec,nosuid,nodev,size=192m,uid=65532,gid=65532,mode=0700",
				"--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777",
				"--entrypoint=/bin/sh",
				image,
				"-c",
				bootstrap,
				"graph-test",
				...command,
			],
			runSignal,
		).text();
		if (!containerId.test(created.trim())) throw new Error("Graph Tester received an invalid container ID");
		id = created.trim();
		const child = docker(["container", "start", "--attach", "--interactive", id], runSignal, archive);
		const [stdout, exit] = await Promise.all([captureOutput(child.stdout, runSignal), child.exited]);
		runSignal.throwIfAborted();
		const inspectState = await docker(["container", "inspect", "--format", "{{json .State}}", id], runSignal).text();
		const state = containerStateSchema.assert(JSON.parse(inspectState));
		if (state.Status !== "exited" || state.Error || state.OOMKilled || (state.ExitCode === 0 && exit !== 0)) {
			throw new Error("Graph test container did not finish normally");
		}
		return {
			treeId: candidate.treeId,
			exitCode: state.ExitCode,
			elapsedMs: performance.now() - started,
			stdout,
			stderr: child.peekStderr(),
		};
	} finally {
		await removeContainer();
	}
}
