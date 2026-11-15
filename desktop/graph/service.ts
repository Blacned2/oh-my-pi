import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { isEnoent, isFullyQualifiedPath, readLines, toError, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { createApprovedGraphExecutors } from "./agent-executors";
import { createTestFailureObserver, type TestFailureObserver } from "./failure-judge";
import { type GraphProfile, graphProfileHash, graphProfileMatches, graphTesterProfile, profileSchema } from "./profile";
import { cleanDiagnostic } from "./review";
import { type GraphRun, type GraphRunContext, GraphRunStore } from "./run-store";
import { GRAPH_SHUTDOWN } from "./scheduler";
import { graphPlanForTasks, parseTaskPlan, taskPlanHash } from "./task-plan";
import {
	type ApprovedGraphExecutors,
	type ApprovedGraphInput,
	approvedGraphInputSchema,
	DEFAULT_MAX_CODERS,
	graphWork,
	proposeGraphPlan,
	readGraphRelease,
	retryGraphNode,
	runApprovedGraph,
	validateGraphTaskPlan,
} from "./workflow";
import { graphBaseIsCurrent, GraphObjectCache, GraphWorkspace, inspectGraphSource } from "./workspace";

// Stdout carries the protocol; output from any dependency goes to stderr, the sidecar's diagnostic channel.
for (const method of ["log", "info", "debug", "warn"] as const) {
	console[method] = (...data: unknown[]) => console.error(...data);
}

const draftSelection = type({ draft: "string", hash: "string" });
const bareRequest = type({
	op: "'status' | 'cancel' | 'patch' | 'resume' | 'discard' | 'compose' | 'settings'",
});
const runRequest = type({ op: "'open' | 'retry' | 'log' | 'delete'", input: "string" });
const opSchema = type({
	op: "'status' | 'cancel' | 'patch' | 'list' | 'resume' | 'discard' | 'compose' | 'settings' | 'configure' | 'plan' | 'approve' | 'edit' | 'open' | 'retry' | 'log' | 'delete'",
});
/** The op is validated first, so an input error names its op instead of listing every request shape. */
const requestSchemas = {
	status: bareRequest,
	cancel: bareRequest,
	patch: bareRequest,
	list: type({ op: "'list'", "input?": { "after?": "string" } }),
	resume: bareRequest,
	discard: bareRequest,
	compose: bareRequest,
	settings: bareRequest,
	configure: type({ op: "'configure'", input: profileSchema }),
	plan: type({ op: "'plan'", input: approvedGraphInputSchema }),
	approve: type({ op: "'approve'", input: draftSelection }),
	edit: type({ op: "'edit'", input: draftSelection.and({ plan: "unknown" }) }),
	open: runRequest,
	retry: runRequest,
	log: runRequest,
	delete: runRequest,
};
type GraphRequest = (typeof requestSchemas)[keyof typeof requestSchemas]["infer"];

function parseRequest(value: unknown): GraphRequest {
	const { op } = opSchema.assert(value);
	try {
		return requestSchemas[op].assert(value);
	} catch (error) {
		throw new Error(`Invalid Graph ${op} request: ${toError(error).message}`);
	}
}

interface PlanningJob {
	controller: AbortController;
	input: ApprovedGraphInput;
}

/** The most recent run or planning job that ended on its own in this process; the user's stops are not reported. */
interface FinishedWork {
	/** Epoch ms; identifies the event. */
	at: number;
	run?: string;
	objective: string;
	outcome: "ready_to_export" | "needs_input" | "stale_base" | "failed" | "paused" | "plan_ready" | "plan_failed";
	reason?: string;
}

interface ActiveRun {
	id: string;
	controller: AbortController;
}

interface LoadedProfile {
	/** Stored with new drafts and runs. */
	hash: string;
	/** True for a hash saved with this profile under the current or the legacy formula. */
	matches: (savedHash: string) => boolean;
	maxCoders: number;
	allowDirty: boolean;
	executors: ApprovedGraphExecutors;
	observeFailure?: TestFailureObserver;
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
let planning: PlanningJob | undefined;
let planningLog = "";
let planError = store.latestPlanning()?.error;
let selected: string | undefined = store.draft() || planError ? undefined : store.recent().runs[0]?.id;
let failure: { id: string; message: string } | undefined;
let finished: FinishedWork | undefined;
const staleRuns = new Set<string>();
/** Run and planning jobs until their workspace is disposed, keyed to the run they write (planning has none). */
const jobs = new Map<Promise<void>, string | undefined>();
/** Plan, edit and run of the same commit pin one copy of its object database. */
const objectCache = new GraphObjectCache();

function assertIdle(): void {
	if (active || planning) throw new Error("A Graph run or plan is already active");
}

function track(runId: string | undefined, body: Promise<void>): void {
	const job: Promise<void> = body
		.catch(error => console.error("Graph job failed:", error))
		.finally(() => jobs.delete(job));
	jobs.set(job, runId);
}

/** Runs after the outcome is recorded and the slot is free; a cleanup failure never replaces that outcome. */
async function disposeWorkspace(workspace: GraphWorkspace | undefined): Promise<void> {
	try {
		await workspace?.[Symbol.asyncDispose]();
	} catch (error) {
		console.error("Graph workspace cleanup failed:", error);
	}
}

/**
 * Leftovers of a killed sidecar. Only a scratch directory the host dedicated to this sidecar is swept.
 * They are listed before the first request is served, so nothing this process creates is among them; removing
 * them (object-database copies can be large) continues in the background and never delays an answer.
 */
async function sweepScratch(): Promise<void> {
	const scratch = Bun.env.KOSTOMP_GRAPH_SCRATCH;
	if (!scratch) return;
	try {
		const [directory, temporary] = await Promise.all([fs.realpath(scratch), fs.realpath(os.tmpdir())]);
		const same =
			process.platform === "win32" ? directory.toLowerCase() === temporary.toLowerCase() : directory === temporary;
		if (!same) return;
		for (const name of await fs.readdir(directory)) {
			if (!name.startsWith("kostomp-graph-")) continue;
			void fs
				.rm(path.join(directory, name), { recursive: true, force: true })
				.catch(error => console.error("Graph scratch sweep failed:", error));
		}
	} catch (error) {
		console.error("Graph scratch sweep failed:", error);
	}
}

/** The saved profile exactly as written, or undefined before the first save. */
async function readProfileFile(): Promise<unknown> {
	try {
		return await Bun.file(profilePath).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function buildProfile(profile: GraphProfile): LoadedProfile {
	const { provider, model, maxCoders, allowDirty, failureJudge } = profile;
	const tester = graphTesterProfile(profile);
	return {
		hash: graphProfileHash(profile),
		matches: savedHash => graphProfileMatches(profile, savedHash),
		maxCoders: maxCoders ?? DEFAULT_MAX_CODERS,
		allowDirty: allowDirty ?? false,
		observeFailure: failureJudge && createTestFailureObserver(failureJudge),
		executors: createApprovedGraphExecutors(
			{
				bunPath: process.execPath,
				cliPath,
				home: path.join(dataRoot, "profile-home"),
				provider,
				model,
				timeoutMs: 600_000,
			},
			tester,
		),
	};
}

async function loadProfile(): Promise<LoadedProfile> {
	const raw = await readProfileFile();
	if (raw === undefined) throw new Error("Graph profile is missing. Configure it in Settings > Graph");
	return buildProfile(profileSchema.assert(raw));
}

async function readSettings() {
	let profile: unknown;
	try {
		profile = await readProfileFile();
	} catch (cause) {
		// An unreadable file must not lock the user out of the form that replaces it.
		return { path: profilePath, profile: null, error: toError(cause).message.slice(0, 2048) };
	}
	let error: string | undefined;
	if (profile !== undefined) {
		try {
			buildProfile(profileSchema.assert(profile));
		} catch (cause) {
			error = toError(cause).message.slice(0, 2048);
		}
	}
	return { path: profilePath, profile: profile ?? null, error };
}

async function saveSettings(profile: GraphProfile): Promise<void> {
	buildProfile(profile);
	const staged = `${profilePath}.tmp`;
	await Bun.write(staged, `${JSON.stringify(profile, null, "\t")}\n`);
	await fs.rename(staged, profilePath);
}

async function executeRun(
	run: GraphRun & { context: GraphRunContext },
	{ executors, maxCoders, allowDirty, observeFailure }: LoadedProfile,
	controller: AbortController,
): Promise<void> {
	const { context } = run;
	let workspace: GraphWorkspace | undefined;
	let threw = false;
	try {
		const work = graphWork(context);
		workspace = await GraphWorkspace.pin(work.source, { signal: controller.signal, allowDirty, objectCache });
		if (workspace.baseSha !== context.baseSha || workspace.sourceRoot !== context.sourceRoot) {
			throw new Error("The source changed since the Graph run");
		}
		await runApprovedGraph(store, run.id, workspace, work, executors, {
			maxCoders,
			observeFailure,
			signal: controller.signal,
		});
	} catch (error) {
		if (!controller.signal.aborted) {
			threw = true;
			failure = { id: run.id, message: toError(error).message.slice(0, 2048) };
		}
	} finally {
		if (controller.signal.aborted) {
			// App exit leaves the run resumable; only the user's Cancel or Delete ends it.
			if (controller.signal.reason === GRAPH_SHUTDOWN) store.recoverInterrupted(run.id);
			else store.cancel(run.id);
		} else {
			finished = runOutcome(run.id, context.objective, threw);
		}
		if (active?.controller === controller) active = undefined;
	}
	await disposeWorkspace(workspace);
}

/** How a run that ended on its own left its work: its release, a failure, or remaining work with nothing ready. */
function runOutcome(runId: string, objective: string, threw: boolean): FinishedWork {
	const finishedRun = { at: Date.now(), run: runId, objective };
	const release = readGraphRelease(store, runId);
	if (release?.status === "needs_input") return { ...finishedRun, outcome: release.status, reason: release.reason };
	if (release) return { ...finishedRun, outcome: release.status };
	const failed = threw || Object.values(store.get(runId)?.nodes ?? {}).some(node => node.status === "failed");
	return { ...finishedRun, outcome: failed ? "failed" : "paused" };
}

function launch(run: GraphRun & { context: GraphRunContext }, profile: LoadedProfile) {
	const controller = new AbortController();
	active = { id: run.id, controller };
	selected = run.id;
	failure = undefined;
	staleRuns.delete(run.id);
	track(run.id, executeRun(run, profile, controller));
}

async function executePlanner(
	id: string,
	input: ApprovedGraphInput,
	baseSha: string,
	profile: LoadedProfile,
	controller: AbortController,
): Promise<void> {
	let log = "";
	let workspace: GraphWorkspace | undefined;
	try {
		workspace = await GraphWorkspace.pin(input.source, {
			signal: controller.signal,
			allowDirty: profile.allowDirty,
			objectCache,
		});
		if (workspace.baseSha !== baseSha) throw new Error("The source changed while planning");
		const plan = await proposeGraphPlan(workspace, input, profile.executors, controller.signal, text => {
			log = cleanDiagnostic(text);
			if (planning?.controller === controller) planningLog = log;
		});
		controller.signal.throwIfAborted();
		store.recordPlanning(
			{ id, log },
			{
				id,
				input,
				baseSha,
				profileHash: profile.hash,
				plan,
				hash: taskPlanHash(plan),
			},
		);
		finished = { at: Date.now(), objective: input.objective, outcome: "plan_ready" };
	} catch (error) {
		if (!controller.signal.aborted) {
			planError = cleanDiagnostic(toError(error).message).slice(0, 2048) || "Graph planning failed";
			store.recordPlanning({ id, error: planError, log: [log, planError].filter(Boolean).join("\n") });
			finished = { at: Date.now(), objective: input.objective, outcome: "plan_failed", reason: planError };
		}
	} finally {
		if (planning?.controller === controller) {
			planning = undefined;
			planningLog = "";
		}
	}
	await disposeWorkspace(workspace);
}

async function proposePlan(input: ApprovedGraphInput) {
	if (!input.objective.trim()) throw new Error("Graph requires an objective");
	if (!isFullyQualifiedPath(input.source)) throw new Error("Choose an absolute source repository directory");
	const profile = await loadProfile();
	const { sourceRoot, baseSha } = await inspectGraphSource(input.source, { allowDirty: profile.allowDirty });
	const scoped = { ...input, source: sourceRoot };
	const controller = new AbortController();
	planError = undefined;
	selected = undefined;
	planningLog = "";
	planning = { controller, input: scoped };
	track(undefined, executePlanner(crypto.randomUUID(), scoped, baseSha, profile, controller));
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
	const { hash, matches, allowDirty } = await loadProfile();
	if (!matches(draft.profileHash)) throw new Error("The Graph profile changed. Plan again");
	if (!(await graphBaseIsCurrent(draft.input.source, draft.baseSha, { allowDirty })))
		throw new Error("The source changed. Plan again");
	await using workspace = await GraphWorkspace.pin(draft.input.source, { allowDirty, objectCache });
	if (workspace.baseSha !== draft.baseSha || workspace.sourceRoot !== draft.input.source) {
		throw new Error("The source changed. Plan again");
	}
	const plan = validateGraphTaskPlan(workspace, proposal);
	store.saveDraft({ ...draft, profileHash: hash, plan, hash: taskPlanHash(plan) });
	planError = undefined;
	store.clearPlanningError();
}

/** Admit exactly the plan the user reviewed, then record it with the new run. */
async function approvePlan(selection: typeof draftSelection.infer) {
	const draft = selectedDraft(selection);
	const { id, hash } = draft;
	const { input, baseSha, profileHash } = draft;
	const plan = parseTaskPlan(draft.plan);
	if (taskPlanHash(plan) !== hash) throw new Error("The proposed plan changed. Review it again before approving");
	const profile = await loadProfile();
	if (!profile.matches(profileHash)) throw new Error("The Graph profile changed. Plan again");
	if (!(await graphBaseIsCurrent(input.source, baseSha, { allowDirty: profile.allowDirty })))
		throw new Error("The source changed. Plan again");
	const context: GraphRunContext = {
		sourceRoot: input.source,
		baseSha,
		objective: input.objective,
		files: [],
		profileHash: profile.hash,
		tasks: plan.tasks,
		planHash: hash,
		approvedAt: Date.now(),
	};
	// Creating the run consumes the draft and its stored planning record.
	const run = store.create(graphPlanForTasks(plan), context, { id, hash });
	planError = undefined;
	launch({ ...run, context }, profile);
	return { id: run.id };
}

function selectedRun(): GraphRun | null {
	if (!selected) return null;
	const run = store.get(selected);
	if (run && active?.id !== run.id && Object.values(run.nodes).some(node => node.status === "running")) {
		store.recoverInterrupted(run.id);
		return store.get(run.id);
	}
	return run;
}

async function handle(request: GraphRequest) {
	if (request.op === "list") return store.recent(request.input?.after);
	if (request.op === "settings") return readSettings();
	if (request.op === "configure") {
		assertIdle();
		await saveSettings(request.input);
		return null;
	}
	if (request.op === "compose") {
		selected = undefined;
		return null;
	}
	if (request.op === "open") {
		if (!store.get(request.input)) throw new Error("Unknown Graph run");
		selected = request.input;
		staleRuns.delete(request.input);
		return null;
	}
	if (request.op === "delete") {
		const runId = request.input;
		if (!store.get(runId)) throw new Error("Unknown Graph run");
		if (active?.id === runId) active.controller.abort();
		// Wait for the executor and workspace to finish so nothing can write the run after it is removed.
		await Promise.all([...jobs].flatMap(([job, owner]) => (owner === runId ? [job] : [])));
		store.delete(runId);
		if (selected === runId) selected = undefined;
		if (failure?.id === runId) failure = undefined;
		staleRuns.delete(runId);
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
		const log = run
			? store.log(run, request.input)
			: request.input === "planner"
				? planning
					? planningLog
					: store.latestPlanning()?.log
				: undefined;
		if (!log) throw new Error("This Graph step has no log");
		return log;
	}
	if (request.op === "retry" || request.op === "resume") {
		assertIdle();
		if (!run?.context) throw new Error("This Graph run has no saved execution context");
		const { context } = run;
		const profile = await loadProfile();
		if (!profile.matches(context.profileHash))
			throw new Error("The Graph profile changed. Restore it or start a new run");
		if (!(await graphBaseIsCurrent(context.sourceRoot, context.baseSha, { allowDirty: profile.allowDirty })))
			throw new Error("The source changed since the Graph run");
		if (request.op === "retry") {
			const nodeId = request.input;
			if (!retryGraphNode(store, run.id, graphWork(context), nodeId)) {
				const node = run.plan.nodes.find(candidate => candidate.id === nodeId);
				if (node && run.nodes[node.id].usedAttempts >= node.maxAttempts) {
					throw new Error(`${node.id} has used all ${node.maxAttempts} attempts for these inputs`);
				}
				throw new Error("This Graph run has no eligible attempt");
			}
		} else if (!store.resume(run.id)) {
			throw new Error("This Graph run has no eligible attempt");
		}
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
		const { allowDirty } = await loadProfile();
		if (
			release.artifact.baseSha !== run.context.baseSha ||
			!(await graphBaseIsCurrent(run.context.sourceRoot, run.context.baseSha, { allowDirty }))
		) {
			staleRuns.add(run.id);
			throw new Error("The source changed since the Graph run");
		}
		staleRuns.delete(run.id);
		return release.artifact;
	}
	const idle = !active && !planning;
	const activeRun = active?.id;
	const draft = store.draft() ?? undefined;
	const proposal = {
		planning: planning && { objective: planning.input.objective, source: planning.input.source },
		planError,
		draft: draft && {
			id: draft.id,
			hash: draft.hash,
			source: draft.input.source,
			objective: draft.input.objective,
			baseSha: draft.baseSha,
			tasks: draft.plan.tasks,
			nodes: graphPlanForTasks(draft.plan).nodes,
		},
	};
	if (!run) {
		const plannerLog = planning ? planningLog : store.latestPlanning()?.log;
		return {
			busy: !idle,
			activeRun,
			finished,
			...proposal,
			...(plannerLog && { logs: ["planner"], logSizes: { planner: plannerLog.length } }),
		};
	}
	const stale = staleRuns.has(run.id);
	const status = stale ? "stale_base" : release?.status;
	const logSizes = store.logSizes(run);
	return {
		run,
		running: active?.id === run.id,
		activeRun,
		finished,
		cancelling: (active?.id === run.id && active.controller.signal.aborted) || undefined,
		busy: !idle,
		status,
		reason: status === "needs_input" && release?.status === "needs_input" ? release.reason : undefined,
		error: failure?.id === run.id ? failure.message : undefined,
		retryable: run.context && idle && !stale ? store.retryableNodes(run) : [],
		resumable: !!run.context && idle && store.resumableNodes(run).length > 0,
		logs: Object.keys(logSizes),
		logSizes,
		failureObservation: store.testObservation(run),
		...proposal,
	};
}

/** A lone surrogate, e.g. from a length cut through an astral character, would make the host reject the line. */
function wellFormed(_key: string, value: unknown): unknown {
	return typeof value === "string" ? value.toWellFormed() : value;
}

await sweepScratch();
try {
	const decoder = new TextDecoder();
	for await (const line of readLines(Bun.stdin.stream())) {
		let response: { ok: true; data: unknown } | { ok: false; error: string };
		try {
			const request = parseRequest(JSON.parse(decoder.decode(line)));
			response = { ok: true, data: await handle(request) };
		} catch (error) {
			response = { ok: false, error: toError(error).message.slice(0, 2048) };
		}
		process.stdout.write(`${JSON.stringify(response, wellFormed)}\n`);
	}
} finally {
	// Closed stdin is app exit: live attempts are interrupted, not cancelled, so the run can resume after restart.
	active?.controller.abort(GRAPH_SHUTDOWN);
	planning?.controller.abort(GRAPH_SHUTDOWN);
	try {
		await Promise.all(jobs.keys());
	} finally {
		try {
			await objectCache[Symbol.asyncDispose]();
		} catch (error) {
			console.error("Graph object cache cleanup failed:", error);
		}
		lease.release();
	}
}
