import { expect, test } from "bun:test";
import { type GraphProfile, graphProfileHash, graphProfileMatches } from "../profile";

const profile: GraphProfile = {
	provider: "anthropic",
	model: "claude-fixture",
	tester: {
		dockerPath: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
		imageId: `sha256:${"a".repeat(64)}`,
		command: ["/bin/sh", "-c", "bun test"],
		timeoutMs: 120_000,
	},
};
const otherImage = { ...profile.tester, imageId: `sha256:${"b".repeat(64)}` };

test("changing Parallel Coders, the failure judge or allowDirty keeps saved drafts and runs valid; a new image does not", () => {
	const hash = graphProfileHash(profile);
	const settingsOnly: GraphProfile = {
		...profile,
		maxCoders: 4,
		allowDirty: true,
		failureJudge: { provider: "ollama", model: "judge", timeoutMs: 5_000 },
	};
	expect(graphProfileHash(settingsOnly)).toBe(hash);
	expect(graphProfileMatches(settingsOnly, hash)).toBe(true);
	expect(graphProfileHash({ ...profile, tester: otherImage })).not.toBe(hash);
	expect(graphProfileMatches({ ...profile, tester: otherImage }, hash)).toBe(false);
});

test("a draft or run saved with the previous hash formula is still accepted", () => {
	const saved: GraphProfile = { ...profile, maxCoders: 3 };
	const { provider, model, tester } = saved;
	// The exact identity hashed before concurrency left it.
	const identity = [
		provider,
		model,
		tester.dockerPath,
		tester.imageId,
		tester.command,
		tester.timeoutMs,
		{ maxCoders: 3 },
	];
	const legacy = new Bun.CryptoHasher("sha256").update(JSON.stringify(identity)).digest("hex");
	expect(graphProfileHash(saved)).not.toBe(legacy);
	expect(graphProfileMatches(saved, legacy)).toBe(true);
	expect(graphProfileMatches({ ...saved, tester: otherImage }, legacy)).toBe(false);
});
