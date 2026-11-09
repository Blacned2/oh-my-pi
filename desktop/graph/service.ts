import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, isFullyQualifiedPath, readLines, toError } from "@oh-my-pi/pi-utils";
import { createApprovedGraphExecutors } from "./agent-executors";
import { GraphRunStore } from "./run-store";
import { approvedGraphPlan, type ApprovedGraphResult, parseApprovedGraphInput, runApprovedGraph } from "./workflow";
import { graphBaseIsCurrent } from "./workspace";

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
const requestSchema = type({ op: "'status' | 'cancel' | 'patch'" }).or({ op: "'start'", input: "unknown" });

interface ActiveRun {
	id: string;
	controller: AbortController;
	job?: Promise<void>;
	result?: ApprovedGraphResult;
	error?: string;
}

const [, , dataRoot, cliPath] = Bun.argv;
if (!dataRoot || !cliPath || !isFullyQualifiedPath(dataRoot) || !isFullyQualifiedPath(cliPath)) {
	throw new Error("Graph sidecar requires an absolute data directory and OMP entry path");
}
await fs.mkdir(dataRoot, { recursive: true });
using store = new GraphRunStore(path.join(dataRoot, "runs.sqlite"));
const profilePath = path.join(dataRoot, "profile.json");
let active: ActiveRun | undefined;

async function handle(request: typeof requestSchema.infer) {
	if (request.op === "start") {
		if (active?.job) throw new Error("A Graph run is already active");
		const input = parseApprovedGraphInput(request.input);
		if (!isFullyQualifiedPath(input.source)) throw new Error("Choose an absolute source repository directory");
		const profile = profileSchema.assert(
			await Bun.file(profilePath)
				.json()
				.catch((error: unknown) => {
					if (isEnoent(error)) throw new Error(`Graph profile is missing. Configure ${profilePath}`);
					throw error;
				}),
		);
		const [command, ...args] = profile.tester.command;
		if (!command) throw new Error("Graph Tester profile requires a container command");
		const executors = createApprovedGraphExecutors(
			{
				bunPath: process.execPath,
				cliPath,
				home: path.join(dataRoot, "profile-home"),
				provider: profile.provider,
				model: profile.model,
				timeoutMs: 120_000,
			},
			{ ...profile.tester, command: [command, ...args] },
		);
		const run = store.create(approvedGraphPlan);
		const current: ActiveRun = { id: run.id, controller: new AbortController() };
		active = current;
		current.job = runApprovedGraph(store, run.id, input, executors, current.controller.signal)
			.then(
				result => {
					if (current.controller.signal.aborted) store.cancel(current.id);
					else current.result = result;
				},
				error => {
					if (current.controller.signal.aborted) store.cancel(current.id);
					else current.error = toError(error).message.slice(0, 2048);
				},
			)
			.finally(() => {
				current.job = undefined;
			});
		return { id: run.id };
	}
	if (request.op === "cancel") {
		if (active?.job) active.controller.abort();
		return null;
	}
	if (request.op === "patch") {
		const result = active?.result;
		if (result?.release?.status !== "ready_to_export") throw new Error("Graph has no verified patch");
		if (!(await graphBaseIsCurrent(result.sourceRoot, result.release.artifact.baseSha))) {
			result.release = { status: "stale_base" };
			throw new Error("The source changed since the Graph run");
		}
		return result.release.artifact;
	}
	if (!active) return null;
	return {
		run: store.get(active.id),
		running: !!active.job,
		status: active.result?.release?.status,
		error: active.error,
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
	await active?.job;
}
