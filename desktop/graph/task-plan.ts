import { type } from "@oh-my-pi/omptype";
import { type GraphPlan, parseGraphPlan } from "./plan";
import { repoPathPrefixes, writablePathKey } from "./repo-path";

const MAX_TASKS = 16;
const MAX_TASK_FILES = 32;

const taskSchema = type({
	id: /^[a-z][a-z0-9-]{0,31}$/,
	title: "0 < string <= 200",
	brief: "0 < string <= 4096",
	dependsOn: "string[]",
	files: "string[]",
});
const proposalSchema = type({ tasks: taskSchema.array().atLeastLength(1).atMostLength(MAX_TASKS) });

/** One Coder task with exclusive write ownership of its files. */
export interface GraphTask {
	id: string;
	title: string;
	brief: string;
	dependsOn: string[];
	files: string[];
}

export interface GraphTaskPlan {
	version: 1;
	/** Prerequisites first. */
	tasks: GraphTask[];
}

export const coderNodeId = (taskId: string): string => `code-${taskId}`;

/** Windows identities a Coder writes, plus their parent directories, for the dispatch-time overlap check. */
export interface WriteScopeKeys {
	files: Set<string>;
	directories: Set<string>;
}

export function writeScopeKeys(files: readonly string[]): WriteScopeKeys {
	const keys: WriteScopeKeys = { files: new Set(), directories: new Set() };
	for (const file of files) {
		const [key] = writablePathKey(file);
		keys.files.add(key);
		for (const [prefix] of repoPathPrefixes(file).slice(0, -1)) keys.directories.add(prefix);
	}
	return keys;
}

/** True when the scopes share a file identity or one writes a path the other uses as a directory. */
export function writeScopesOverlap(a: WriteScopeKeys, b: WriteScopeKeys): boolean {
	for (const key of a.files) if (b.files.has(key) || b.directories.has(key)) return true;
	for (const key of b.files) if (a.directories.has(key)) return true;
	return false;
}

/**
 * Admit a proposed task plan against the user-approved file scope. Every written path must be an approved
 * spelling, each Windows file identity has one owner, and dependencies form a DAG.
 */
export function parseTaskPlan(value: unknown, approvedFiles: readonly string[]): GraphTaskPlan {
	const proposal = proposalSchema.assert(value);
	const approved = new Map(approvedFiles.map(file => writablePathKey(file)));
	const tasks = new Map<string, GraphTask>();
	for (const task of proposal.tasks) {
		if (tasks.has(task.id)) throw new Error(`Graph plan repeats task ${task.id}`);
		tasks.set(task.id, {
			id: task.id,
			title: task.title.trim(),
			brief: task.brief.trim(),
			dependsOn: [...task.dependsOn],
			files: [...task.files],
		});
	}
	const owners = new Map<string, string>();
	const directories = new Set<string>();
	for (const task of tasks.values()) {
		if (!task.title || !task.brief) throw new Error(`Graph task ${task.id} needs a title and brief`);
		if (new Set(task.dependsOn).size !== task.dependsOn.length) {
			throw new Error(`Graph task ${task.id} repeats a dependency`);
		}
		for (const dependency of task.dependsOn) {
			if (dependency === task.id) throw new Error(`Graph task ${task.id} depends on itself`);
			if (!tasks.has(dependency)) throw new Error(`Graph task ${task.id} depends on unknown task ${dependency}`);
		}
		if (task.files.length < 1 || task.files.length > MAX_TASK_FILES) {
			throw new Error(`Graph task ${task.id} must own 1–${MAX_TASK_FILES} files`);
		}
		for (const file of task.files) {
			const [key, spelling] = writablePathKey(file);
			const allowed = approved.get(key);
			if (allowed === undefined) throw new Error(`Graph task ${task.id} writes ${file} outside the approved scope`);
			if (allowed !== spelling) {
				throw new Error(`Graph task ${task.id} writes ${file}, which resolves to approved ${allowed} on Windows`);
			}
			const owner = owners.get(key);
			if (owner !== undefined) throw new Error(`Graph tasks ${owner} and ${task.id} both write ${allowed}`);
			const prefixes = repoPathPrefixes(file);
			const parent = prefixes.slice(0, -1).find(([prefix]) => owners.has(prefix));
			if (directories.has(key) || parent) {
				throw new Error(`Graph task ${task.id} writes ${file}, which overlaps another write scope`);
			}
			for (const [prefix] of prefixes.slice(0, -1)) directories.add(prefix);
			owners.set(key, task.id);
		}
	}
	const ordered: GraphTask[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (task: GraphTask, path: string[]): void => {
		const mark = state.get(task.id);
		if (mark === "done") return;
		if (mark === "visiting") {
			const cycle = [...path.slice(path.indexOf(task.id)), task.id];
			throw new Error(`Graph task dependencies contain a cycle: ${cycle.join(" → ")}`);
		}
		state.set(task.id, "visiting");
		for (const dependency of task.dependsOn) visit(tasks.get(dependency)!, [...path, task.id]);
		state.set(task.id, "done");
		ordered.push(task);
	};
	for (const task of tasks.values()) visit(task, []);
	return { version: 1, tasks: ordered };
}

/** The identity the user approves. Computed from the normalized plan. */
export function taskPlanHash(plan: GraphTaskPlan): string {
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex");
}

/**
 * Coder nodes receive every transitive prerequisite's change set, so a dependent Coder reads upstream results.
 * Test, review and release consume all Coder artifacts in prerequisite order.
 */
export function graphPlanForTasks(plan: GraphTaskPlan): GraphPlan {
	const closure = new Map<string, Set<string>>();
	for (const task of plan.tasks) {
		const upstream = new Set<string>();
		for (const dependency of task.dependsOn) {
			upstream.add(dependency);
			for (const id of closure.get(dependency)!) upstream.add(id);
		}
		closure.set(task.id, upstream);
	}
	const coders = plan.tasks.map(task => coderNodeId(task.id));
	return parseGraphPlan({
		version: 1,
		nodes: [
			...plan.tasks.map(task => ({
				id: coderNodeId(task.id),
				role: "coder",
				dependsOn: plan.tasks
					.filter(other => closure.get(task.id)!.has(other.id))
					.map(other => coderNodeId(other.id)),
				maxAttempts: 3,
			})),
			{ id: "test", role: "tester", dependsOn: coders, maxAttempts: 3 },
			{ id: "review", role: "reviewer", dependsOn: [...coders, "test"], maxAttempts: 3 },
			{ id: "release", role: "gate", dependsOn: [...coders, "test", "review"], maxAttempts: 3 },
		],
	});
}
