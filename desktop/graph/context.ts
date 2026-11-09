import { truncate } from "@oh-my-pi/pi-utils";
import { cleanDiagnostic } from "./review";
import type { GraphWork } from "./workflow";
import type { GraphWorkspace } from "./workspace";

const maxFileBytes = 64 * 1024;
const maxReferences = 4;
const maxExcerptChars = 240;

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

function words(text: string): Set<string> {
	return new Set(
		text
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			.toLowerCase()
			.match(/[\p{L}\p{N}]{3,}/gu),
	);
}

/** Rank pinned source references. Files written by another Coder are read from the live prerequisite view instead. */
export async function buildGraphContext(
	workspace: GraphWorkspace,
	work: GraphWork,
	signal: AbortSignal,
): Promise<GraphContextManifest> {
	const owners = new Map(work.tasks.flatMap(task => task.files.map(file => [file, task.nodeId] as const)));
	const sources = new Map<string, string[]>();
	for (const file of work.files) {
		signal.throwIfAborted();
		try {
			const { data } = await workspace.readBaseFile(file, signal);
			if (data.byteLength > maxFileBytes || data.includes(0)) continue;
			sources.set(file, new TextDecoder("utf-8", { fatal: true }).decode(data).split(/\r?\n/));
		} catch {
			// A new, binary, oversized or otherwise unreadable file supplies no hint.
			signal.throwIfAborted();
		}
	}
	const references: GraphContextManifest["references"] = {};
	for (const task of work.tasks) {
		signal.throwIfAborted();
		const terms = words(`${task.title} ${task.brief} ${work.objective}`);
		const countMatches = (text: string) => [...words(text)].filter(word => terms.has(word)).length;
		const ranked: (GraphContextReference & { score: number })[] = [];
		for (const [file, lines] of sources) {
			const owner = owners.get(file);
			if (owner && owner !== task.nodeId) continue;
			const pathScore = countMatches(file);
			for (const [index, text] of lines.entries()) {
				if (!text.trim()) continue;
				const score = countMatches(text) * 2 + pathScore + (owner === task.nodeId ? 1 : 0);
				if (score === 0 || (ranked.length === maxReferences && score <= ranked.at(-1)!.score)) continue;
				const excerpt = truncate(cleanDiagnostic(text), maxExcerptChars);
				if (!excerpt) continue;
				ranked.push({ file, line: index + 1, excerpt, score });
				ranked.sort((a, b) => b.score - a.score);
				if (ranked.length > maxReferences) ranked.pop();
			}
		}
		references[task.nodeId] = ranked.map(({ file, line, excerpt }) => ({ file, line, excerpt }));
	}
	return { baseSha: workspace.baseSha, references };
}
