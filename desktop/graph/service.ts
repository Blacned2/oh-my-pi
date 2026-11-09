import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, isFullyQualifiedPath, readLines, toError, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { createApprovedGraphExecutors } from "./agent-executors";
import { type GraphRun, type GraphRunContext, GraphRunStore } from "./run-store";
import { graphPlanForTasks, parseTaskPlan, taskPlanHash } from "./task-plan";
import {
	type ApprovedGraphExecutors,
	DEFAULT_MAX_CODERS,
	graphWork,
	parseApprovedGraphInput,
	proposeGraphPlan,
	readGraphRelease,
	retryGraphNode,
	runApprovedGraph,
	validateGraphTaskPlan,
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
	"maxCoders?": "1 <= number.integer <= 4",
});
const draftSelection = type({ draft: "string", hash: "string" });
const requestSchema = type({ op: "'status' | 'cancel' | 'patch' | 'list' | 'resume' | 'discard'" })
	.or({ op: "'plan'", input: "unknown" })
	.or({ op: "'approve'", input: draftSelection })
	.or({ op: "'edit'", input: draftSelection.and({ plan: "unknown" }) })
	.or({ op: "'open' | 'retry' | 'log'", input: "string" });

interface Job {
	controller: AbortController;
	job: Promise<void>;
}

interface ActiveRun extends Job {
	id: string;
}

interface LoadedProfile {
	hash: string;
	maxCoders: number;
	executors: ApprovedGraphExecutors;
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
let planning: Job | undefined;
let planError: string | undefined;
let selected: string | undefined = store.draft() ? undefined : store.recent()[0]?.id;
let failure: { id: string; message: string } | undefined;
const staleRuns = new Set<string>();

function assertIdle(): void {
	if (active || planning) throw new Error("A Graph run or plan is already active");
}

async function loadProfile(): Promise<LoadedProfile> {
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
		maxCoders,
	} = profile;
	const [command, ...args] = commands;
	if (!command) throw new Error("Graph Tester profile requires a container command");
	// An unset limit keeps the hash of runs saved before the field existed.
	const identity: unknown[] = [provider, model, dockerPath, imageId, commands, timeoutMs];
	if (maxCoders !== undefined) identity.push({ maxCoders });
	return {
		hash: new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex"),
		maxCoders: maxCoders ?? DEFAULT_MAX_CODERS,
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

function launch(run: GraphRun & { context: GraphRunContext }, { executors, maxCoders }: LoadedProfile) {
	const controller = new AbortController();
	const { context } = run;
	selected = run.id;
	failure = undefined;
	staleRuns.delete(run.id);
	const job = (async () => {
		try {
			const work = graphWork(context);
			await using workspace = await GraphWorkspace.pin(work.source, controller.signal);
			if (workspace.baseSha !== context.baseSha || workspace.sourceRoot !== context.sourceRoot) {
				throw new Error("The source changed since the Graph run");
			}
			await runApprovedGraph(store, run.id, workspace, work, executors, { maxCoders, signal: controller.signal });
		} catch (error) {
			if (!controller.signal.aborted) failure = { id: run.id, message: toError(error).message.slice(0, 2048) };
		} finally {
			if (controller.signal.aborted) store.cancel(run.id);
			active = undefined;
		}
	})();
	active = { id: run.id, controller, job };
}

async function proposePlan(value: unknown) {
	const input = parseApprovedGraphInput(value);
	if (!isFullyQualifiedPath(input.source)) throw new Error("Choose an absolute source repository directory");
	const profile = await loadProfile();
	const { sourceRoot, baseSha } = await inspectGraphSource(input.source);
	const scoped = { ...input, source: sourceRoot };
	const controller = new AbortController();
	planError = undefined;
	selected = undefined;
	const job = (async () => {
		try {
			await using workspace = await GraphWorkspace.pin(sourceRoot, controller.signal);
			if (workspace.baseSha !== baseSha) throw new Error("The source changed while planning");
			const plan = await proposeGraphPlan(workspace, scoped, profile.executors, controller.signal);
			controller.signal.throwIfAborted();
			store.saveDraft({
				id: crypto.randomUUID(),
				input: scoped,
				baseSha,
				profileHash: profile.hash,
				plan,
				hash: taskPlanHash(plan),
			});
		} catch (error) {
			if (!controller.signal.aborted) planError = toError(error).message.slice(0, 2048);
		} finally {
			planning = undefined;
		}
	})();
	planning = { controller, job };
}

function selectedDraft({ draft: id, hash }: typeof draftSelection.infer) {
	const draft = store.draft();
	if (!draft || draft.id !== id || draft.hash !== hash) {
		throw new Error("The proposed plan changed. Review it again before approving");
	}
	return draft;
}

async function editPlan(selection: typeof draftSelection.infer, proposal: unknown): Promise<void> {
	const draft = selectedDraft(selection);
	if ((await loadProfile()).hash !== draft.profileHash) throw new Error("The Graph profile changed. Plan again");
	if (!(await graphBaseIsCurrent(draft.input.source, draft.baseSha)))
		throw new Error("The source changed. Plan again");
	await using workspace = await GraphWorkspace.pin(draft.input.source);
	if (workspace.baseSha !== draft.baseSha || workspace.sourceRoot !== draft.input.source) {
		throw new Error("The source changed. Plan again");
	}
	const plan = validateGraphTaskPlan(workspace, proposal, draft.input.files);
	store.saveDraft({ ...draft, plan, hash: taskPlanHash(plan) });
	planError = undefined;
}

/** Admit exactly the plan the user reviewed, then record it with the new run. */
async function approvePlan(selection: typeof draftSelection.infer) {
	const draft = selectedDraft(selection);
	const { id, hash } = draft;
	const { input, baseSha, profileHash } = draft;
	const plan = parseTaskPlan(draft.plan, input.files);
	if (taskPlanHash(plan) !== hash) throw new Error("The proposed plan changed. Review it again before approving");
	const profile = await loadProfile();
	if (profile.hash !== profileHash) throw new Error("The Graph profile changed. Plan again");
	if (!(await graphBaseIsCurrent(input.source, baseSha))) throw new Error("The source changed. Plan again");
	const context: GraphRunContext = {
		sourceRoot: input.source,
		baseSha,
		objective: input.objective,
		files: input.files,
		profileHash,
		tasks: plan.tasks,
		planHash: hash,
		approvedAt: Date.now(),
	};
	const run = store.create(graphPlanForTasks(plan), context, { id, hash });
	launch({ ...run, context }, profile);
	return { id: run.id };
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
	if (request.op === "plan") {
		assertIdle();
		await proposePlan(request.input);
		return null;
	}
	if (request.op === "approve") {
		assertIdle();
		return approvePlan(request.input);
	}
	if (request.op === "edit") {
		assertIdle();
		await editPlan(request.input, request.input.plan);
		return null;
	}
	if (request.op === "discard") {
		planning?.controller.abort();
		store.discardDraft();
		planError = undefined;
		return null;
	}
	const run = selectedRun();
	if (request.op === "log") {
		const log = run && store.log(run, request.input);
		if (log == null) throw new Error("This Graph step has no log");
		return log;
	}
	if (request.op === "retry" || request.op === "resume") {
		assertIdle();
		if (!run?.context) throw new Error("This Graph run has no saved execution context");
		const { context } = run;
		const profile = await loadProfile();
		if (profile.hash !== context.profileHash)
			throw new Error("The Graph profile changed. Restore it or start a new run");
		if (!(await graphBaseIsCurrent(context.sourceRoot, context.baseSha)))
			throw new Error("The source changed since the Graph run");
		const admitted =
			request.op === "retry"
				? retryGraphNode(store, run.id, graphWork(context), request.input)
				: store.readyNodes(run).length > 0;
		if (!admitted) throw new Error("This Graph run has no eligible attempt");
		launch({ ...run, context }, profile);
		return null;
	}
	if (request.op === "cancel") {
		planning?.controller.abort();
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
	const idle = !active && !planning;
	const draft = store.draft() ?? undefined;
	const proposal = {
		planning: !!planning,
		planError,
		draft: draft && {
			id: draft.id,
			hash: draft.hash,
			source: draft.input.source,
			objective: draft.input.objective,
			files: draft.input.files,
			baseSha: draft.baseSha,
			tasks: draft.plan.tasks,
		},
	};
	if (!run) return { busy: !idle, ...proposal };
	const status = staleRuns.has(run.id) ? "stale_base" : release?.status;
	return {
		run,
		running: active?.id === run.id,
		busy: !idle,
		status,
		reason: status === "needs_input" && release?.status === "needs_input" ? release.reason : undefined,
		error: failure?.id === run.id ? failure.message : undefined,
		retryable: run.context && idle ? store.retryableNodes(run) : [],
		resumable: !!run.context && idle && store.readyNodes(run).length > 0,
		logs: store.loggedNodes(run),
		...proposal,
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
	planning?.controller.abort();
	try {
		await Promise.all([active?.job, planning?.job]);
	} finally {
		lease.release();
	}
}
