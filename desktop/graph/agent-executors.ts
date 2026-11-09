import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isEnoent, prompt, TempDir } from "@oh-my-pi/pi-utils";
import { type DockerTestProfile, testCandidateInDocker } from "./docker-tester";
import { type OmpWorkerOptions, runOmpWorker } from "./omp-worker";
import coderPrompt from "./prompts/coder.md" with { type: "text" };
import plannerPrompt from "./prompts/planner.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };
import type { GraphTaskPlan } from "./task-plan";
import type { ApprovedGraphExecutors, GraphLog, ReviewVerdict } from "./workflow";

/** `home` is the source profile. Each attempt runs in its own copy so concurrent workers share no writable state. */
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
		context: Record<string, string>,
		tools: RpcClientCustomTool[],
		signal: AbortSignal,
		log?: GraphLog,
	) => {
		await using tmp = await TempDir.create("@kostomp-graph-attempt-");
		const cwd = tmp.join("worker");
		const home = tmp.join("home");
		await fs.mkdir(cwd);
		const agentDir = path.join(".omp", "agent");
		try {
			await fs.cp(path.join(worker.home, agentDir), path.join(home, agentDir), { recursive: true });
		} catch (error) {
			if (isEnoent(error)) throw new Error(`Graph worker profile is missing at ${path.join(worker.home, agentDir)}`);
			throw error;
		}
		const transcript: string[] = [];
		try {
			await runOmpWorker({
				...worker,
				home,
				cwd,
				signal,
				tools,
				transcript,
				prompt: prompt.render(template, context),
			});
		} finally {
			if (transcript.length > 0) log?.(transcript.join("\n"));
		}
	};
	return {
		async plan(workspace, input, validate, signal) {
			let accepted: GraphTaskPlan | undefined;
			const task = {
				type: "object",
				properties: {
					id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" },
					title: { type: "string" },
					brief: { type: "string" },
					dependsOn: { type: "array", items: { type: "string" } },
					files: { type: "array", items: { type: "string" } },
				},
				required: ["id", "title", "brief", "dependsOn", "files"],
				additionalProperties: false,
			};
			await run(
				plannerPrompt,
				{ files: JSON.stringify(input.files), objective: input.objective },
				[
					readTool(input.files, (file, _candidate, signal) => workspace.readBaseFile(file, signal)),
					{
						name: "kostomp_graph_submit_plan",
						label: "Submit Graph plan",
						description: "Submit Coder tasks, their dependencies and exclusive file ownership.",
						loadMode: "essential",
						parameters: {
							type: "object",
							properties: { tasks: { type: "array", minItems: 1, maxItems: 16, items: task } },
							required: ["tasks"],
							additionalProperties: false,
						},
						execute(params) {
							if (accepted) throw new Error("A Graph plan was already accepted");
							accepted = validate(params);
							return "Plan recorded for user approval";
						},
					},
				],
				signal,
			);
			if (!accepted) throw new Error("Planner did not submit a valid Graph plan");
			return accepted;
		},
		async code(view, task, work, signal, log) {
			let patch: string | undefined;
			await run(
				coderPrompt,
				{
					files: JSON.stringify(work.files),
					owned: JSON.stringify(task.files),
					objective: work.objective,
					title: task.title,
					brief: task.brief,
				},
				[
					readTool(work.files, (file, _candidate, signal) => view.read(file, signal)),
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
				log,
			);
			if (!patch) throw new Error("Coder did not submit a Graph patch");
			return patch;
		},
		test: (workspace, candidate, signal) => testCandidateInDocker(workspace, candidate, tester, signal),
		async review(workspace, candidate, work, signal, log) {
			let verdict: ReviewVerdict | undefined;
			await run(
				reviewerPrompt,
				{
					files: JSON.stringify(work.files),
					objective: work.objective,
					tasks: JSON.stringify(work.tasks.map(({ title, brief, files }) => ({ title, brief, files }))),
				},
				[
					readTool(work.files, (file, proposed, signal) =>
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
				log,
			);
			if (!verdict) throw new Error("Reviewer did not submit a verdict");
			return verdict;
		},
	};
}
