import * as fs from "node:fs/promises";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { prompt, TempDir } from "@oh-my-pi/pi-utils";
import { type DockerTestProfile, testCandidateInDocker } from "./docker-tester";
import { type OmpWorkerOptions, runOmpWorker } from "./omp-worker";
import coderPrompt from "./prompts/coder.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };
import type { ApprovedGraphExecutors, ApprovedGraphInput, ReviewVerdict } from "./workflow";

type WorkerProfile = Pick<OmpWorkerOptions, "bunPath" | "cliPath" | "home" | "provider" | "model" | "timeoutMs">;

function readTool(
	files: readonly string[],
	read: (file: string, candidate: boolean, signal: AbortSignal) => Promise<{ data: Uint8Array }>,
): RpcClientCustomTool {
	return {
		name: "kostomp_graph_read_file",
		label: "Read Graph file",
		description: "Read an approved file from the pinned Graph snapshot.",
		loadMode: "essential",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, version: { enum: ["base", "candidate"] } },
			required: ["path"],
			additionalProperties: false,
		},
		async execute(params, { signal }) {
			const { path, version } = params;
			if (typeof path !== "string" || !files.includes(path))
				throw new Error("Graph path is outside the approved scope");
			const { data } = await read(path, version === "candidate", signal);
			if (data.byteLength > 64 * 1024 || data.includes(0))
				throw new Error("Graph worker accepts UTF-8 files up to 64 KiB");
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
		},
	};
}

export function createApprovedGraphExecutors(worker: WorkerProfile, tester: DockerTestProfile): ApprovedGraphExecutors {
	const run = async (
		template: string,
		input: ApprovedGraphInput,
		tools: RpcClientCustomTool[],
		signal: AbortSignal,
	) => {
		await using tmp = await TempDir.create("@kostomp-graph-attempt-");
		const cwd = tmp.join("worker");
		await fs.mkdir(cwd);
		await runOmpWorker({
			...worker,
			cwd,
			signal,
			tools,
			prompt: prompt.render(template, { files: JSON.stringify(input.files), objective: input.objective }),
		});
	};
	return {
		async code(workspace, input, signal) {
			let patch: string | undefined;
			await run(
				coderPrompt,
				input,
				[
					readTool(input.files, (file, _candidate, signal) => workspace.readBaseFile(file, signal)),
					{
						name: "kostomp_graph_submit_patch",
						label: "Submit Graph patch",
						description: "Submit a Git unified diff.",
						loadMode: "essential",
						parameters: {
							type: "object",
							properties: { patch: { type: "string" } },
							required: ["patch"],
							additionalProperties: false,
						},
						execute(params) {
							if (
								patch ||
								typeof params.patch !== "string" ||
								!params.patch.trim() ||
								Buffer.byteLength(params.patch) > 512 * 1024
							) {
								throw new Error("Submit one nonempty Graph patch up to 512 KiB");
							}
							patch = params.patch;
							return "Patch recorded for host validation";
						},
					},
				],
				signal,
			);
			if (!patch) throw new Error("Coder did not submit a Graph patch");
			return patch;
		},
		test: (workspace, candidate, signal) => testCandidateInDocker(workspace, candidate, tester, signal),
		async review(workspace, candidate, input, signal) {
			let verdict: ReviewVerdict | undefined;
			await run(
				reviewerPrompt,
				input,
				[
					readTool(input.files, (file, proposed, signal) =>
						proposed
							? workspace.readCandidateFile(candidate, file, signal)
							: workspace.readBaseFile(file, signal),
					),
					{
						name: "kostomp_graph_review",
						label: "Review Graph candidate",
						description: "Submit a review verdict.",
						loadMode: "essential",
						parameters: {
							type: "object",
							properties: { verdict: { enum: ["accepted", "changes_requested"] } },
							required: ["verdict"],
							additionalProperties: false,
						},
						execute(params) {
							if (verdict || (params.verdict !== "accepted" && params.verdict !== "changes_requested"))
								throw new Error("Submit one valid Graph verdict");
							verdict = params.verdict;
							return "Review recorded";
						},
					},
				],
				signal,
			);
			if (!verdict) throw new Error("Reviewer did not submit a verdict");
			return verdict;
		},
	};
}
