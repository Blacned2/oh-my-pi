import { type } from "@oh-my-pi/omptype";
import type { GraphTestResult } from "./docker-tester";
import { repoPathPrefixes } from "./repo-path";
import type { GraphRunStore } from "./run-store";
import { driveGraphRun } from "./scheduler";
import type { GraphCandidate, GraphCandidateEvidence, GraphChangeSet, GraphRelease, GraphWorkspace } from "./workspace";

const inputSchema = type({ source: "string > 0", objective: "0 < string <= 8192", files: "string[]" });
export type ApprovedGraphInput = typeof inputSchema.infer;
export type ReviewVerdict = NonNullable<GraphCandidateEvidence["review"]>["verdict"];

export const approvedGraphPlan = {
	version: 1,
	nodes: [
		{ id: "code", role: "coder", dependsOn: [], maxAttempts: 3 },
		{ id: "test", role: "tester", dependsOn: ["code"], maxAttempts: 3 },
		{ id: "review", role: "reviewer", dependsOn: ["code", "test"], maxAttempts: 3 },
		{ id: "release", role: "gate", dependsOn: ["code", "test", "review"], maxAttempts: 3 },
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

interface CodeArtifact extends GraphCandidate {
	changes: GraphChangeSet;
}

export function readGraphRelease(store: GraphRunStore, runId: string): GraphRelease | undefined {
	const artifact = store.currentArtifacts(runId).get("release");
	const data = artifact && store.artifact(runId, artifact);
	return data ? (JSON.parse(data) as GraphRelease) : undefined;
}

/** Run the first Desktop workflow from an explicitly approved objective and exact file scope. */
export async function runApprovedGraph(
	store: GraphRunStore,
	runId: string,
	workspace: GraphWorkspace,
	input: ApprovedGraphInput,
	executors: ApprovedGraphExecutors,
	signal?: AbortSignal,
): Promise<void> {
	let candidate: GraphCandidate | undefined;
	let candidateArtifact: string | undefined;
	const readArtifact = <T>(id: string): T => {
		const data = store.artifact(runId, id);
		if (data === null) throw new Error("Graph dependency artifact is missing");
		return JSON.parse(data) as T;
	};
	const scopes = new Map([["code", input.files]]);
	await driveGraphRun(
		store,
		runId,
		1,
		async ({ nodeId, inputs }, attemptSignal) => {
			if (nodeId === "code") {
				const patch = await executors.code(workspace, input, attemptSignal);
				const changes = await workspace.captureChangeSet(nodeId, input.files, patch, attemptSignal);
				const proposed = await workspace.compose(scopes, [changes], attemptSignal);
				return JSON.stringify({ ...proposed, changes } satisfies CodeArtifact);
			}
			if (!candidate || candidateArtifact !== inputs[0]) {
				const saved = readArtifact<CodeArtifact>(inputs[0]);
				if (saved.baseSha !== workspace.baseSha) throw new Error("Graph candidate base changed");
				candidate = await workspace.compose(scopes, [saved.changes], attemptSignal);
				if (candidate.treeId !== saved.treeId) throw new Error("Graph candidate could not be reproduced");
				candidateArtifact = inputs[0];
			}
			switch (nodeId) {
				case "test": {
					const { treeId, exitCode } = await executors.test(workspace, candidate, attemptSignal);
					if (treeId !== candidate.treeId) throw new Error("Graph test ran against a different candidate");
					return JSON.stringify({ treeId, exitCode });
				}
				case "review": {
					const test = readArtifact<GraphCandidateEvidence["test"]>(inputs[1]);
					if (test?.treeId !== candidate.treeId || test.exitCode !== 0) return "null";
					const review = {
						treeId: candidate.treeId,
						verdict: await executors.review(workspace, candidate, input, attemptSignal),
					};
					return JSON.stringify(review);
				}
				case "release": {
					const test = readArtifact<GraphCandidateEvidence["test"]>(inputs[1]);
					const review = readArtifact<GraphCandidateEvidence["review"] | null>(inputs[2]);
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
