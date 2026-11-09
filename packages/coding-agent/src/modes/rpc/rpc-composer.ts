/**
 * Composer helpers for RPC hosts: `@file` mention completion and the shared
 * prompt history, both backed by the same code the interactive editor uses.
 */
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { HistoryStorage } from "../../session/history-storage";

export interface RpcPathCompletionItem {
	/** Replacement for `prefix`, `@` and quotes included (`@src/`, `@"my dir/`). */
	value: string;
	/** Entry name, with a trailing `/` for directories. */
	label: string;
	/** Path relative to the session cwd, when the fuzzy search found it. */
	description?: string;
	directory: boolean;
}

export interface RpcPathCompletion {
	/** The `@…` token ending at the cursor that `value` replaces. */
	prefix: string;
	items: RpcPathCompletionItem[];
}

export interface RpcPromptHistoryEntry {
	prompt: string;
	/** Latest submission, epoch milliseconds. */
	createdAt: number;
	cwd?: string;
	useCount: number;
}

export interface RpcPromptHistoryParams {
	query?: string;
	limit?: number;
	cwd?: string;
}

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

/** Completes the `@` mention ending at a UTF-16 cursor, relative to a cwd. */
export class RpcPathCompleter {
	#cwd?: string;
	#provider?: CombinedAutocompleteProvider;

	/** `null` when the cursor is not inside an `@` mention or nothing matches. */
	async complete(cwd: string, text: string, cursor: number): Promise<RpcPathCompletion | null> {
		const before = text.slice(0, cursor);
		const lineStart = before.lastIndexOf("\n") + 1;
		const lineText = text.slice(lineStart, cursor);
		// `lineText` is cut at the cursor so the provider sees only the typed part of the line.
		const result = await this.#providerFor(cwd).getSuggestions([lineText], 0, lineText.length);
		if (!result || !result.prefix.startsWith("@")) return null;
		const items = result.items.map(item => {
			const entry: RpcPathCompletionItem = {
				value: item.value,
				label: item.label,
				directory: item.iconName === "folder",
			};
			if (item.description) entry.description = item.description;
			return entry;
		});
		return items.length > 0 ? { prefix: result.prefix, items } : null;
	}

	#providerFor(cwd: string): CombinedAutocompleteProvider {
		// The provider keeps per-directory caches; rebuild it only when the session moves.
		if (!this.#provider || this.#cwd !== cwd) {
			this.#provider = new CombinedAutocompleteProvider([], cwd);
			this.#cwd = cwd;
		}
		return this.#provider;
	}
}

/** Recent prompts (or those matching `query`), newest first, from the history every session shares. */
export function readRpcPromptHistory(
	params: RpcPromptHistoryParams,
	storage: HistoryStorage = HistoryStorage.open(),
): RpcPromptHistoryEntry[] {
	const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_HISTORY_LIMIT), 0), MAX_HISTORY_LIMIT);
	const filter = params.cwd ? { cwd: params.cwd } : {};
	const query = params.query?.trim();
	const rows = query ? storage.search(query, limit, filter) : storage.getRecent(limit, filter);
	return rows.map(row => {
		const entry: RpcPromptHistoryEntry = {
			prompt: row.prompt,
			createdAt: row.created_at * 1000,
			useCount: row.useCount,
		};
		if (row.cwd) entry.cwd = row.cwd;
		return entry;
	});
}

/** Records a submitted prompt the way the interactive editor does. */
export async function addRpcPromptHistory(
	prompt: string,
	cwd: string,
	sessionId: string | undefined,
	storage: HistoryStorage = HistoryStorage.open(),
): Promise<void> {
	await storage.add(prompt, cwd, sessionId);
}
