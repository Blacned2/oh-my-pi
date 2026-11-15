import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RpcClientCustomTool } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { getAgentDbPath, getDbBusyTimeoutMs, isEnoent, prompt, TempDir, toError } from "@oh-my-pi/pi-utils";
import { type DockerTestProfile, testCandidateInDocker } from "./docker-tester";
import { type OmpWorkerOptions, runOmpWorker } from "./omp-worker";
import coderPrompt from "./prompts/coder.md" with { type: "text" };
import plannerPrompt from "./prompts/planner.md" with { type: "text" };
import reminderPrompt from "./prompts/reminder.md" with { type: "text" };
import reviewerPrompt from "./prompts/reviewer.md" with { type: "text" };
import { cleanDiagnostic, type GraphReview, parseGraphReview } from "./review";
import type { GraphTaskPlan } from "./task-plan";
import type { ApprovedGraphExecutors, GraphLog } from "./workflow";

/** `home` is the source profile. Each attempt runs in its own copy so concurrent workers share no writable state. */
type WorkerProfile = Pick<OmpWorkerOptions, "bunPath" | "cliPath" | "home" | "provider" | "model" | "timeoutMs">;

const maxListedEntries = 500;
const maxReplyBytes = 64 * 1024;
const maxReviewDiff = 48_000;

/**
 * Copy a SQLite database that another process may be writing. The main file of a WAL database misses
 * uncheckpointed writes and can be torn mid-checkpoint; `VACUUM INTO` writes one consistent snapshot.
 * A missing source copies nothing.
 */
export async function snapshotDatabase(source: string, destination: string): Promise<void> {
	if (!(await Bun.file(source).exists())) return;
	const db = new Database(source, { readonly: true });
	try {
		db.run(`PRAGMA busy_timeout = ${getDbBusyTimeoutMs()}`);
		db.run("VACUUM INTO ?", [destination]);
	} finally {
		db.close();
	}
}

/** Accept the path spellings models commonly use: `.`/`./` for the root, a leading `./`, `\` separators and repeated `/`. */
export function normaliseGraphPath(input: string): string {
	const slashed = input.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
	return slashed === "." ? "" : slashed.replace(/^(?:\.\/)+/, "");
}

/** Lines from `offset` (1-based), at most `limit` lines and 64 KiB, ending with a continuation line when lines remain. */
export function windowLines(text: string, offset = 1, limit = Number.POSITIVE_INFINITY): string {
	const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	if (offset > Math.max(lines.length, 1)) throw new Error(`offset ${offset} is past the last line (${lines.length})`);
	let end = offset - 1;
	let bytes = 0;
	while (end < lines.length && end - offset + 1 < limit) {
		bytes += Buffer.byteLength(lines[end]);
		if (bytes > maxReplyBytes) break;
		end++;
	}
	if (end < offset && lines.length > 0) throw new Error(`Line ${offset} is longer than 64 KiB`);
	const window = lines.slice(offset - 1, end).join("");
	if (end === lines.length) return window;
	return `${window}[lines ${offset}–${end} of ${lines.length}; continue with offset ${end + 1}]`;
}

function positiveInteger(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

/** `versioned` exposes `version`, which only the Reviewer can use: it alone sees a candidate. */
export function readTool(
	read: (file: string, candidate: boolean, signal: AbortSignal) => Promise<{ data: Uint8Array }>,
	list: (directory: string, candidate: boolean) => string[],
	versioned = false,
): RpcClientCustomTool {
	const version = {
		enum: ["base", "candidate"],
		description: "base (default) reads the pinned repository; candidate reads the change under review",
	};
	return {
		name: "kostomp_graph_read_file",
		label: "Read Graph file",
		description:
			"Read a file from the pinned Graph repository snapshot. An empty path or a path ending in / lists that directory instead. A reply holds at most 64 KiB; use offset and limit to read the rest.",
		loadMode: "essential",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				offset: {
					type: "integer",
					minimum: 1,
					description: "First line to read (1-based); for a directory, the first entry to list",
				},
				limit: { type: "integer", minimum: 1, description: "Maximum number of lines or entries to return" },
				...(versioned ? { version } : {}),
			},
			required: ["path"],
			additionalProperties: false,
		},
		async execute(params, { signal }) {
			if (typeof params.path !== "string") throw new Error("Graph path must be a repository-relative string");
			const file = normaliseGraphPath(params.path);
			const offset = positiveInteger(params.offset, "offset");
			const limit = positiveInteger(params.limit, "limit");
			const candidate = versioned && params.version === "candidate";
			if (file === "" || file.endsWith("/")) {
				const entries = list(file, candidate);
				const first = offset ?? 1;
				if (first > Math.max(entries.length, 1)) {
					throw new Error(`offset ${first} is past the last entry (${entries.length})`);
				}
				const last = Math.min(entries.length, first - 1 + Math.min(limit ?? maxListedEntries, maxListedEntries));
				const shown = entries.slice(first - 1, last).join("\n");
				if (last === entries.length) return shown;
				return `${shown}\n[entries ${first}–${last} of ${entries.length}; continue with offset ${last + 1}]`;
			}
			// Directories are also snapshot paths, so they are recognised only once a read fails.
			const directory = () => {
				try {
					if (list(file, candidate).length > 0)
						return new Error(`${file} is a directory; add a trailing / to list it`);
				} catch {}
				return undefined;
			};
			let data: Uint8Array;
			try {
				({ data } = await read(file, candidate, signal));
			} catch (error) {
				throw directory() ?? error;
			}
			let text: string | undefined;
			if (!data.includes(0)) {
				try {
					text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
				} catch {}
			}
			if (text === undefined) throw directory() ?? new Error("Graph worker reads UTF-8 text files only");
			return windowLines(text, offset, limit);
		},
	};
}

export function createApprovedGraphExecutors(worker: WorkerProfile, tester: DockerTestProfile): ApprovedGraphExecutors {
	const run = async (
		template: string,
		context: Record<string, string>,
		tools: RpcClientCustomTool[],
		result: { tool: string; isDone: () => boolean },
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
		if (!(await Bun.file(workerDb).exists())) await snapshotDatabase(getAgentDbPath(), workerDb);
		const transcript: string[] = [];
		// Each write re-sanitises and commits the whole transcript, so live updates go out at most once a second.
		let pending: NodeJS.Timeout | undefined;
		const flush = () => {
			pending = undefined;
			try {
				log?.(transcript.join("\n"));
			} catch {
				// A failed live write must not escape the timer; the final write below still reports it.
			}
		};
		try {
			await runOmpWorker({
				...worker,
				home,
				cwd,
				signal,
				tools,
				transcript,
				onTranscript: () => {
					if (log) pending ??= setTimeout(flush, 1000);
				},
				prompt: prompt.render(template, context),
				isDone: result.isDone,
				reminder: prompt.render(reminderPrompt, { tool: result.tool }),
			});
		} finally {
			clearTimeout(pending);
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
				{ tool: "kostomp_graph_submit_plan", isDone: () => accepted !== undefined },
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
				{ tool: "kostomp_graph_submit_patch", isDone: () => submission !== undefined },
				signal,
				log,
			);
			if (!submission) throw rejection ?? new Error("Coder did not submit a Graph patch");
			return await submission;
		},
		test: (workspace, candidate, signal) => testCandidateInDocker(workspace, candidate, tester, signal),
		async review(workspace, candidate, work, signal, log) {
			let review: GraphReview | undefined;
			const diff = cleanDiagnostic(workspace.candidatePatch(candidate));
			await run(
				reviewerPrompt,
				{
					objective: work.objective,
					tasks: JSON.stringify(work.tasks.map(({ title, brief, files }) => ({ title, brief, files }))),
					diff: diff.slice(0, maxReviewDiff),
					diffTruncated: diff.length > maxReviewDiff ? "true" : "",
				},
				[
					readTool(
						(file, proposed, signal) =>
							proposed
								? workspace.readCandidateFile(candidate, file, signal)
								: workspace.readBaseFile(file, signal),
						(directory, proposed) => workspace.list(directory, proposed ? candidate : undefined),
						true,
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
				{ tool: "kostomp_graph_review", isDone: () => review !== undefined },
				signal,
				log,
			);
			if (!review) throw new Error("Reviewer did not submit a review");
			return review;
		},
	};
}
