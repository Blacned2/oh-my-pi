import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { TurnReceiptComponent } from "../src/chat/turn-receipt";
import { TurnUsageTally } from "../src/overlays/usage-row";
import { recentCacheHitShares, renderSegment } from "../src/status-line/segments";
import type { SegmentContext } from "../src/status-line/types";
import { initTheme } from "../src/theme";
import { visibleWidth } from "../src/utils";

beforeAll(async () => {
	await initTheme();
});

function usage(input: number, cacheRead: number, cacheWrite: number, output: number, cost = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistant(u: Usage, stopReason: AssistantMessage["stopReason"], toolCalls = 0): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	for (let i = 0; i < toolCalls; i++) content.push({ type: "toolCall", id: `t${i}`, name: "read", arguments: {} });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		usage: u,
		stopReason,
		timestamp: 0,
	} as AssistantMessage;
}

describe("TurnUsageTally receipt facts", () => {
	it("sums cache hit, tool calls and tool errors across the turn's requests", () => {
		const tally = new TurnUsageTally();
		// Request 1: 100 uncached + 900 read → issues 2 tool calls, one fails.
		expect(tally.add(assistant(usage(100, 900, 0, 50), "toolUse", 2), undefined)).toBeUndefined();
		tally.noteToolResult(false);
		tally.noteToolResult(true);
		// Request 2: 200 written + 800 read, ends the turn.
		const summary = tally.add(assistant(usage(0, 800, 200, 30, 0.5), "stop"), undefined);
		expect(summary?.cacheHit).toBeCloseTo(1700 / 2000);
		expect(summary?.tools).toBe(2);
		expect(summary?.toolErrors).toBe(1);
		// The tally starts over for the next turn.
		const next = tally.add(assistant(usage(10, 0, 0, 5), "stop"), undefined);
		expect(next?.tools).toBe(0);
		expect(next?.toolErrors).toBe(0);
		expect(next?.cacheHit).toBe(0);
	});
});

describe("TurnReceiptComponent", () => {
	const summary = {
		elapsedMs: 4_000,
		input: 18_200,
		output: 2_100,
		cost: 0.36,
		cacheHit: 0.87,
		tools: 6,
		toolErrors: 1,
	};

	it("shows the turn's facts on one width-filling line", () => {
		const lines = new TurnReceiptComponent(summary).render(100);
		expect(lines).toHaveLength(2);
		const line = stripVTControlCharacters(lines[1]!);
		expect(line).toContain("87%");
		expect(line).toContain("▰▰▰▰▰▰▰▱");
		expect(line).toContain("6 tools 1 err");
		expect(line).toContain("$0.36");
		expect(visibleWidth(lines[1]!)).toBe(99);
	});

	it("drops the pip bar on narrow terminals and never overflows", () => {
		const lines = new TurnReceiptComponent(summary).render(40);
		const line = stripVTControlCharacters(lines[1]!);
		expect(line).not.toContain("▰");
		expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(40);
	});
});

describe("cache_trend status-line segment", () => {
	it("takes the latest requests' hit shares oldest first, skipping requests without prompt tokens", () => {
		const messages = [
			assistant(usage(1000, 0, 0, 1), "stop"),
			{ role: "user", content: "hi", timestamp: 0 },
			assistant(usage(0, 0, 0, 0), "aborted"),
			assistant(usage(100, 900, 0, 1), "stop"),
		] as SegmentContext["session"]["state"]["messages"];
		expect(recentCacheHitShares(messages)).toEqual([0, 0.9]);
		expect(recentCacheHitShares(messages, 1)).toEqual([0.9]);
	});

	it("renders a sparkline with the latest percentage, hidden before any request", () => {
		const ctxWith = (messages: unknown[]) => ({ session: { state: { messages } } }) as unknown as SegmentContext;
		expect(renderSegment("cache_trend", ctxWith([])).visible).toBe(false);
		const shown = renderSegment(
			"cache_trend",
			ctxWith([assistant(usage(1000, 0, 0, 1), "stop"), assistant(usage(0, 1000, 0, 1), "stop")]),
		);
		expect(shown.visible).toBe(true);
		expect(stripVTControlCharacters(shown.content)).toContain("▁█ 100%");
	});
});
