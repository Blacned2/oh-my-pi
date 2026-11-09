import { describe, expect, it } from "bun:test";
import { MAX_PROMPT_HISTORY, pushPrompt } from "../src/lib/prompt-history";

describe("prompt history", () => {
	it("skips an immediate repeat but keeps a later duplicate", () => {
		expect(pushPrompt(["a"], "a")).toEqual(["a"]);
		expect(pushPrompt(["a", "b"], "a")).toEqual(["a", "b", "a"]);
	});

	it("drops the oldest prompts past the cap", () => {
		let history: string[] = [];
		for (let i = 0; i < MAX_PROMPT_HISTORY + 3; i++) history = pushPrompt(history, `p${i}`);
		expect(history).toHaveLength(MAX_PROMPT_HISTORY);
		expect(history[0]).toBe("p3");
	});
});
