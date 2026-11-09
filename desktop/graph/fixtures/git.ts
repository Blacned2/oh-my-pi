import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { createScratchGit } from "../git-scratch";
import type { GraphChangeSet } from "../workspace";

export const original = { "src/backend.txt": "initial backend\n", "src/frontend.txt": "initial frontend\n" };
export const author = { name: "Graph Fixture", email: "graph@example.test" };

export async function fixture(root: string, files: Record<string, string> = original): Promise<VcsGitRepo> {
	await fs.mkdir(root);
	const repo = await createScratchGit(root);
	for (const [file, text] of Object.entries(files)) await Bun.write(path.join(root, file), text);
	await repo.stageFiles(Object.keys(files));
	await repo.commitCreate("Graph fixture", { author });
	return repo;
}

export async function changeSet(
	repo: VcsGitRepo,
	nodeId: string,
	files: Record<string, string>,
): Promise<GraphChangeSet> {
	const head = (await repo.headSha())!;
	for (const [file, content] of Object.entries(files)) await Bun.write(path.join(repo.info().repoRoot, file), content);
	await repo.stageFiles(Object.keys(files));
	const tree = await repo.writeTree();
	const changes = await Promise.all(
		Object.keys(files).map(async path => ({
			path,
			baseBlob: (await repo.resolveRef(`${head}:${path}`)) ?? null,
			newBlob: (await repo.resolveRef(`${tree}:${path}`)) ?? null,
		})),
	);
	return { nodeId, changes, patch: await repo.diffText({ base: head, head: tree, binary: true }) };
}
