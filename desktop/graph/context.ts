import { truncate } from "@oh-my-pi/pi-utils";
import { cleanDiagnostic } from "./review";
import type { GraphWork } from "./workflow";
import type { GraphWorkspace } from "./workspace";

const maxFileBytes = 64 * 1024;
const maxReferences = 4;
const maxExcerptChars = 240;
/** Non-owned files read for hints: the best path matches for the objective and tasks. */
const maxHintFiles = 24;

export interface GraphContextReference {
	file: string;
	line: number;
	excerpt: string;
}

export interface GraphContextManifest {
	baseSha: string;
	references: Record<string, GraphContextReference[]>;
}

export interface GraphCoderContext {
	references: readonly GraphContextReference[];
	upstream: { nodeId: string; files: string[] }[];
}

/** Case- and mark-folded terms, so `İstek`, `istek` and `ISTEK` are one word. */
function words(text: string): Set<string> {
	return new Set(
		text
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.normalize("NFKD")
			.replace(/\p{M}/gu, "")
			.toLowerCase()
			.match(/[\p{L}\p{N}]{3,}/gu),
	);
}

interface SourceLine {
	line: number;
	text: string;
	words: Set<string>;
}

interface RankedReference extends GraphContextReference {
	/** Own-text matches first; path matches and ownership only break ties. */
	rank: [matches: number, pathMatches: number, owned: number];
}

function compareRank(a: RankedReference, b: RankedReference): number {
	return b.rank[0] - a.rank[0] || b.rank[1] - a.rank[1] || b.rank[2] - a.rank[2];
}

/** Rank pinned source references. Files written by another Coder are read from the live prerequisite view instead. */
export async function buildGraphContext(
	workspace: Pick<GraphWorkspace, "baseSha" | "files" | "readBaseFile">,
	work: GraphWork,
	signal: AbortSignal,
): Promise<GraphContextManifest> {
	const owners = new Map(work.tasks.flatMap(task => task.files.map(file => [file, task.nodeId] as const)));
	const allTerms = words(`${work.objective} ${work.tasks.map(task => `${task.title} ${task.brief}`).join(" ")}`);
	const pathScore = (file: string) => [...words(file)].filter(word => allTerms.has(word)).length;
	const hints = workspace
		.files()
		.filter(file => !owners.has(file))
		.map(file => ({ file, score: pathScore(file) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || (a.file < b.file ? -1 : 1))
		.slice(0, maxHintFiles)
		.map(({ file }) => file);
	const sources = new Map<string, { words: Set<string>; lines: SourceLine[] }>();
	for (const file of [...owners.keys(), ...hints]) {
		signal.throwIfAborted();
		try {
			const { data } = await workspace.readBaseFile(file, signal);
			if (data.byteLength > maxFileBytes || data.includes(0)) continue;
			const lines = new TextDecoder("utf-8", { fatal: true })
				.decode(data)
				.split(/\r?\n/)
				.flatMap((text, index) => (text.trim() ? [{ line: index + 1, text, words: words(text) }] : []));
			sources.set(file, { words: words(file), lines });
		} catch {
			// A new, binary, oversized or otherwise unreadable file supplies no hint.
			signal.throwIfAborted();
		}
	}
	const references: GraphContextManifest["references"] = {};
	for (const task of work.tasks) {
		signal.throwIfAborted();
		const terms = words(`${task.title} ${task.brief} ${work.objective}`);
		const countMatches = (found: Set<string>) => {
			let count = 0;
			for (const word of found) if (terms.has(word)) count++;
			return count;
		};
		const ranked: RankedReference[] = [];
		for (const [file, source] of sources) {
			const owner = owners.get(file);
			if (owner && owner !== task.nodeId) continue;
			const pathMatches = countMatches(source.words);
			const owned = owner === task.nodeId ? 1 : 0;
			for (const { line, text, words: lineWords } of source.lines) {
				const matches = countMatches(lineWords);
				if (matches === 0) continue;
				const candidate: RankedReference = { file, line, excerpt: "", rank: [matches, pathMatches, owned] };
				if (ranked.length === maxReferences && compareRank(candidate, ranked.at(-1)!) >= 0) continue;
				candidate.excerpt = truncate(cleanDiagnostic(text), maxExcerptChars);
				if (!candidate.excerpt) continue;
				ranked.push(candidate);
				ranked.sort(compareRank);
				if (ranked.length > maxReferences) ranked.pop();
			}
		}
		references[task.nodeId] = ranked.map(({ file, line, excerpt }) => ({ file, line, excerpt }));
	}
	return { baseSha: workspace.baseSha, references };
}
