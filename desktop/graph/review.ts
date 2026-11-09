import { type } from "@oh-my-pi/omptype";
import { redactSensitiveCredentials, withCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { sanitizeText } from "@oh-my-pi/pi-utils";

const findingSchema = type({ file: "string", issue: "0 < string <= 600", expectedChange: "0 < string <= 600" });
const reviewSchema = type({
	verdict: "'accepted' | 'changes_requested'",
	findings: findingSchema.array().atMostLength(8),
});

export type GraphReview = typeof reviewSchema.infer;

export function cleanDiagnostic(text: string): string {
	return withCredentialRedaction(true, () => redactSensitiveCredentials(sanitizeText(text))).trim();
}

export function parseGraphReview(value: unknown, files: readonly string[]): GraphReview {
	const { verdict, findings } = reviewSchema.assert(value);
	if ((verdict === "accepted") !== (findings.length === 0)) {
		throw new Error("Accept with no findings, or request changes with at least one finding");
	}
	return {
		verdict,
		findings: findings.map(({ file, issue, expectedChange }) => {
			if (!files.includes(file)) throw new Error("Review finding is outside the owned files");
			const cleanIssue = cleanDiagnostic(issue);
			const cleanChange = cleanDiagnostic(expectedChange);
			if (!cleanIssue || !cleanChange) throw new Error("Review findings require an issue and expected change");
			return { file, issue: cleanIssue, expectedChange: cleanChange };
		}),
	};
}
