/**
 * Sent-prompt history for ArrowUp/ArrowDown recall. Lives in `sessionStorage` (dies with the tab),
 * not `localStorage`: prompts can carry secrets, same as the join links in `session-tabs.ts`.
 */

export const MAX_PROMPT_HISTORY = 50;
const STORAGE_KEY = "omp.collab.prompt-history";

export function loadPromptHistory(): string[] {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((v): v is string => typeof v === "string").slice(-MAX_PROMPT_HISTORY);
	} catch {
		return [];
	}
}

export function savePromptHistory(history: readonly string[]): void {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
	} catch {
		// storage unavailable — history just won't survive a reload
	}
}

/** Appends a sent prompt (newest last), skipping an immediate repeat and keeping the newest `MAX_PROMPT_HISTORY`. */
export function pushPrompt(history: readonly string[], prompt: string): string[] {
	if (history[history.length - 1] === prompt) return [...history];
	const next = [...history, prompt];
	return next.length > MAX_PROMPT_HISTORY ? next.slice(next.length - MAX_PROMPT_HISTORY) : next;
}
