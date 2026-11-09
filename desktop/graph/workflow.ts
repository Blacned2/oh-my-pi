import { type } from "@oh-my-pi/omptype";
import type { GraphTestResult } from "./docker-tester";
import { writablePathKey } from "./repo-path";
import type { GraphRunContext, GraphRunStore } from "./run-store";
import { driveGraphRun } from "./scheduler";
import { coderNodeId, type GraphTaskPlan, parseTaskPlan } from "./task-plan";
import type { GraphCandidate, GraphCandidateEvidence, GraphChangeSet, GraphRelease, GraphWorkspace } from "./workspace";

const inputSchema = type({ source: "string > 0", objective: "0 < string <= 8192", files: "string[]" });
export type ApprovedGraphInput = typeof inputSchema.infer;
export type ReviewVerdict = NonNullable<GraphCandidateEvidence["review"]>["verdict"];

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

export interface ApprovedGraphExecutors {
	/** Return the raw proposal. `validate` lets the Planner correct a rejected proposal. */
	plan(
		workspace: GraphWorkspace,
		input: ApprovedGraphInput,
		validate: (proposal: unknown) => GraphTaskPlan,
		signal: AbortSignal,
	): Promise<unknown>;
	code(view: GraphFileView, task: CoderBrief, work: GraphWork, signal: AbortSignal): Promise<string>;
	test(workspace: GraphWorkspace, candidate: GraphCandidate, signal: AbortSignal): Promise<GraphTestResult>;
	review(
		workspace: GraphWorkspace,
		candidate: GraphCandidate,
		work: GraphWork,
		signal: AbortSignal,
	): Promise<ReviewVerdict>;
}

/** Ask the Planner for tasks and admit only a plan that fits the approved scope and the pinned tree. */
export async function proposeGraphPlan(
	workspace: GraphWorkspace,
	input: ApprovedGraphInput,
	executors: ApprovedGraphExecutors,
	signal: AbortSignal,
): Promise<GraphTaskPlan> {
	workspace.checkScopes(new Map([["approved", input.files]]));
	const validate = (proposal: unknown) => {
		const plan = parseTaskPlan(proposal, input.files);
		workspace.checkScopes(new Map(plan.tasks.map(task => [task.id, task.files])));
		return plan;
	};
	return validate(await executors.plan(workspace, input, validate, signal));
}

interface CodeArtifact extends GraphCandidate {
	changes: GraphChangeSet;
}

export function readGraphRelease(store: GraphRunStore, runId: string): GraphRelease | undefined {
	const artifact = store.currentArtifacts(runId).get("release");
	const data = artifact && store.artifact(runId, artifact);
	return data ? (JSON.parse(data) as GraphRelease) : undefined;
}

/** Run an approved plan. Coder nodes run only for tasks recorded with the run. */
export async function runApprovedGraph(
	store: GraphRunStore,
	runId: string,
	workspace: GraphWorkspace,
	work: GraphWork,
	executors: ApprovedGraphExecutors,
	signal?: AbortSignal,
): Promise<void> {
	const coders = new Map(work.tasks.map(task => [task.nodeId, task]));
	const scopes = new Map(work.tasks.map(task => [task.nodeId, task.files]));
	const run = store.get(runId);
	const planned = run?.plan.nodes.filter(node => node.role === "coder").map(node => node.id) ?? [];
	if (planned.length !== coders.size || planned.some(id => !coders.has(id))) {
		throw new Error("Graph run plan does not match its approved tasks");
	}
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
	await driveGraphRun(
		store,
		runId,
		1,
		async ({ nodeId, inputs }, attemptSignal) => {
			const task = coders.get(nodeId);
			if (task) {
				const upstream = readCode(inputs).map(saved => saved.changes);
				const view = upstream.length > 0 ? await workspace.compose(scopes, upstream, attemptSignal) : undefined;
				const files: GraphFileView = {
					read: (file, readSignal) =>
						view ? workspace.readCandidateFile(view, file, readSignal) : workspace.readBaseFile(file, readSignal),
				};
				const patch = await executors.code(files, task, work, attemptSignal);
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
					const { treeId, exitCode } = await executors.test(workspace, candidate, attemptSignal);
					if (treeId !== candidate.treeId) throw new Error("Graph test ran against a different candidate");
					return JSON.stringify({ treeId, exitCode });
				}
				case "review": {
					const test = readArtifact<GraphCandidateEvidence["test"]>(testInput);
					if (test?.treeId !== candidate.treeId || test.exitCode !== 0) return "null";
					const review = {
						treeId: candidate.treeId,
						verdict: await executors.review(workspace, candidate, work, attemptSignal),
					};
					return JSON.stringify(review);
				}
				case "release": {
					const test = readArtifact<GraphCandidateEvidence["test"]>(testInput);
					const review = readArtifact<GraphCandidateEvidence["review"] | null>(reviewInput);
					return JSON.stringify(
						await workspace.release(candidate, { test, review: review ?? undefined }, attemptSignal),
					);
				}
				default:
					throw new Error("Unsupported Graph node");
			}
		},
		signal,
	);
}
