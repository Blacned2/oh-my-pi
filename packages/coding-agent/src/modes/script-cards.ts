/**
 * Per-session script cards: `!+ <command>` names a shell command and pins it as
 * a small right-aligned card above the working line. Clicking a card runs the
 * command outside the transcript and shows its state and last output line on
 * the card; clicking it while it runs cancels. Cards persist as `script_card`
 * custom entries of the session, so they follow the conversation across
 * resume and branches and never reach the model.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { iconButton } from "@oh-my-pi/pi-tui/native/overlay";
import { sanitizeStatusText } from "@oh-my-pi/pi-tui/chrome/shared";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { executeBash } from "../exec/bash-executor";
import type { SessionEntry } from "../session/session-entries";

/** `customType` of the session entries that hold the cards. */
export const SCRIPT_CARD_CUSTOM_TYPE = "script_card";

/** A saved card; `removed` tombstones an earlier entry with the same id. */
export interface ScriptCardEntryData {
	id: string;
	name?: string;
	command?: string;
	removed?: true;
}

interface ScriptCard {
	id: string;
	name: string;
	command: string;
}

interface ScriptRun {
	state: "running" | "done" | "failed" | "cancelled";
	exitCode?: number;
	lastLine: string;
	abort?: AbortController;
}

/** What the HUD needs from the owning mode; getters because the session manager is replaced on session switch. */
export interface ScriptCardsHost {
	entries(): readonly SessionEntry[];
	cwd(): string;
	append(data: ScriptCardEntryData): void;
	requestRender(): void;
	showError(message: string): void;
}

const RUN_ACT = "script.run:";
const REMOVE_ACT = "script.remove:";

/** Last non-empty line of `output`, single-line sanitized. */
function lastLine(output: string): string {
	const lines = output.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = sanitizeStatusText(lines[i]!);
		if (line) return line;
	}
	return "";
}

export class ScriptCardsHud implements Component {
	readonly #host: ScriptCardsHost;
	readonly #runs = new Map<string, ScriptRun>();
	#cards:
		| { source: readonly SessionEntry[]; length: number; lastId: string | undefined; cards: ScriptCard[] }
		| undefined;
	#native: { revision: number; cards: readonly ScriptCard[]; node: NativeNode } | undefined;
	#revision = 0;

	constructor(host: ScriptCardsHost) {
		this.#host = host;
	}

	/** Pins `command` as a card named `name`. */
	add(name: string, command: string): void {
		this.#host.append({ id: Snowflake.next(), name, command });
		this.#changed();
	}

	remove(id: string): void {
		this.#runs.get(id)?.abort?.abort();
		this.#runs.delete(id);
		this.#host.append({ id, removed: true });
		this.#changed();
	}

	/** Cards of the active branch, latest entry per id wins; tombstones drop the card. */
	cards(): readonly ScriptCard[] {
		const entries = this.#host.entries();
		const lastId = entries.at(-1)?.id;
		const memo = this.#cards;
		if (memo && memo.source === entries && memo.length === entries.length && memo.lastId === lastId)
			return memo.cards;
		const byId = new Map<string, ScriptCard>();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== SCRIPT_CARD_CUSTOM_TYPE) continue;
			const data = entry.data as ScriptCardEntryData | undefined;
			if (!data?.id) continue;
			if (data.removed) byId.delete(data.id);
			else if (data.name && data.command) byId.set(data.id, { id: data.id, name: data.name, command: data.command });
		}
		const cards = [...byId.values()];
		this.#cards = { source: entries, length: entries.length, lastId, cards };
		return cards;
	}

	/** Runs the card's command, or cancels it when already running. The output stays on the card. */
	async run(id: string): Promise<void> {
		const card = this.cards().find(candidate => candidate.id === id);
		if (!card) return;
		const running = this.#runs.get(id);
		if (running?.state === "running") {
			running.abort?.abort();
			return;
		}
		const abort = new AbortController();
		const run: ScriptRun = { state: "running", lastLine: "", abort };
		this.#runs.set(id, run);
		this.#changed();
		try {
			const result = await executeBash(card.command, {
				cwd: this.#host.cwd(),
				signal: abort.signal,
				useUserShell: true,
				onChunk: chunk => {
					const line = lastLine(chunk);
					if (line) {
						run.lastLine = line;
						this.#changed();
					}
				},
			});
			run.exitCode = result.exitCode;
			run.state = result.cancelled ? "cancelled" : result.exitCode === 0 ? "done" : "failed";
			run.lastLine = lastLine(result.output) || run.lastLine;
		} catch (error) {
			run.state = "failed";
			run.lastLine = sanitizeStatusText(error instanceof Error ? error.message : String(error));
			this.#host.showError(`Script "${card.name}" failed: ${run.lastLine}`);
		} finally {
			run.abort = undefined;
			this.#changed();
		}
	}

	/** Aborts every running card; used when the mode shuts down. */
	dispose(): void {
		for (const run of this.#runs.values()) run.abort?.abort();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act.startsWith(RUN_ACT)) void this.run(event.act.slice(RUN_ACT.length));
		else if (event.act.startsWith(REMOVE_ACT)) this.remove(event.act.slice(REMOVE_ACT.length));
	}

	describe(): NativeNode {
		const cards = this.cards();
		const memo = this.#native;
		if (memo && memo.revision === this.#revision && memo.cards === cards) return memo.node;
		const described = node(
			"col",
			{ role: "omp.hud.scripts" },
			cards.map(card => this.#describeCard(card)),
		);
		this.#native = { revision: this.#revision, cards, node: described };
		return described;
	}

	#describeCard(card: ScriptCard): NativeNode {
		const run = this.#runs.get(card.id);
		const spans = [span(sanitizeStatusText(card.name), "strong")];
		if (run) {
			if (run.state === "running") spans.push(span(" · running", "accent"));
			else if (run.state === "done") spans.push(span(" · ok", "success"));
			else if (run.state === "cancelled") spans.push(span(" · cancelled", "warning"));
			else spans.push(span(run.exitCode === undefined ? " · failed" : ` · exit ${run.exitCode}`, "warning"));
			if (run.lastLine) spans.push(span(` · ${run.lastLine}`, "dim"));
		}
		const title = run?.state === "running" ? `Cancel  ${card.command}` : `Run  ${card.command}`;
		return node(
			"row",
			{ role: "omp.hud.script", justify: "end", gap: "sm", align: "center" },
			[
				node(
					"row",
					{ role: "omp.hud.seg", align: "center", title, aria: title, actions: { click: `${RUN_ACT}${card.id}` } },
					[text(spans, { wrap: "none", truncate: "end", shrink: 1 })],
					"run",
				),
				iconButton("x", `${REMOVE_ACT}${card.id}`, `Remove ${card.name}`, { key: "remove" }),
			],
			card.id,
		);
	}

	render(width: number): readonly string[] {
		const available = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		if (available === 0) return [];
		return this.cards().map(card => {
			const run = this.#runs.get(card.id);
			let status = "";
			if (run?.state === "running") status = theme.fg("accent", " running");
			else if (run?.state === "done") status = theme.fg("success", " ok");
			else if (run?.state === "cancelled") status = theme.fg("warning", " cancelled");
			else if (run) status = theme.fg("warning", run.exitCode === undefined ? " failed" : ` exit ${run.exitCode}`);
			const tail = run?.lastLine ? theme.fg("dim", ` · ${run.lastLine}`) : "";
			const line = truncateToWidth(
				`${theme.bold(theme.fg("text", sanitizeStatusText(card.name)))}${status}${tail}`,
				available,
				"",
			);
			return `${" ".repeat(Math.max(0, available - visibleWidth(line)))}${line}`;
		});
	}

	#changed(): void {
		this.#revision++;
		this.#host.requestRender();
	}
}
