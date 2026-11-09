import { expect, test } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { observeTestFailure } from "../failure-judge";

const model = getBundledModel("typesafe", "jev-1.14.0");

test("Jev receives bounded evidence and returns an observation without a gate decision", async () => {
	const requests: unknown[] = [];
	const result = await observeTestFailure(
		{ exitCode: 1, summary: "x".repeat(3000) },
		{
			model,
			timeoutMs: 1000,
			connection: {
				apiKey: "fixture",
				async fetch(_url, options) {
					requests.push(JSON.parse(String(options?.body)));
					return Response.json({
						model: "resolved-test-model",
						answers: {
							test_failure: {
								type: "choice",
								choice: "code_regression",
								confidence: 0.81,
								probabilities: {
									code_regression: 0.9,
									flaky_test: 0.02,
									environment_failure: 0.03,
									unknown: 0.05,
								},
							},
						},
					});
				},
			},
		},
	);
	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({ state: { exitCode: 1, summary: `${"x".repeat(1999)}…` } });
	expect(result).toMatchObject({
		status: "observed",
		choice: "code_regression",
		model: "resolved-test-model",
		confidence: 0.81,
	});
});

test("provider failure produces an unavailable observation without exposing the provider response", async () => {
	const result = await observeTestFailure(
		{ exitCode: null, summary: "worker exited" },
		{
			model,
			timeoutMs: 1000,
			connection: {
				apiKey: "fixture",
				fetch: async () => new Response("private provider diagnostic", { status: 401 }),
			},
		},
	);
	expect(result).toMatchObject({ status: "unavailable", reason: "provider_error" });
	expect(JSON.stringify(result)).not.toContain("private provider diagnostic");
});

test("an out-of-contract classification is not published as an observation", async () => {
	const result = await observeTestFailure(
		{ exitCode: 1, summary: "assertion failed" },
		{
			model,
			timeoutMs: 1000,
			connection: {
				apiKey: "fixture",
				fetch: async () =>
					Response.json({
						model: "resolved-test-model",
						answers: { test_failure: { type: "choice", choice: "accept", confidence: 1 } },
					}),
			},
		},
	);
	expect(result).toMatchObject({ status: "unavailable", reason: "provider_error" });
});
