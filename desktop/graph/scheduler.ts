import { toError, untilAborted } from "@oh-my-pi/pi-utils";
import type { GraphAttempt, GraphRunStore } from "./run-store";

/** Return the serialized artifact. Executors must stop their work when aborted. */
export type GraphExecutor = (attempt: GraphAttempt, signal: AbortSignal) => Promise<string>;

type Outcome = { attempt: GraphAttempt } & ({ content: string } | { error: string });

/** Drive a run until it has no runnable work. Retries are admitted by the store. */
export async function driveGraphRun(
	store: GraphRunStore,
	runId: string,
	concurrency: number,
	execute: GraphExecutor,
	signal?: AbortSignal,
): Promise<void> {
	const workers = new AbortController();
	const jobs = new Map<string, Promise<Outcome>>();
	try {
		while (true) {
			signal?.throwIfAborted();
			for (const attempt of store.claimReady(runId, concurrency)) {
				const job = Promise.resolve()
					.then(() => {
						workers.signal.throwIfAborted();
						return execute(attempt, workers.signal);
					})
					.then(
						content => ({ attempt, content }),
						error => ({ attempt, error: toError(error).message }),
					);
				jobs.set(attempt.nodeId, job);
			}
			if (jobs.size === 0) return;
			const outcome = await untilAborted(signal, () => Promise.race(jobs.values()));
			signal?.throwIfAborted();
			jobs.delete(outcome.attempt.nodeId);
			if ("content" in outcome) store.complete(outcome.attempt, outcome.content);
			else store.fail(outcome.attempt, outcome.error);
		}
	} catch (error) {
		if (!signal?.aborted) throw error;
		store.cancel(runId);
	} finally {
		workers.abort();
		await Promise.allSettled(jobs.values());
	}
}
