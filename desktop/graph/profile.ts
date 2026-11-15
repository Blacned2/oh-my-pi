import { type } from "@oh-my-pi/omptype";
import { type DockerTestProfile, validateDockerProfile } from "./docker-tester";

export const profileSchema = type({
	provider: "string > 0",
	model: "string > 0",
	tester: {
		dockerPath: "string > 0",
		imageId: "string > 0",
		command: "string[]",
		timeoutMs: "1 <= number.integer <= 300000",
	},
	"maxCoders?": "1 <= number.integer <= 4",
	"allowDirty?": "boolean",
	"failureJudge?": {
		provider: "string > 0",
		model: "string > 0",
		timeoutMs: "1 <= number.integer <= 5000",
		"baseUrl?": "string > 0",
	},
});

export type GraphProfile = typeof profileSchema.infer;

/**
 * The identity saved drafts and runs depend on: the worker model and the Tester. Concurrency, the failure judge
 * and `allowDirty` change nothing a saved plan or run depends on, so Settings can change them freely.
 */
export function graphProfileHash({ provider, model, tester }: GraphProfile): string {
	const identity = [provider, model, tester.dockerPath, tester.imageId, tester.command, tester.timeoutMs];
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** The formula drafts and runs were saved with before concurrency and the failure judge left the identity. */
function legacyGraphProfileHash(profile: GraphProfile): string {
	const { provider, model, tester, maxCoders, failureJudge } = profile;
	const identity: unknown[] = [provider, model, tester.dockerPath, tester.imageId, tester.command, tester.timeoutMs];
	if (maxCoders !== undefined) identity.push({ maxCoders });
	if (failureJudge)
		identity.push({
			failureJudge: [failureJudge.provider, failureJudge.model, failureJudge.timeoutMs, failureJudge.baseUrl],
		});
	return new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** True when a saved draft or run was recorded with this profile, under either hash formula. */
export function graphProfileMatches(profile: GraphProfile, savedHash: string): boolean {
	return savedHash === graphProfileHash(profile) || savedHash === legacyGraphProfileHash(profile);
}

/** The Tester settings, validated before any model is spent. */
export function graphTesterProfile({ tester }: GraphProfile): DockerTestProfile {
	const [command, ...args] = tester.command;
	if (!command) throw new Error("Graph Tester profile requires a container command");
	const profile: DockerTestProfile = {
		dockerPath: tester.dockerPath,
		imageId: tester.imageId,
		timeoutMs: tester.timeoutMs,
		command: [command, ...args],
	};
	validateDockerProfile(profile);
	return profile;
}
