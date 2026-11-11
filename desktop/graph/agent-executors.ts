import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { getAgentDbPath, isEnoent, prompt, TempDir, toError } from "@oh-my-pi/pi-utils";
import { type DockerTestProfile, testCandidateInDocker } from "./docker-tester";
import { type OmpWorkerOptions, runOmpWorker } from "./omp-worker";
import coderPrompt from "./prompts/coder.md" with { type: "text" };
import plannerPrompt from "./prompts/planner.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };
import { type GraphReview, parseGraphReview } from "./review";
import type { GraphTaskPlan } from "./task-plan";
import type { ApprovedGraphExecutors, GraphLog } from "./workflow";

/** `home` is the source profile. Each attempt runs in its own copy so concurrent workers share no writable state. */
type WorkerProfile = Pick<OmpWorkerOptions, "bunPath" | "cliPath" | "home" | "provider" | "model" | "timeoutMs">;

const maxListedEntries = 500;

function readTool(
	read: (file: string, candidate: boolean, signal: AbortSignal) => Promise<{ data: Uint8Array }>,
	list: (directory: string, candidate: boolean) => string[],
): RpcClientCustomTool {
	return {
		name: "kostomp_graph_read_file",
		label: "Read Graph file",
		description:
			"Read a file from the pinned Graph repository snapshot. An empty path or a path ending in / lists that directory instead.",
		loadMode: "essential",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, version: { enum: ["base", "candidate"] } },
			required: ["path"],
			additionalProperties: false,
		},
		async execute(params, { signal }) {
			const { path, version } = params;
			if (typeof path !== "string") throw new Error("Graph path must be a repository-relative string");
			if (path === "" || path.endsWith("/")) {
				const entries = list(path, version === "candidate");
				return entries.length > maxListedEntries
					? [...entries.slice(0, maxListedEntries), `… ${entries.length - maxListedEntries} more`].join("\n")
					: entries.join("\n");
			}
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
		const workerAgentDir = path.join(home, agentDir);
		try {
			await fs.cp(path.join(worker.home, agentDir), workerAgentDir, { recursive: true });
		} catch (error) {
			if (!isEnoent(error)) throw error;
			await fs.mkdir(workerAgentDir, { recursive: true });
		}
		// A profile without its own credentials uses the accounts already signed in to the app.
		const workerDb = getAgentDbPath(workerAgentDir);
		if (!(await Bun.file(workerDb).exists())) {
			try {
				await fs.copyFile(getAgentDbPath(), workerDb);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
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
				onTranscript: () => log?.(transcript.join("\n")),
				prompt: prompt.render(template, context),
			});
		} finally {
			if (transcript.length > 0) log?.(transcript.join("\n"));
		}
	};
	return {
		async plan(workspace, input, validate, signal, log) {
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
				{ objective: input.objective },
				[
					readTool(
						(file, _candidate, signal) => workspace.readBaseFile(file, signal),
						directory => workspace.list(directory),
					),
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
				log,
			);
			if (!accepted) throw new Error("Planner did not submit a valid Graph plan");
			return accepted;
		},
		async code(view, task, work, signal, log, repair, context) {
			let submission: Promise<string> | undefined;
			let rejection: Error | undefined;
			await run(
				coderPrompt,
				{
					owned: JSON.stringify(task.files),
					objective: work.objective,
					title: task.title,
					brief: task.brief,
					context: context ? JSON.stringify(context) : "",
					repair: repair ? JSON.stringify(repair) : "",
				},
				[
					readTool(
						(file, _candidate, signal) => view.read(file, signal),
						directory => view.list(directory),
					),
					{
						name: "kostomp_graph_submit_patch",
						label: "Submit Graph patch",
						description: "Validate and submit a Git unified diff. Correct and resubmit any rejected patch.",
						loadMode: "essential",
						parameters: {
							type: "object",
							properties: { patch: { type: "string" } },
							required: ["patch"],
							additionalProperties: false,
						},
						async execute({ patch }, { signal }) {
							if (submission) throw new Error("A Graph patch is already being validated or accepted");
							if (typeof patch !== "string" || !patch.trim() || Buffer.byteLength(patch) > 512 * 1024) {
								throw new Error("Submit a nonempty Graph patch up to 512 KiB");
							}
							submission = view.validatePatch(patch, signal).then(() => patch);
							try {
								await submission;
							} catch (error) {
								submission = undefined;
								rejection = toError(error);
								throw rejection;
							}
							return "Patch validated against the pinned base and approved files";
						},
					},
				],
				signal,
				log,
			);
			if (!submission) throw rejection ?? new Error("Coder did not submit a Graph patch");
			return await submission;
		},
		test: (workspace, candidate, signal) => testCandidateInDocker(workspace, candidate, tester, signal),
		async review(workspace, candidate, work, signal, log) {
			let review: GraphReview | undefined;
			await run(
				reviewerPrompt,
				{
					objective: work.objective,
					tasks: JSON.stringify(work.tasks.map(({ title, brief, files }) => ({ title, brief, files }))),
				},
				[
					readTool(
						(file, proposed, signal) =>
							proposed
								? workspace.readCandidateFile(candidate, file, signal)
								: workspace.readBaseFile(file, signal),
						(directory, proposed) => workspace.list(directory, proposed ? candidate : undefined),
					),
					{
						name: "kostomp_graph_review",
						label: "Review Graph candidate",
						description: "Submit a review verdict and file findings when changes are required.",
						loadMode: "essential",
						parameters: {
							type: "object",
							properties: {
								verdict: { enum: ["accepted", "changes_requested"] },
								findings: {
									type: "array",
									maxItems: 8,
									items: {
										type: "object",
										properties: {
											file: { type: "string" },
											issue: { type: "string" },
											expectedChange: { type: "string" },
										},
										required: ["file", "issue", "expectedChange"],
										additionalProperties: false,
									},
								},
							},
							required: ["verdict", "findings"],
							additionalProperties: false,
						},
						execute(params) {
							if (review) throw new Error("Submit one valid Graph review");
							review = parseGraphReview(
								params,
								work.tasks.flatMap(task => task.files),
							);
							return "Review recorded";
						},
					},
				],
				signal,
				log,
			);
			if (!review) throw new Error("Reviewer did not submit a review");
			return review;
		},
	};
}
