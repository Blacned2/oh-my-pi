import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, isFullyQualifiedPath, readLines, toError, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { createApprovedGraphExecutors } from "./agent-executors";
import { type GraphRun, GraphRunStore } from "./run-store";
import {
	type ApprovedGraphExecutors,
	type ApprovedGraphInput,
	approvedGraphPlan,
	parseApprovedGraphInput,
	readGraphRelease,
	runApprovedGraph,
} from "./workflow";
import { graphBaseIsCurrent, GraphWorkspace, inspectGraphSource } from "./workspace";

const profileSchema = type({
	provider: "string > 0",
	model: "string > 0",
	tester: {
		dockerPath: "string > 0",
		imageId: "string > 0",
		command: "string[]",
		timeoutMs: "1 <= number.integer <= 300000",
	},
});
const requestSchema = type({ op: "'status' | 'cancel' | 'patch' | 'list' | 'resume'" })
	.or({ op: "'start'", input: "unknown" })
	.or({ op: "'open' | 'retry'", input: "string" });

interface ActiveRun {
	id: string;
	controller: AbortController;
	job: Promise<void>;
}

const [, , dataRoot, cliPath] = Bun.argv;
if (!dataRoot || !cliPath || !isFullyQualifiedPath(dataRoot) || !isFullyQualifiedPath(cliPath)) {
	throw new Error("Graph sidecar requires an absolute data directory and OMP entry path");
}
await fs.mkdir(dataRoot, { recursive: true });
const lease = tryAcquireFileLock(path.join(dataRoot, "sidecar"));
if (!lease) throw new Error("Another Graph sidecar owns this data directory");
using store = new GraphRunStore(path.join(dataRoot, "runs.sqlite"));
const profilePath = path.join(dataRoot, "profile.json");
let active: ActiveRun | undefined;
let selected: string | undefined = store.recent()[0]?.id;
let failure: { id: string; message: string } | undefined;
const staleRuns = new Set<string>();

async function loadProfile() {
	const profile = profileSchema.assert(
		await Bun.file(profilePath)
			.json()
			.catch((error: unknown) => {
				if (isEnoent(error)) throw new Error(`Graph profile is missing. Configure ${profilePath}`);
				throw error;
			}),
	);
	const {
		provider,
		model,
		tester: { dockerPath, imageId, command: commands, timeoutMs },
	} = profile;
	const [command, ...args] = commands;
	if (!command) throw new Error("Graph Tester profile requires a container command");
	return {
		hash: new Bun.CryptoHasher("sha256")
			.update(JSON.stringify([provider, model, dockerPath, imageId, commands, timeoutMs]))
			.digest("hex"),
		executors: createApprovedGraphExecutors(
			{
				bunPath: process.execPath,
				cliPath,
				home: path.join(dataRoot, "profile-home"),
				provider,
				model,
				timeoutMs: 120_000,
			},
			{ dockerPath, imageId, timeoutMs, command: [command, ...args] },
		),
	};
}

function launch(run: GraphRun, input: ApprovedGraphInput, executors: ApprovedGraphExecutors) {
	const controller = new AbortController();
	selected = run.id;
	failure = undefined;
	staleRuns.delete(run.id);
	const job = (async () => {
		try {
			await using workspace = await GraphWorkspace.pin(input.source, controller.signal);
			if (
				!run.context ||
				workspace.baseSha !== run.context.baseSha ||
				workspace.sourceRoot !== run.context.sourceRoot
			) {
				throw new Error("The source changed since the Graph run");
			}
			await runApprovedGraph(store, run.id, workspace, input, executors, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) failure = { id: run.id, message: toError(error).message.slice(0, 2048) };
		} finally {
			if (controller.signal.aborted) store.cancel(run.id);
			active = undefined;
		}
	})();
	active = { id: run.id, controller, job };
}

function selectedRun(): GraphRun | null {
	if (!selected) return null;
	const run = store.get(selected);
	if (run && !active && Object.values(run.nodes).some(node => node.status === "running")) {
		store.recoverInterrupted(run.id);
		return store.get(run.id);
	}
	return run;
}

async function handle(request: typeof requestSchema.infer) {
	if (request.op === "list") return store.recent();
	if (request.op === "open") {
		if (!store.get(request.input)) throw new Error("Unknown Graph run");
		selected = request.input;
		return null;
	}
	if (request.op === "start") {
		if (active) throw new Error("A Graph run is already active");
		const input = parseApprovedGraphInput(request.input);
		if (!isFullyQualifiedPath(input.source)) throw new Error("Choose an absolute source repository directory");
		const profile = await loadProfile();
		const { sourceRoot, baseSha } = await inspectGraphSource(input.source);
		const run = store.create(approvedGraphPlan, {
			sourceRoot,
			baseSha,
			objective: input.objective,
			files: input.files,
			profileHash: profile.hash,
		});
		launch(run, { ...input, source: sourceRoot }, profile.executors);
		return { id: run.id };
	}
	const run = selectedRun();
	if (request.op === "retry" || request.op === "resume") {
		if (active) throw new Error("A Graph run is already active");
		if (!run?.context) throw new Error("This Graph run has no saved execution context");
		const { context } = run;
		const profile = await loadProfile();
		if (profile.hash !== context.profileHash)
			throw new Error("The Graph profile changed. Restore it or start a new run");
		if (!(await graphBaseIsCurrent(context.sourceRoot, context.baseSha)))
			throw new Error("The source changed since the Graph run");
		const admitted = request.op === "retry" ? store.retry(run.id, request.input) : store.readyNodes(run).length > 0;
		if (!admitted) throw new Error("This Graph run has no eligible attempt");
		launch(
			run,
			{ source: context.sourceRoot, objective: context.objective, files: context.files },
			profile.executors,
		);
		return null;
	}
	if (request.op === "cancel") {
		if (active && active.id === run?.id) active.controller.abort();
		return null;
	}
	const release = run?.context && active?.id !== run.id ? readGraphRelease(store, run.id) : undefined;
	if (request.op === "patch") {
		if (!run?.context || release?.status !== "ready_to_export") throw new Error("Graph has no verified patch");
		if (
			release.artifact.baseSha !== run.context.baseSha ||
			!(await graphBaseIsCurrent(run.context.sourceRoot, run.context.baseSha))
		) {
			staleRuns.add(run.id);
			throw new Error("The source changed since the Graph run");
		}
		return release.artifact;
	}
	if (!run) return null;
	return {
		run,
		running: active?.id === run.id,
		busy: !!active,
		status: staleRuns.has(run.id) ? "stale_base" : release?.status,
		error: failure?.id === run.id ? failure.message : undefined,
		retryable: run.context && !active ? store.retryableNodes(run) : [],
		resumable: !!run.context && !active && store.readyNodes(run).length > 0,
	};
}

try {
	const decoder = new TextDecoder();
	for await (const line of readLines(Bun.stdin.stream())) {
		let response: { ok: true; data: unknown } | { ok: false; error: string };
		try {
			const request = requestSchema.assert(JSON.parse(decoder.decode(line)));
			response = { ok: true, data: await handle(request) };
		} catch (error) {
			response = { ok: false, error: toError(error).message.slice(0, 2048) };
		}
		process.stdout.write(`${JSON.stringify(response)}\n`);
	}
} finally {
	active?.controller.abort();
	try {
		await active?.job;
	} finally {
		lease.release();
	}
}
