/**
 * Syntax highlighting for RPC clients: the native highlighter colors code with ANSI escapes, so each
 * token kind gets a unique marker color and the escaped output is mapped back to `{ text, kind }`
 * tokens a client styles with its own theme.
 */
import { type HighlightColors, highlightCode, supportsLanguage } from "@oh-my-pi/pi-natives";

export type HighlightKind =
	| "comment"
	| "keyword"
	| "function"
	| "variable"
	| "string"
	| "number"
	| "type"
	| "operator"
	| "punctuation"
	| "inserted"
	| "deleted";

/** A run of highlighted source; `text` may span lines. No `kind` means plain text. */
export interface HighlightToken {
	text: string;
	kind?: HighlightKind;
}

const KINDS: readonly HighlightKind[] = [
	"comment",
	"keyword",
	"function",
	"variable",
	"string",
	"number",
	"type",
	"operator",
	"punctuation",
	"inserted",
	"deleted",
];
// Marker colors: 256-color indexes no theme would pick together, one per kind.
const MARKER_BASE = 200;
const MARKERS = Object.fromEntries(KINDS.map((k, i) => [k, `\x1b[38;5;${MARKER_BASE + i}m`])) as Record<
	HighlightKind,
	string
>;
const MARKER_KIND = new Map(KINDS.map((k, i) => [String(MARKER_BASE + i), k]));
const SGR = /\x1b\[([0-9;:]*)m/g;

const CACHE_MAX = 256;
const cache = new Map<string, HighlightToken[]>();

function parse(highlighted: string): HighlightToken[] {
	const tokens: HighlightToken[] = [];
	let kind: HighlightKind | undefined;
	let last = 0;
	const push = (text: string) => {
		if (!text) return;
		const prev = tokens.at(-1);
		if (prev && prev.kind === kind) prev.text += text;
		else tokens.push(kind ? { text, kind } : { text });
	};
	for (const m of highlighted.matchAll(SGR)) {
		push(highlighted.slice(last, m.index));
		last = m.index + m[0].length;
		const marker = /^38;5;(\d+)$/.exec(m[1]);
		kind = marker ? MARKER_KIND.get(marker[1]) : undefined;
	}
	push(highlighted.slice(last));
	return tokens;
}

/**
 * Tokens of `code` in `lang` (a language name, alias or file extension). Concatenating the token
 * texts gives back `code`; an unknown language or a highlighter failure yields one plain token.
 */
export function highlightTokens(code: string, lang: string | undefined): HighlightToken[] {
	if (!code) return [];
	const valid = lang && supportsLanguage(lang) ? lang : undefined;
	if (!valid) return [{ text: code }];
	const key = `${valid}\x00${code}`;
	const hit = cache.get(key);
	if (hit) {
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	let tokens: HighlightToken[];
	try {
		tokens = parse(highlightCode(code, valid, MARKERS satisfies HighlightColors));
	} catch {
		return [{ text: code }];
	}
	// The highlighter echoes the source when it fails; anything that does not round-trip is dropped.
	if (tokens.map(t => t.text).join("") !== code) tokens = [{ text: code }];
	cache.set(key, tokens);
	if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
	return tokens;
}
