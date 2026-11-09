import { describe, expect, it } from "bun:test";
import { highlightTokens } from "../../src/modes/rpc/highlight-tokens";

describe("highlight_code tokens", () => {
	it("maps the native highlighter's colors back to token kinds that rebuild the source", () => {
		const code = 'const answer = 42; // done\nfunction f() { return "x"; }\n';
		const tokens = highlightTokens(code, "typescript");
		expect(tokens.map(t => t.text).join("")).toBe(code);
		const kindOf = (text: string) => tokens.find(t => t.text.includes(text))?.kind;
		expect(kindOf("const")).toBe("keyword");
		expect(kindOf("42")).toBe("number");
		expect(kindOf("done")).toBe("comment");
		expect(tokens.find(t => t.text.replaceAll('"', "") === "x")?.kind).toBe("string");
		// No escape sequence leaks into token text.
		expect(tokens.some(t => t.text.includes("\x1b"))).toBe(false);
	});

	it("resolves a file extension and returns one plain token for an unknown language", () => {
		expect(highlightTokens("let x = 1", "rs").some(t => t.kind === "keyword")).toBe(true);
		expect(highlightTokens("let x = 1", "no-such-language")).toEqual([{ text: "let x = 1" }]);
		expect(highlightTokens("", "typescript")).toEqual([]);
	});
});
