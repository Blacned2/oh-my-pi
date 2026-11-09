import type { Model } from "@oh-my-pi/pi-ai";
import { createNativeJudge, judgeQuestions, type NativeJudgeConnection } from "@oh-my-pi/pi-ai/judgment";
import { truncate } from "@oh-my-pi/pi-utils";
import questionFile from "./questions/test-failure.json" with { type: "json" };

const questions = judgeQuestions(questionFile);
const questionVersion = 1;

export interface TestFailureEvidence {
	exitCode: number | null;
	/** A host-sanitized summary cleared for the configured provider. Never pass the raw log. */
	summary: string;
}

export interface FailureJudgeConfig {
	model: Model;
	connection: NativeJudgeConnection;
	timeoutMs: number;
}

export type FailureObservation = { questionVersion: number; model: string; elapsedMs: number } & (
	| { status: "observed"; choice: keyof typeof questionFile.test_failure.criteria; confidence: number }
	| { status: "unavailable"; reason: "timeout" | "provider_error" }
);

/** Optional shadow observation. The caller still runs the deterministic gate. */
export async function observeTestFailure(
	evidence: TestFailureEvidence,
	config?: FailureJudgeConfig,
	signal?: AbortSignal,
): Promise<FailureObservation | undefined> {
	if (!config) return undefined;
	signal?.throwIfAborted();
	const { model, connection, timeoutMs } = config;
	const deadline = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const started = performance.now();
	try {
		const result = await createNativeJudge(model, connection).judge(
			{ state: { exitCode: evidence.exitCode, summary: truncate(evidence.summary, 2000) }, questions },
			{ signal: requestSignal },
		);
		requestSignal.throwIfAborted();
		const { choice, confidence } = result.answers.test_failure;
		if (
			!Object.hasOwn(questions.test_failure.criteria, choice) ||
			!Number.isFinite(confidence) ||
			confidence < 0 ||
			confidence > 1
		) {
			throw new Error("Invalid test failure classification");
		}
		return {
			status: "observed",
			questionVersion,
			model: result.model,
			elapsedMs: performance.now() - started,
			choice,
			confidence,
		};
	} catch {
		signal?.throwIfAborted();
		return {
			status: "unavailable",
			reason: deadline.aborted ? "timeout" : "provider_error",
			questionVersion,
			model: model.id,
			elapsedMs: performance.now() - started,
		};
	}
}
