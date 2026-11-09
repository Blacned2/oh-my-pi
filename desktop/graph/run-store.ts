import type { Database } from "bun:sqlite";
import { openSqliteDatabaseSync } from "@oh-my-pi/pi-utils";
import { type GraphNode, type GraphPlan, parseGraphPlan } from "./plan";
import { coderNodeId, type GraphTask, type WriteScopeKeys, writeScopeKeys, writeScopesOverlap } from "./task-plan";

type NodeStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";

interface NodeState {
	status: NodeStatus;
	attempt: number;
	usedAttempts: number;
	/** Artifact hashes, in the dependency order of the plan. */
	inputs?: string[];
	artifact?: string;
	error?: string;
}

export interface GraphRun {
	id: string;
	plan: GraphPlan;
	sequence: number;
	cancelled: boolean;
	nodes: Record<string, NodeState>;
	context?: GraphRunContext;
}

export interface GraphRunContext {
	sourceRoot: string;
	baseSha: string;
	objective: string;
	files: string[];
	profileHash: string;
	/** The user-approved task plan. Absent on runs saved with the fixed single-Coder plan. */
	tasks?: GraphTask[];
	/** `taskPlanHash()` of the plan the user approved. */
	planHash?: string;
	approvedAt?: number;
}

export interface GraphAttempt {
	runId: string;
	nodeId: string;
	attempt: number;
	inputs: string[];
}

export interface GraphRunEvent {
	sequence: number;
	kind: "created" | "claimed" | "succeeded" | "failed" | "interrupted" | "retried" | "invalidated" | "cancelled";
	nodeId?: string;
	attempt?: number;
}

type RecordEvent = (kind: GraphRunEvent["kind"], nodeId?: string) => void;
const MAX_ARTIFACT_BYTES = 1024 * 1024;

/** Re-derive each Coder's write scope from the approved tasks. The plan's earlier admission is not trusted. */
function coderScopes(run: GraphRun): Map<string, WriteScopeKeys> | undefined {
	const tasks = run.context?.tasks;
	return tasks && new Map(tasks.map(task => [coderNodeId(task.id), writeScopeKeys(task.files)]));
}

/** Owns scheduler transitions, artifacts and the ordered event stream in one SQLite transaction. */
export class GraphRunStore implements Disposable {
	readonly #db: Database;

	constructor(file: string) {
		this.#db = openSqliteDatabaseSync(file, db => {
			db.exec(`
				PRAGMA synchronous = FULL;
				CREATE TABLE IF NOT EXISTS graph_runs (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
				CREATE TABLE IF NOT EXISTS graph_events (
					run_id TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
				);
				CREATE TABLE IF NOT EXISTS graph_artifacts (
					run_id TEXT NOT NULL, id TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY (run_id, id)
				);
			`);
			return db;
		});
	}

	[Symbol.dispose](): void {
		this.#db.close();
	}

	create(input: unknown, context?: GraphRunContext): GraphRun {
		const plan = parseGraphPlan(input);
		const run: GraphRun = {
			id: crypto.randomUUID(),
			plan,
			sequence: 0,
			cancelled: false,
			context,
			nodes: Object.fromEntries(
				plan.nodes.map(node => [node.id, { status: "queued", attempt: 0, usedAttempts: 0 }]),
			),
		};
		this.#db
			.transaction(() => {
				this.#record(run, "created");
				this.#db.run("INSERT INTO graph_runs (id, snapshot) VALUES (?, ?)", [run.id, JSON.stringify(run)]);
			})
			.immediate();
		return run;
	}

	get(runId: string): GraphRun | null {
		const row = this.#db
			.query<{ snapshot: string }, [string]>("SELECT snapshot FROM graph_runs WHERE id = ?")
			.get(runId);
		return row ? (JSON.parse(row.snapshot) as GraphRun) : null;
	}

	recent(): Pick<GraphRun, "id" | "context">[] {
		return this.#db
			.query<{ snapshot: string }, []>("SELECT snapshot FROM graph_runs ORDER BY rowid DESC LIMIT 50")
			.all()
			.map(({ snapshot }) => {
				const { id, context } = JSON.parse(snapshot) as GraphRun;
				return { id, context };
			});
	}

	readyNodes(run: GraphRun): string[] {
		return run.cancelled ? [] : this.#walk(run).ready.map(([node]) => node.id);
	}

	retryableNodes(run: GraphRun): string[] {
		if (run.cancelled || Object.values(run.nodes).some(state => state.status === "running")) return [];
		const { current } = this.#walk(run);
		return run.plan.nodes
			.filter(node => {
				const state = run.nodes[node.id];
				return (
					state.status !== "queued" &&
					state.usedAttempts < node.maxAttempts &&
					node.dependsOn.every(id => current.has(id))
				);
			})
			.map(node => node.id);
	}

	events(runId: string, after: number): GraphRunEvent[] {
		return this.#db
			.query<{ event: string }, [string, number]>(
				"SELECT event FROM graph_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT 256",
			)
			.all(runId, after)
			.map(row => JSON.parse(row.event) as GraphRunEvent);
	}

	artifact(runId: string, id: string): string | null {
		return (
			this.#db
				.query<{ content: string }, [string, string]>(
					"SELECT content FROM graph_artifacts WHERE run_id = ? AND id = ?",
				)
				.get(runId, id)?.content ?? null
		);
	}

	/** Results whose entire dependency chain is still current. */
	currentArtifacts(runId: string): Map<string, string> {
		const run = this.get(runId);
		if (!run) throw new Error("Unknown Graph run");
		return run.cancelled ? new Map() : this.#walk(run).current;
	}

	claimReady(runId: string, concurrency: number): GraphAttempt[] {
		if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("Invalid Graph concurrency");
		return this.#update(runId, (run, record) => {
			const claims: GraphAttempt[] = [];
			if (run.cancelled) return claims;
			let slots = concurrency - Object.values(run.nodes).filter(state => state.status === "running").length;
			const scopes = coderScopes(run);
			const runningCoders = run.plan.nodes
				.filter(node => node.role === "coder" && run.nodes[node.id].status === "running")
				.map(node => node.id);
			for (const [node, inputs] of this.#walk(run, record).ready) {
				if (slots <= 0) break;
				const { id: nodeId, role } = node;
				if (role === "coder") {
					const mine = scopes?.get(nodeId);
					// Without approved task scopes, Coders stay serialized.
					if (scopes ? !mine : runningCoders.length > 0) continue;
					if (mine && runningCoders.some(other => writeScopesOverlap(scopes!.get(other)!, mine))) continue;
					runningCoders.push(nodeId);
				}
				const state = run.nodes[nodeId];
				state.status = "running";
				state.attempt++;
				state.usedAttempts++;
				state.inputs = inputs;
				slots--;
				record("claimed", nodeId);
				claims.push({ runId, nodeId, attempt: state.attempt, inputs });
			}
			return claims;
		});
	}

	/** Accept a live attempt's output. An invalid artifact fails the attempt without publishing it. */
	complete(attempt: GraphAttempt, content: string): boolean {
		return this.#update(attempt.runId, (run, record) => {
			const state = this.#runningAttempt(run, attempt);
			if (!state) return false;
			if (Buffer.byteLength(content) > MAX_ARTIFACT_BYTES) {
				state.status = "failed";
				state.error = "Graph artifact exceeds 1 MiB";
				record("failed", attempt.nodeId);
				return true;
			}
			const id = new Bun.CryptoHasher("sha256").update(content).digest("hex");
			this.#db.run("INSERT OR IGNORE INTO graph_artifacts (run_id, id, content) VALUES (?, ?, ?)", [
				run.id,
				id,
				content,
			]);
			state.status = "succeeded";
			state.artifact = id;
			record("succeeded", attempt.nodeId);
			this.#walk(run, record);
			return true;
		});
	}

	fail(attempt: GraphAttempt, error: string): boolean {
		return this.#update(attempt.runId, (run, record) => {
			const state = this.#runningAttempt(run, attempt);
			if (!state) return false;
			state.status = "failed";
			state.error = error.slice(0, 2048);
			record("failed", attempt.nodeId);
			return true;
		});
	}

	/** An explicit retry at quiescence. Retry budget is per set of upstream artifacts. */
	retry(runId: string, nodeId: string): boolean {
		return this.#update(runId, (run, record) => {
			if (!this.retryableNodes(run).includes(nodeId)) return false;
			const state = run.nodes[nodeId];
			state.status = "queued";
			delete state.artifact;
			delete state.error;
			record("retried", nodeId);
			return true;
		});
	}

	cancel(runId: string): void {
		this.#update(runId, (run, record) => {
			if (run.cancelled) return;
			run.cancelled = true;
			for (const state of Object.values(run.nodes)) {
				if (state.status === "queued" || state.status === "running") state.status = "cancelled";
			}
			record("cancelled");
		});
	}

	/** Call once on adoption, after the host owns the run and previous workers have exited. */
	recoverInterrupted(runId: string): void {
		this.#update(runId, (run, record) => {
			for (const [nodeId, state] of Object.entries(run.nodes)) {
				if (state.status !== "running") continue;
				state.status = "interrupted";
				record("interrupted", nodeId);
			}
		});
	}

	#walk(run: GraphRun, record?: RecordEvent) {
		const current = new Map<string, string>();
		const ready: [GraphNode, string[]][] = [];
		for (const node of run.plan.nodes) {
			const inputs = node.dependsOn.flatMap(dependency => current.get(dependency) ?? []);
			if (inputs.length !== node.dependsOn.length) continue;
			const state = run.nodes[node.id];
			if (state.inputs?.some((artifact, index) => artifact !== inputs[index])) {
				if (!record) continue;
				state.status = "queued";
				state.usedAttempts = 0;
				delete state.inputs;
				delete state.artifact;
				delete state.error;
				record("invalidated", node.id);
			}
			if (state.status === "succeeded" && state.artifact) current.set(node.id, state.artifact);
			if (state.status === "queued" && state.usedAttempts < node.maxAttempts) ready.push([node, inputs]);
		}
		return { current, ready };
	}

	#runningAttempt(run: GraphRun, attempt: GraphAttempt): NodeState | undefined {
		const state = run.nodes[attempt.nodeId];
		return state?.status === "running" && state.attempt === attempt.attempt ? state : undefined;
	}

	#record(run: GraphRun, kind: GraphRunEvent["kind"], nodeId?: string): void {
		const event: GraphRunEvent = { sequence: ++run.sequence, kind };
		if (nodeId !== undefined) {
			event.nodeId = nodeId;
			event.attempt = run.nodes[nodeId].attempt;
		}
		this.#db.run("INSERT INTO graph_events (run_id, sequence, event) VALUES (?, ?, ?)", [
			run.id,
			event.sequence,
			JSON.stringify(event),
		]);
	}

	#update<T>(runId: string, change: (run: GraphRun, record: RecordEvent) => T): T {
		return this.#db
			.transaction(() => {
				const run = this.get(runId);
				if (!run) throw new Error("Unknown Graph run");
				const before = run.sequence;
				const result = change(run, (kind, nodeId) => this.#record(run, kind, nodeId));
				if (before !== run.sequence) {
					this.#db.run("UPDATE graph_runs SET snapshot = ? WHERE id = ?", [JSON.stringify(run), runId]);
				}
				return result;
			})
			.immediate();
	}
}
