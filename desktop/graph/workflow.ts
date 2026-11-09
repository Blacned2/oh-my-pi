import { type } from "@oh-my-pi/omptype";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { buildGraphContext, type GraphCoderContext, type GraphContextManifest } from "./context";
import type { GraphTestResult } from "./docker-tester";
import type { TestFailureObserver } from "./failure-judge";
import { writablePathKey } from "./repo-path";
import { cleanDiagnostic, type GraphReview } from "./review";
import type { CoderRepairFeedback, GraphRunContext, GraphRunStore } from "./run-store";
import { driveGraphRun, type GraphExecutor } from "./scheduler";
import { coderNodeId, contextNodeId, type GraphTaskPlan, parseTaskPlan } from "./task-plan";
import {
	graphBaseIsCurrent,
	type GraphCandidate,
	type GraphCandidateEvidence,
	type GraphChangeSet,
	type GraphRelease,
	type GraphWorkspace,
} from "./workspace";

const inputSchema = type({ source: "string > 0", objective: "0 < string <= 8192", files: "string[]" });
export type ApprovedGraphInput = typeof inputSchema.infer;

/** Container output is untrusted display text: ANSI sequences and control characters are removed. */
function testLog({ exitCode, elapsedMs, stdout, stderr }: GraphTestResult): string {
	const header = `Exit code ${exitCode} after ${Math.round(elapsedMs)} ms`;
	const sections = [header, "--- stdout ---", stdout, "--- stderr ---", stderr];
	return sanitizeText(sections.join("\n"));
}

export function parseApprovedGraphInput(value: unknown): ApprovedGraphInput {
	const input = inputSchema.assert(value);
	if (!input.objective.trim() || input.files.length < 1 || input.files.length > 32) {
		throw new Error("Graph requires an objective and 1–32 approved file paths");
	}
	const paths = input.files.map(file => writablePathKey(file)[0]);
	if (
		paths.some((file, index) =>
			paths.some((other, i) => i !== index && (other === file || other.startsWith(`${file}/`))),
		)
	) {
		throw new Error("Approved Graph file paths overlap");
	}
	return { ...input, files: [...input.files] };
}

/** One Coder node's assignment. `files` is its exclusive write scope. */
export interface CoderBrief {
	nodeId: string;
	title: string;
	brief: string;
	files: readonly string[];
}

/** The approved input of a run. All approved files stay readable by every agent. */
export interface GraphWork extends ApprovedGraphInput {
	tasks: readonly CoderBrief[];
}

/** Runs saved before planning have one `code` node that owns the whole approved scope. */
export function graphWork(context: GraphRunContext): GraphWork {
	const { sourceRoot: source, objective, files, tasks } = context;
	return {
		source,
		objective,
		files,
		tasks: tasks
			? tasks.map(({ id, title, brief, files }) => ({ nodeId: coderNodeId(id), title, brief, files }))
			: [{ nodeId: "code", title: objective, brief: objective, files }],
	};
}

/** A Coder reads the pinned base, or the composed candidate of its prerequisites. */
export interface GraphFileView {
	read(file: string, signal: AbortSignal): Promise<{ data: Uint8Array }>;
}

/** Receives an attempt's display log. Text is sanitized and stored only while the attempt is live. */
export type GraphLog = (text: string) => void;

interface RepairBrief {
	feedback: CoderRepairFeedback;
	previousPatch: string;
}

export interface ApprovedGraphExecutors {
	/** Return the raw proposal. `validate` lets the Planner correct a rejected proposal. */
	plan(
		workspace: GraphWorkspace,
		input: ApprovedGraphInput,
		validate: (proposal: unknown) => GraphTaskPlan,
		signal: AbortSignal,
		log?: GraphLog,
	): Promise<unknown>;
	code(
		view: GraphFileView,
		task: CoderBrief,
		work: GraphWork,
		signal: AbortSignal,
		log: GraphLog,
		repair?: RepairBrief,
		context?: GraphCoderContext,
	): Promise<string>;
	test(workspace: GraphWorkspace, candidate: GraphCandidate, signal: AbortSignal): Promise<GraphTestResult>;
	review(
		workspace: GraphWorkspace,
		candidate: GraphCandidate,
		work: GraphWork,
		signal: AbortSignal,
		log: GraphLog,
	): Promise<GraphReview>;
}

/** Use the same admission checks for Planner output and user edits. */
export function validateGraphTaskPlan(
	workspace: GraphWorkspace,
	proposal: unknown,
	files: readonly string[],
): GraphTaskPlan {
	const plan = parseTaskPlan(proposal, files);
	workspace.checkScopes(new Map(plan.tasks.map(task => [task.id, task.files])));
	return plan;
}

/** Ask the Planner for tasks and admit only a plan that fits the approved scope and the pinned tree. */
export async function proposeGraphPlan(
	workspace: GraphWorkspace,
	input: ApprovedGraphInput,
	executors: ApprovedGraphExecutors,
	signal: AbortSignal,
	log?: GraphLog,
): Promise<GraphTaskPlan> {
	workspace.checkScopes(new Map([["approved", input.files]]));
	const validate = (proposal: unknown) => validateGraphTaskPlan(workspace, proposal, input.files);
	return validate(await executors.plan(workspace, input, validate, signal, log));
}

interface CodeArtifact extends GraphCandidate {
	changes: GraphChangeSet;
}

// Old saved reviews contain a verdict but no findings.
type ReviewArtifact = NonNullable<GraphCandidateEvidence["review"]> & Partial<Pick<GraphReview, "findings">>;

export function retryGraphNode(store: GraphRunStore, runId: string, work: GraphWork, nodeId?: string): boolean {
	const automatic = nodeId === undefined;
	const run = store.get(runId);
	if (!run) return false;
	const release = readGraphRelease(store, runId);
	if (release?.status === "needs_input") {
		const current = store.currentArtifacts(runId);
		const read = <T>(node: string): T | null => {
			const id = current.get(node);
			const data = id && store.artifact(runId, id);
			return data ? (JSON.parse(data) as T) : null;
		};
		const test = read<GraphCandidateEvidence["test"]>("test");
		const review = read<ReviewArtifact>("review");
		if (test?.exitCode != null && test.exitCode !== 0) {
			const task =
				automatic && work.tasks.length === 1 ? work.tasks[0] : work.tasks.find(task => task.nodeId === nodeId);
			if (task) {
				const log = cleanDiagnostic(store.log(run, "test") ?? "").slice(-4_000);
				return store.retry(runId, task.nodeId, {
					feedback: { testExitCode: test.exitCode, log },
					automatic,
				});
			}
		}
		if (review?.verdict === "changes_requested" && review.findings?.length) {
			const findings = review.findings;
			const task = automatic
				? work.tasks.find(task => findings.every(finding => task.files.includes(finding.file)))
				: work.tasks.find(task => task.nodeId === nodeId);
			const owned = task && findings.filter(finding => task.files.includes(finding.file));
			if (task && owned?.length) {
				return store.retry(runId, task.nodeId, { feedback: { findings: owned }, automatic });
			}
		}
	}
	return nodeId !== undefined && store.retry(runId, nodeId);
}

export function readGraphRelease(store: GraphRunStore, runId: string): GraphRelease | undefined {
	const artifact = store.currentArtifacts(runId).get("release");
	const data = artifact && store.artifact(runId, artifact);
	return data ? (JSON.parse(data) as GraphRelease) : undefined;
}

export const DEFAULT_MAX_CODERS = 2;

export interface RunGraphOptions {
	/** Coders with disjoint write scopes that may run at once. Test, review and release wait for all Coders. */
	maxCoders?: number;
	observeFailure?: TestFailureObserver;
	signal?: AbortSignal;
}

/** Run an approved plan. Coder nodes run only for tasks recorded with the run. */
export async function runApprovedGraph(
	store: GraphRunStore,
	runId: string,
	workspace: GraphWorkspace,
	work: GraphWork,
	executors: ApprovedGraphExecutors,
	{ maxCoders = DEFAULT_MAX_CODERS, observeFailure, signal }: RunGraphOptions = {},
): Promise<void> {
	const coders = new Map(work.tasks.map(task => [task.nodeId, task]));
	const scopes = new Map(work.tasks.map(task => [task.nodeId, task.files]));
	const run = store.get(runId);
	const planned = run?.plan.nodes.filter(node => node.role === "coder").map(node => node.id) ?? [];
	if (planned.length !== coders.size || planned.some(id => !coders.has(id))) {
		throw new Error("Graph run plan does not match its approved tasks");
	}
	const hasContext = run?.plan.nodes.some(node => node.id === contextNodeId && node.role === "context");
	let candidate: GraphCandidate | undefined;
	let candidateInputs: string | undefined;
	const readArtifact = <T>(id: string): T => {
		const data = store.artifact(runId, id);
		if (data === null) throw new Error("Graph dependency artifact is missing");
		return JSON.parse(data) as T;
	};
	const readCode = (ids: readonly string[]) =>
		ids.map(id => {
			const saved = readArtifact<CodeArtifact>(id);
			if (saved.baseSha !== workspace.baseSha) throw new Error("Graph candidate base changed");
			return saved;
		});
	const execute: GraphExecutor = async (attempt, attemptSignal) => {
		const { nodeId, inputs } = attempt;
		if (hasContext && nodeId === contextNodeId) {
			return JSON.stringify(await buildGraphContext(workspace, work, attemptSignal));
		}
		// Worker output is untrusted model and tool text; a late call from a stale attempt is ignored.
		const log: GraphLog = text => store.recordLog(attempt, sanitizeText(text));
		const task = coders.get(nodeId);
		if (task) {
			const manifest = hasContext ? readArtifact<GraphContextManifest>(inputs[0]) : undefined;
			if (manifest && manifest.baseSha !== workspace.baseSha) throw new Error("Graph context base changed");
			const upstream = readCode(hasContext ? inputs.slice(1) : inputs).map(saved => saved.changes);
			const context = manifest && {
				references: manifest.references[nodeId],
				upstream: upstream.map(({ nodeId, changes }) => ({ nodeId, files: changes.map(change => change.path) })),
			};
			const view = upstream.length > 0 ? await workspace.compose(scopes, upstream, attemptSignal) : undefined;
			const files: GraphFileView = {
				read: (file, readSignal) =>
					view ? workspace.readCandidateFile(view, file, readSignal) : workspace.readBaseFile(file, readSignal),
			};
			const repair = attempt.repair && {
				feedback: attempt.repair.feedback,
				previousPatch: cleanDiagnostic(
					readArtifact<CodeArtifact>(attempt.repair.previousArtifact).changes.patch,
				).slice(0, 12_000),
			};
			const patch = await executors.code(files, task, work, attemptSignal, log, repair, context);
			const changes = await workspace.captureChangeSet(nodeId, task.files, patch, attemptSignal);
			const proposed = await workspace.compose(scopes, [...upstream, changes], attemptSignal);
			return JSON.stringify({ ...proposed, changes } satisfies CodeArtifact);
		}
		const codeInputs = inputs.slice(0, coders.size);
		const [testInput, reviewInput] = inputs.slice(coders.size);
		if (!candidate || candidateInputs !== codeInputs.join()) {
			const saved = readCode(codeInputs);
			candidate = await workspace.compose(
				scopes,
				saved.map(code => code.changes),
				attemptSignal,
			);
			if (saved.length === 1 && candidate.treeId !== saved[0].treeId) {
				throw new Error("Graph candidate could not be reproduced");
			}
			candidateInputs = codeInputs.join();
		}
		switch (nodeId) {
			case "test": {
				const result = await executors.test(workspace, candidate, attemptSignal);
				if (result.treeId !== candidate.treeId) throw new Error("Graph test ran against a different candidate");
				// The log is kept beside the artifact, so output noise never invalidates review or release.
				store.recordLog(attempt, testLog(result));
				if (result.exitCode !== 0 && observeFailure) {
					const observation = await observeFailure(result, attemptSignal);
					if (observation) store.recordTestObservation(attempt, observation);
				}
				return JSON.stringify({ treeId: result.treeId, exitCode: result.exitCode });
			}
			case "review": {
				const test = readArtifact<GraphCandidateEvidence["test"]>(testInput);
				if (test?.treeId !== candidate.treeId || test.exitCode !== 0) return "null";
				const review = {
					treeId: candidate.treeId,
					...(await executors.review(workspace, candidate, work, attemptSignal, log)),
				};
				return JSON.stringify(review);
			}
			case "release": {
				const test = readArtifact<GraphCandidateEvidence["test"]>(testInput);
				const review = readArtifact<ReviewArtifact | null>(reviewInput);
				const release = await workspace.release(candidate, { test, review: review ?? undefined }, attemptSignal);
				if (release.status === "needs_input") {
					release.reason =
						test?.exitCode !== 0
							? `Tests failed (exit code ${test?.exitCode ?? "unknown"}).`
							: "Review requested changes.";
				}
				return JSON.stringify(release);
			}
			default:
				throw new Error("Unsupported Graph node");
		}
	};
	do {
		await driveGraphRun(store, runId, maxCoders, execute, signal);
	} while (
		!signal?.aborted &&
		readGraphRelease(store, runId)?.status === "needs_input" &&
		(await graphBaseIsCurrent(workspace.sourceRoot, workspace.baseSha, signal)) &&
		retryGraphNode(store, runId, work)
	);
}
