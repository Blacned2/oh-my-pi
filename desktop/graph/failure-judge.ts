import type { Model } from "@oh-my-pi/pi-ai";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/env-api-key";
import { createNativeJudge, isJudgmentApi, judgeQuestions, type NativeJudgeConnection } from "@oh-my-pi/pi-ai/judgment";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { sanitizeText, truncate, untilAborted } from "@oh-my-pi/pi-utils";
import type { GraphTestResult } from "./docker-tester";
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
	| { status: "unavailable"; reason: "timeout" | "provider_error" | "missing_credentials" }
);

export interface FailureJudgeProfile {
	provider: string;
	model: string;
	timeoutMs: number;
	baseUrl?: string;
}

export type TestFailureObserver = (
	result: GraphTestResult,
	signal: AbortSignal,
) => Promise<FailureObservation | undefined>;

const failureSignals: readonly [RegExp, string][] = [
	[/\b(assertion(?:error| failed)|expectation failed)\b/i, "Assertion failure"],
	[/\b(timed? ?out|timeout(?:error)?|ETIMEDOUT)\b/i, "Timeout"],
	[/\b(flaky|passed on retry|intermittent)\b/i, "Intermittent result"],
	[/\b(module not found|cannot find module|command not found|missing dependency)\b/i, "Missing dependency or command"],
	[/\b(ECONNREFUSED|ECONNRESET|ENETUNREACH|network unavailable)\b/i, "Network failure"],
	[/\b(out of memory|permission denied|ENOSPC)\b/i, "Resource or permission failure"],
];

/** Only fixed diagnostic labels and the exit code are cleared for the selected provider. */
function summarizeFailure(result: GraphTestResult): TestFailureEvidence {
	const text = sanitizeText(`${result.stderr}\n${result.stdout}`);
	const signals = failureSignals.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
	return { exitCode: result.exitCode, summary: signals.join(". ") || "No recognized diagnostic signals" };
}

export function createTestFailureObserver(profile: FailureJudgeProfile): TestFailureObserver {
	const catalogModel = getBundledModel(profile.provider, profile.model);
	if (!catalogModel || !isJudgmentApi(catalogModel.api))
		throw new Error("Graph failure judge requires a bundled judgment model");
	const url = URL.parse(profile.baseUrl ?? catalogModel.baseUrl);
	if (!url) throw new Error("Invalid Graph failure judge base URL");
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Graph failure judge requires an HTTPS or loopback HTTP base URL without credentials, a query or a fragment",
		);
	}
	const model = { ...catalogModel, baseUrl: url.href };
	return async (result, signal) => {
		if (result.exitCode === 0) return undefined;
		signal.throwIfAborted();
		let apiKey: string | undefined;
		try {
			apiKey = getEnvApiKey(profile.provider);
		} catch {
			return { status: "unavailable", reason: "provider_error", questionVersion, model: model.id, elapsedMs: 0 };
		}
		if (!apiKey)
			return {
				status: "unavailable",
				reason: "missing_credentials",
				questionVersion,
				model: model.id,
				elapsedMs: 0,
			};
		return observeTestFailure(
			summarizeFailure(result),
			{
				model,
				timeoutMs: profile.timeoutMs,
				connection: { apiKey, fetch: (input, options) => fetch(input, { ...options, redirect: "error" }) },
			},
			signal,
		);
	};
}

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
		const result = await untilAborted(requestSignal, () =>
			createNativeJudge(model, connection).judge(
				{ state: { exitCode: evidence.exitCode, summary: truncate(evidence.summary, 2000) }, questions },
				{ signal: requestSignal },
			),
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
			model: truncate(sanitizeText(result.model), 200) || model.id,
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
