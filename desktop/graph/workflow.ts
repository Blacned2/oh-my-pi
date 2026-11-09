import { type } from "@oh-my-pi/omptype";
import type { GraphTestResult } from "./docker-tester";
import { repoPathPrefixes } from "./repo-path";
import type { GraphRunStore } from "./run-store";
import { driveGraphRun } from "./scheduler";
import { type GraphCandidate, type GraphCandidateEvidence, type GraphRelease, GraphWorkspace } from "./workspace";

const inputSchema = type({ source: "string > 0", objective: "0 < string <= 8192", files: "string[]" });
export type ApprovedGraphInput = typeof inputSchema.infer;
export type ReviewVerdict = NonNullable<GraphCandidateEvidence["review"]>["verdict"];

export const approvedGraphPlan = {
	version: 1,
	nodes: [
		{ id: "code", role: "coder", dependsOn: [], maxAttempts: 1 },
		{ id: "test", role: "tester", dependsOn: ["code"], maxAttempts: 1 },
		{ id: "review", role: "reviewer", dependsOn: ["code", "test"], maxAttempts: 1 },
		{ id: "release", role: "gate", dependsOn: ["code", "test", "review"], maxAttempts: 1 },
	],
};

export function parseApprovedGraphInput(value: unknown): ApprovedGraphInput {
	const input = inputSchema.assert(value);
	if (!input.objective.trim() || input.files.length < 1 || input.files.length > 32) {
		throw new Error("Graph requires an objective and 1–32 approved file paths");
	}
	const paths = input.files.map(file => repoPathPrefixes(file).at(-1)![0]);
	if (
		paths.some((file, index) =>
			paths.some((other, i) => i !== index && (other === file || other.startsWith(`${file}/`))),
		)
	) {
		throw new Error("Approved Graph file paths overlap");
	}
	return { ...input, files: [...input.files] };
}

export interface ApprovedGraphExecutors {
	code(workspace: GraphWorkspace, input: ApprovedGraphInput, signal: AbortSignal): Promise<string>;
	test(workspace: GraphWorkspace, candidate: GraphCandidate, signal: AbortSignal): Promise<GraphTestResult>;
	review(
		workspace: GraphWorkspace,
		candidate: GraphCandidate,
		input: ApprovedGraphInput,
		signal: AbortSignal,
	): Promise<ReviewVerdict>;
}

export interface ApprovedGraphResult {
	sourceRoot: string;
	release?: GraphRelease;
}

/** Run the first Desktop workflow from an explicitly approved objective and exact file scope. */
export async function runApprovedGraph(
	store: GraphRunStore,
	runId: string,
	input: ApprovedGraphInput,
	executors: ApprovedGraphExecutors,
	signal?: AbortSignal,
): Promise<ApprovedGraphResult> {
	await using workspace = await GraphWorkspace.pin(input.source, signal);
	let candidate: GraphCandidate | undefined;
	let test: GraphTestResult | undefined;
	let review: GraphCandidateEvidence["review"];
	let release: GraphRelease | undefined;
	await driveGraphRun(
		store,
		runId,
		1,
		async ({ nodeId }, attemptSignal) => {
			if (nodeId === "code") {
				const patch = await executors.code(workspace, input, attemptSignal);
				const changes = await workspace.captureChangeSet(nodeId, input.files, patch, attemptSignal);
				candidate = await workspace.compose(new Map([[nodeId, input.files]]), [changes], attemptSignal);
				return JSON.stringify({ ...candidate, files: changes.changes.map(change => change.path) });
			}
			if (!candidate) throw new Error("Graph candidate is unavailable");
			switch (nodeId) {
				case "test":
					test = await executors.test(workspace, candidate, attemptSignal);
					return JSON.stringify(test);
				case "review":
					if (test?.treeId !== candidate.treeId || test.exitCode !== 0) return JSON.stringify({ skipped: true });
					review = {
						treeId: candidate.treeId,
						verdict: await executors.review(workspace, candidate, input, attemptSignal),
					};
					return JSON.stringify(review);
				case "release":
					release = await workspace.release(candidate, { test, review }, attemptSignal);
					return JSON.stringify(release);
				default:
					throw new Error("Unsupported Graph node");
			}
		},
		signal,
	);
	return {
		sourceRoot: workspace.sourceRoot,
		release: store.currentArtifacts(runId).has("release") ? release : undefined,
	};
}
