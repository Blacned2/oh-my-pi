import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import type { TurnUsageSummary } from "../overlays/usage-row";
import { getThemeEpoch, theme } from "../theme";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";

/** Cells of the cache-hit pip bar. */
const CACHE_BAR_CELLS = 8;
/** Below this width the pip bar drops out and only the percentage stays. */
const CACHE_BAR_MIN_WIDTH = 72;
const LEAD = "╌╌";
const RULE = "╌";

/** `$0.36`, `<$0.01`, or undefined when nothing was billed. */
function formatReceiptCost(cost: number): string | undefined {
	if (!(cost > 0)) return undefined;
	return cost < 0.005 ? "<$0.01" : `$${cost.toFixed(2)}`;
}

/** Filled/empty pips for a 0..1 share, rounded so any non-zero share shows at least one pip. */
export function cacheHitPips(share: number, cells: number = CACHE_BAR_CELLS): { filled: number; empty: number } {
	const clamped = Math.min(1, Math.max(0, share));
	let filled = Math.round(clamped * cells);
	if (filled === 0 && clamped > 0) filled = 1;
	return { filled, empty: cells - filled };
}

/**
 * A finished turn's one-line receipt under its last answer, a quiet dashed rule:
 *
 *   ╌╌ 3m12s · ↑18.2K ↓2.1K · cache ▰▰▰▰▰▰▰▱ 87% · 6 tools 1 err · $0.36 ╌╌╌╌╌
 *
 * ANSI only; native terminals draw the turn line themselves (`omp.turn.usage`).
 */
export class TurnReceiptComponent implements Component {
	readonly #summary: TurnUsageSummary;
	#cache: { width: number; epoch: number; lines: readonly string[] } | undefined;

	constructor(summary: TurnUsageSummary) {
		this.#summary = summary;
	}

	invalidate(): void {
		this.#cache = undefined;
	}

	describe(): null {
		return null;
	}

	render(width: number): readonly string[] {
		const epoch = getThemeEpoch();
		const cached = this.#cache;
		if (cached && cached.width === width && cached.epoch === epoch) return cached.lines;
		const lines = ["", this.#line(width)];
		this.#cache = { width, epoch, lines };
		return lines;
	}

	#line(width: number): string {
		const s = this.#summary;
		const dot = theme.fg("dim", " · ");
		const value = (text: string): string => theme.fg("muted", text);
		const parts: string[] = [];
		if (s.elapsedMs !== undefined) parts.push(value(formatDuration(s.elapsedMs)));
		parts.push(
			`${theme.fg("dim", "↑")}${value(formatNumber(s.input))} ${theme.fg("dim", "↓")}${value(formatNumber(s.output))}`,
		);
		if (s.cacheHit !== undefined) {
			const pct = value(`${Math.round(s.cacheHit * 100)}%`);
			if (width >= CACHE_BAR_MIN_WIDTH) {
				const { filled, empty } = cacheHitPips(s.cacheHit);
				const bar = theme.fg("statusLineSpend", "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(empty));
				parts.push(`${theme.fg("dim", "cache ")}${bar} ${pct}`);
			} else {
				parts.push(`${theme.fg("dim", "cache ")}${pct}`);
			}
		}
		if (s.tools) {
			const tools = `${value(String(s.tools))}${theme.fg("dim", s.tools === 1 ? " tool" : " tools")}`;
			parts.push(s.toolErrors ? `${tools} ${theme.fg("warning", `${s.toolErrors} err`)}` : tools);
		}
		const cost = formatReceiptCost(s.cost);
		if (cost) parts.push(theme.fg("statusLineCost", cost));

		const head = ` ${theme.fg("dim", LEAD)} ${parts.join(dot)} `;
		const headWidth = visibleWidth(head);
		if (headWidth >= width) return truncateToWidth(head, width);
		return head + theme.fg("dim", RULE.repeat(width - headWidth - 1));
	}
}
