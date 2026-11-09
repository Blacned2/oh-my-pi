import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

/** Initialize fresh metadata in a Graph-owned directory without running Git hooks. */
export async function createScratchGit(root: string) {
	const gitDir = path.join(root, ".git");
	await fs.mkdir(gitDir);
	await Promise.all([
		fs.mkdir(path.join(gitDir, "objects", "pack"), { recursive: true }),
		fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true }),
		Bun.write(path.join(gitDir, "HEAD"), "ref: refs/heads/graph\n"),
		Bun.write(
			path.join(gitDir, "config"),
			"[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tautocrlf = false\n",
		),
	]);
	return vcs.requireGit(root);
}
