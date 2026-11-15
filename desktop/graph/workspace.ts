import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { removeWithRetries, TempDir } from "@oh-my-pi/pi-utils";
import { createScratchGit } from "./git-scratch";
import { repoPathPrefixes } from "./repo-path";
import { buildTestSnapshot, readSnapshotEntries } from "./test-snapshot";

const maxPatchBytes = 1024 * 1024;
const maxReadBytes = 1024 * 1024;
const sha1 = /^[a-f0-9]{40}$/;
const unsupportedMetadata =
	/^(?:rename (?:from|to) |copy (?:from|to) |(?:old mode|new mode|deleted file mode|new file mode|index [a-f0-9]+\.\.[a-f0-9]+) (?:120000|160000)$)/m;
const modeChange = /^(?:old|new) mode /m;
const hunkHeader = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const maxListedPaths = 20;
const maxListedPathChars = 200;

export interface GraphBlobChange {
	path: string;
	/** Null denotes a file absent on that side. IDs are Git blob object IDs. */
	baseBlob: string | null;
	newBlob: string | null;
}

export interface GraphChangeSet {
	nodeId: string;
	patch: string;
	changes: readonly GraphBlobChange[];
}

export interface GraphCandidate {
	readonly baseSha: string;
	readonly treeId: string;
}

export interface GraphCandidateEvidence {
	test?: { treeId: string; exitCode: number | null };
	review?: { treeId: string; verdict: "accepted" | "changes_requested" };
}

export type GraphRelease =
	| { status: "ready_to_export"; artifact: GraphCandidate & { patch: string } }
	| { status: "needs_input"; reason?: string }
	| { status: "stale_base" };

export interface GraphSourceOptions {
	signal?: AbortSignal;
	/** Accept uncommitted changes. Graph still reads only the committed `HEAD`, so they never reach a run. */
	allowDirty?: boolean;
	/** Keeps the copied object database of a disposed workspace for the next pin of the same commit. */
	objectCache?: GraphObjectCache;
}

export async function graphBaseIsCurrent(
	sourceRoot: string,
	baseSha: string,
	{ signal, allowDirty }: GraphSourceOptions = {},
): Promise<boolean> {
	const source = vcs.git(sourceRoot);
	return (
		source !== null &&
		source.info().repoRoot === sourceRoot &&
		(allowDirty || !(await source.isDirty(signal))) &&
		(await source.headSha(signal)) === baseSha
	);
}

export async function inspectGraphSource(sourceDirectory: string, { signal, allowDirty }: GraphSourceOptions = {}) {
	const source = vcs.requireGit(sourceDirectory);
	const { repoRoot: sourceRoot, gitDir, commonDir } = source.info();
	const baseSha = await source.headSha(signal);
	if (!baseSha || !sha1.test(baseSha)) throw new Error("Graph requires a checked-out SHA-1 Git commit");
	if ((!allowDirty && (await source.isDirty(signal))) || (await source.headSha(signal)) !== baseSha) {
		throw new Error("Graph requires a clean, stable source checkout");
	}
	return { sourceRoot, gitDir, commonDir, baseSha };
}

/** Name the first rename, copy, symlink or submodule change in a patch, with its file header. */
function unsupportedChange(patch: string): string | undefined {
	const match = unsupportedMetadata.exec(patch);
	if (!match) return undefined;
	const line = match[0];
	const kind = /^(?:rename|copy) /.test(line) ? "rename/copy" : line.endsWith("120000") ? "symlink" : "submodule";
	const start = patch.lastIndexOf("\ndiff --git ", match.index) + 1;
	const end = patch.indexOf("\n", start);
	const header = bounded(patch.slice(start, end < 0 ? undefined : end));
	return `Graph does not support ${kind} changes (${header}); submit content changes to regular files only`;
}

function bounded(text: string): string {
	return text.length > maxListedPathChars ? `${text.slice(0, maxListedPathChars)}…` : text;
}

function listPaths(paths: readonly string[]): string {
	const shown = paths.slice(0, maxListedPaths).map(bounded).join(", ");
	return paths.length > maxListedPaths ? `${shown} and ${paths.length - maxListedPaths} more` : shown;
}

/**
 * Restore the leading space of blank context lines, which models often drop and which end a hunk early.
 * Only an empty line inside a hunk that still expects old and new lines is rewritten.
 */
export function restoreBlankContextLines(patch: string): string {
	const lines = patch.split("\n");
	let oldLines = 0;
	let newLines = 0;
	// The last element follows the final newline (or is an unterminated line); it is never a blank line.
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		const header = hunkHeader.exec(line);
		if (header) {
			oldLines = header[1] === undefined ? 1 : Number(header[1]);
			newLines = header[2] === undefined ? 1 : Number(header[2]);
			continue;
		}
		if (oldLines <= 0 && newLines <= 0) continue;
		if (line === "" && oldLines > 0 && newLines > 0) lines[i] = " ";
		switch (lines[i][0]) {
			case " ":
				oldLines--;
				newLines--;
				break;
			case "-":
				oldLines--;
				break;
			case "+":
				newLines--;
				break;
			case "\\":
				break;
			default:
				oldLines = 0;
				newLines = 0;
		}
	}
	return lines.join("\n");
}

async function borrowsObjects(commonDir: string): Promise<boolean> {
	const alternates = Bun.file(path.join(commonDir, "objects", "info", "alternates"));
	return (await alternates.exists()) && /^\s*[^#\s]/m.test(await alternates.text());
}

interface CandidateData {
	patch: string;
	spellings: ReadonlyMap<string, string>;
}

function registerSpelling(spellings: Map<string, string>, prefixes: [string, string][]): void {
	for (const [key, spelling] of prefixes) {
		const previous = spellings.get(key);
		if (previous !== undefined && previous !== spelling) throw new Error("Graph paths collide on Windows");
		spellings.set(key, spelling);
	}
}

/** Keys of the spellings map that name a directory because another key lies beneath them. */
function pathDirectories(spellings: ReadonlyMap<string, string>): Set<string> {
	const directories = new Set<string>();
	for (const key of spellings.keys()) {
		const slash = key.lastIndexOf("/");
		if (slash > 0) directories.add(key.slice(0, slash));
	}
	return directories;
}

function checkOwnership(
	scopes: ReadonlyMap<string, readonly string[]>,
	base: ReadonlyMap<string, string>,
	baseDirectories: ReadonlySet<string>,
): Map<string, string> {
	const spellings = new Map(base);
	const owners = new Map<string, string>();
	const directories = new Set<string>();
	for (const [owner, files] of scopes) {
		for (const file of files) {
			const prefixes = repoPathPrefixes(file);
			registerSpelling(spellings, prefixes);
			const [key] = prefixes.at(-1)!;
			if (baseDirectories.has(key)) {
				throw new Error(`Graph path ${file} is a directory in the base snapshot; list the files inside it instead`);
			}
			const baseFile = prefixes.slice(0, -1).find(([prefix]) => base.has(prefix) && !baseDirectories.has(prefix));
			if (baseFile) {
				throw new Error(`Graph path ${file} lies under ${baseFile[1]}, which is a file in the base snapshot`);
			}
			if (directories.has(key) || prefixes.some(([prefix]) => owners.has(prefix))) {
				throw new Error("Graph file ownership overlaps");
			}
			for (const [prefix] of prefixes.slice(0, -1)) directories.add(prefix);
			owners.set(key, owner);
		}
	}
	return owners;
}

/** Holds at most one spare scratch repository whose object database was copied from a source repository. */
export class GraphObjectCache implements AsyncDisposable {
	#spare: { key: string; scratch: TempDir; repo: VcsGitRepo } | undefined;
	#disposed = false;

	/** The spare for `key`, which leaves the cache; a spare for another key stays. */
	take(key: string): { scratch: TempDir; repo: VcsGitRepo } | undefined {
		const spare = this.#spare;
		if (spare?.key !== key) return undefined;
		this.#spare = undefined;
		return spare;
	}

	/** Keep `scratch` as the spare for `key`, deleting the previous spare. After disposal `scratch` is deleted instead. */
	async give(key: string, scratch: TempDir, repo: VcsGitRepo): Promise<void> {
		if (this.#disposed) return scratch.remove();
		const previous = this.#spare;
		this.#spare = { key, scratch, repo };
		await previous?.scratch.remove();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		this.#disposed = true;
		const spare = this.#spare;
		this.#spare = undefined;
		await spare?.scratch.remove();
	}
}

interface TestArchive {
	treeId: string;
	path: string;
	/** The signal of the caller that started the build. */
	signal?: AbortSignal;
	/** A build that fails deletes its partial file before rejecting. */
	build: Promise<Bun.BunFile>;
}

/** Pins read-only Git inputs and owns the independent object database and candidate indexes. */
export class GraphWorkspace implements AsyncDisposable {
	readonly #candidates = new WeakMap<GraphCandidate, CandidateData>();
	readonly #directories: ReadonlySet<string>;
	#archive: TestArchive | undefined;
	#disposal: Promise<void> | undefined;

	private constructor(
		readonly baseSha: string,
		readonly sourceRoot: string,
		readonly allowDirty: boolean,
		private readonly scratch: TempDir,
		private readonly repo: VcsGitRepo,
		private readonly spellings: ReadonlyMap<string, string>,
		private readonly objects?: { cache: GraphObjectCache; key: string },
	) {
		this.#directories = pathDirectories(spellings);
	}

	static async pin(sourceDirectory: string, options: GraphSourceOptions = {}): Promise<GraphWorkspace> {
		const { signal, allowDirty = false } = options;
		const { sourceRoot, gitDir, commonDir, baseSha } = await inspectGraphSource(sourceDirectory, options);
		if (await borrowsObjects(commonDir)) {
			throw new Error(
				"Graph does not support repositories that borrow objects from another repository (git clone --shared/--reference)",
			);
		}
		const temporaryRoot = await fs.realpath(os.tmpdir());
		const metadataRoots = await Promise.all([gitDir, commonDir].map(directory => fs.realpath(directory)));
		if (
			vcs.git(temporaryRoot) ||
			metadataRoots.some(root => {
				const relative = path.relative(root, temporaryRoot);
				return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
			})
		) {
			throw new Error("Graph scratch storage must be outside Git checkouts and metadata");
		}
		// The scratch holds nothing from the source but its objects, so a copy serves every pin of the same commit.
		const objects = options.objectCache && { cache: options.objectCache, key: `${metadataRoots[1]}\n${baseSha}` };
		const spare = objects?.cache.take(objects.key);
		const scratch = spare?.scratch ?? (await TempDir.create(path.join(temporaryRoot, "kostomp-graph-workspace-")));
		try {
			let repo = spare?.repo;
			if (!repo) {
				repo = await createScratchGit(scratch.path());
				await vcs.copyGitObjects(sourceRoot, scratch.path());
			}
			signal?.throwIfAborted();
			await using index = await TempDir.create(scratch.join("pin-"));
			const indexPath = index.join("index");
			await repo.readTree(baseSha, indexPath, signal);
			await readSnapshotEntries(indexPath);
			const spellings = new Map<string, string>();
			for (const file of await repo.lsTree(baseSha, [], signal)) registerSpelling(spellings, repoPathPrefixes(file));
			return new GraphWorkspace(baseSha, sourceRoot, allowDirty, scratch, repo, spellings, objects);
		} catch (error) {
			await scratch[Symbol.asyncDispose]();
			throw error;
		}
	}

	/** With an object cache the scratch goes back to it, holding only its object database. */
	[Symbol.asyncDispose](): Promise<void> {
		this.#disposal ??= this.#dispose();
		return this.#disposal;
	}

	async #dispose(): Promise<void> {
		const { objects } = this;
		let reusable = objects !== undefined;
		const archive = this.#archive;
		this.#archive = undefined;
		try {
			// A build in progress settles first, so nothing is written into the archives after their removal.
			await archive?.build.catch(() => undefined);
			await removeWithRetries(this.scratch.join("archives"));
		} catch {
			reusable = false;
		}
		if (objects && reusable) await objects.cache.give(objects.key, this.scratch, this.repo);
		else await this.scratch.remove();
	}

	/** Reject write scopes that overlap or collide with a differently spelled path in the pinned tree. */
	checkScopes(scopes: ReadonlyMap<string, readonly string[]>): void {
		checkOwnership(scopes, this.spellings, this.#directories);
	}

	/** Immediate children of a directory (`""` is the root) in the pinned base or a composed candidate. Directories end with `/`. */
	list(directory: string, candidate?: GraphCandidate): string[] {
		const spellings = candidate ? this.#candidates.get(candidate)?.spellings : this.spellings;
		if (!spellings) throw new Error("Unknown Graph candidate");
		const trimmed = directory.replace(/\/+$/, "");
		const root = trimmed === "";
		const parent = root ? "" : repoPathPrefixes(trimmed).at(-1)![0];
		if (!root && !spellings.has(parent)) throw new Error(`Graph directory ${trimmed} does not exist`);
		const prefix = root ? "" : `${parent}/`;
		const directories = pathDirectories(spellings);
		const children: string[] = [];
		for (const [key, spelling] of spellings) {
			if (!key.startsWith(prefix) || key.includes("/", prefix.length)) continue;
			const name = spelling.slice(spelling.lastIndexOf("/") + 1);
			children.push(directories.has(key) ? `${name}/` : name);
		}
		return children.sort();
	}

	/** Every tracked file in the pinned base. */
	files(): string[] {
		const directories = pathDirectories(this.spellings);
		return [...this.spellings].filter(([key]) => !directories.has(key)).map(([, spelling]) => spelling);
	}

	async readBaseFile(file: string, signal?: AbortSignal): Promise<{ blobId: string; data: Uint8Array }> {
		return this.#readFile(this.baseSha, this.spellings, file, signal);
	}

	async readCandidateFile(
		candidate: GraphCandidate,
		file: string,
		signal?: AbortSignal,
	): Promise<{ blobId: string; data: Uint8Array }> {
		const data = this.#candidates.get(candidate);
		if (!data) throw new Error("Unknown Graph candidate");
		return this.#readFile(candidate.treeId, data.spellings, file, signal);
	}

	/** The export patch of a composed candidate. */
	candidatePatch(candidate: GraphCandidate): string {
		const data = this.#candidates.get(candidate);
		if (!data) throw new Error("Unknown Graph candidate");
		return data.patch;
	}

	/** The Tester's tar of a candidate, built once per candidate tree and kept until another tree replaces it. */
	async testSnapshot(candidate: GraphCandidate, signal?: AbortSignal): Promise<Bun.BunFile> {
		if (!this.#candidates.has(candidate)) throw new Error("Unknown Graph candidate");
		for (;;) {
			const current = this.#archive;
			const archive = current?.treeId === candidate.treeId ? current : this.#buildArchive(candidate.treeId, signal);
			try {
				return await archive.build;
			} catch (error) {
				// A shared build that another caller aborted starts over for this one.
				if (archive.signal === signal || !archive.signal?.aborted) throw error;
				signal?.throwIfAborted();
			}
		}
	}

	#buildArchive(treeId: string, signal?: AbortSignal): TestArchive {
		const previous = this.#archive;
		const archivePath = this.scratch.join("archives", `${crypto.randomUUID()}.tar`);
		const build = this.#writeArchive(treeId, archivePath, previous, signal);
		const archive = { treeId, path: archivePath, signal, build };
		this.#archive = archive;
		build.catch(() => {
			if (this.#archive === archive) this.#archive = undefined;
		});
		return archive;
	}

	async #writeArchive(
		treeId: string,
		archivePath: string,
		previous: TestArchive | undefined,
		signal?: AbortSignal,
	): Promise<Bun.BunFile> {
		if (previous) {
			await previous.build.catch(() => undefined);
			// One that cannot be deleted now goes with the archives directory when the workspace is disposed.
			await fs.rm(previous.path, { force: true }).catch(() => undefined);
		}
		try {
			await fs.mkdir(path.dirname(archivePath), { recursive: true });
			await using index = await TempDir.create(this.scratch.join("test-"));
			const indexPath = index.join("index");
			await this.repo.readTree(treeId, indexPath, signal);
			return await buildTestSnapshot(this.repo, indexPath, archivePath, signal);
		} catch (error) {
			await fs.rm(archivePath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async #readFile(tree: string, spellings: ReadonlyMap<string, string>, file: string, signal?: AbortSignal) {
		const [key, spelling] = repoPathPrefixes(file).at(-1)!;
		if (spellings.get(key) !== spelling) throw new Error("Path is not in the Graph snapshot");
		const spec = `${tree}:${file}`;
		const blobId = await this.repo.resolveRef(spec, signal);
		if (!blobId) throw new Error("Graph blob could not be resolved");
		const result = await this.repo.showBlob(spec, maxReadBytes, signal);
		if (result.truncated) throw new Error("Graph blob exceeds 1 MiB");
		return { blobId, data: result.data };
	}

	/** Validate a proposed patch and derive the blob bindings on the host. */
	async captureChangeSet(
		nodeId: string,
		files: readonly string[],
		patch: string,
		signal?: AbortSignal,
	): Promise<GraphChangeSet> {
		const owners = checkOwnership(new Map([[nodeId, files]]), this.spellings, this.#directories);
		if (!patch.trim()) throw new Error("Graph patch is empty; submit a unified diff that changes the approved files");
		const bytes = Buffer.byteLength(patch);
		if (bytes > maxPatchBytes) {
			throw new Error(`Graph patch is ${bytes} bytes, over the 1 MiB limit; submit a smaller patch`);
		}
		const unsupported = unsupportedChange(patch);
		if (unsupported) throw new Error(unsupported);
		await using index = await TempDir.create(this.scratch.join("capture-"));
		const indexPath = index.join("index");
		const apply = { cached: true, indexPath, threeWay: false };
		await this.repo.readTree(this.baseSha, indexPath, signal);
		await this.repo.applyPatch(restoreBlankContextLines(patch), apply, signal);
		const tree = await this.repo.writeTree(indexPath, signal);
		const diff = { base: this.baseSha, head: tree, binary: true, maxBytes: maxPatchBytes };
		const changed = await this.repo.changedFiles(diff, signal);
		if (changed.length === 0) {
			throw new Error("Graph patch does not change any file; submit a unified diff that changes the approved files");
		}
		const outside = changed.filter(file => !files.includes(file) || !owners.has(repoPathPrefixes(file).at(-1)![0]));
		if (outside.length > 0) {
			throw new Error(
				`Graph patch must change only approved files; remove the changes to ${listPaths(outside)}. Approved files: ${listPaths(files)}`,
			);
		}
		const rendered = await this.repo.diffText(diff, signal);
		const renderedUnsupported = unsupportedChange(rendered);
		if (renderedUnsupported) throw new Error(renderedUnsupported);
		if (modeChange.test(rendered)) {
			throw new Error("Graph does not support file mode changes; submit content changes only");
		}
		const changes: GraphBlobChange[] = [];
		for (const path of changed) {
			const baseBlob = (await this.repo.resolveRef(`${this.baseSha}:${path}`, signal)) ?? null;
			const newBlob = (await this.repo.resolveRef(`${tree}:${path}`, signal)) ?? null;
			if (baseBlob === newBlob) {
				throw new Error(
					`Graph patch leaves the content of ${bounded(path)} unchanged; submit content changes only`,
				);
			}
			changes.push({ path, baseBlob, newBlob });
		}
		return { nodeId, changes, patch: rendered };
	}

	/** Change sets are supplied in dependency order and applied only to a private index. */
	async compose(
		scopes: ReadonlyMap<string, readonly string[]>,
		changeSets: readonly GraphChangeSet[],
		signal?: AbortSignal,
	): Promise<GraphCandidate> {
		const owners = checkOwnership(scopes, this.spellings, this.#directories);
		const sets = changeSets.map(set => ({ ...set, changes: set.changes.map(change => ({ ...change })) }));
		const seen = new Set<string>();
		let bytes = 0;
		for (const set of sets) {
			bytes += Buffer.byteLength(set.patch);
			if (bytes > maxPatchBytes) throw new Error("Graph change sets exceed 1 MiB");
			if (unsupportedMetadata.test(set.patch))
				throw new Error("Graph MVP rejects symlink, submodule, rename and copy changes");
			for (const change of set.changes) {
				const [key, spelling] = repoPathPrefixes(change.path).at(-1)!;
				if (owners.get(key) !== set.nodeId || !scopes.get(set.nodeId)?.includes(spelling) || seen.has(key)) {
					throw new Error("Graph change is outside its unique file ownership");
				}
				seen.add(key);
				if (
					change.baseBlob === change.newBlob ||
					[change.baseBlob, change.newBlob].some(id => id !== null && !sha1.test(id))
				) {
					throw new Error("Invalid Graph blob change");
				}
			}
		}
		await using index = await TempDir.create(this.scratch.join("candidate-"));
		const indexPath = index.join("index");
		const apply = { cached: true, indexPath, threeWay: false };
		const baseTree = await this.repo.resolveRef(`${this.baseSha}^{tree}`, signal);
		if (!baseTree) throw new Error("Graph base tree could not be resolved");
		await this.repo.readTree(baseTree, indexPath, signal);
		let treeId = baseTree;
		for (const set of sets) {
			for (const { path, baseBlob } of set.changes) {
				if (((await this.repo.resolveRef(`${treeId}:${path}`, signal)) ?? null) !== baseBlob) {
					throw new Error("Graph change does not match its expected base blob");
				}
			}
			if (!(await this.repo.canApplyPatch(set.patch, apply, signal)))
				throw new Error("Graph patch does not apply cleanly");
			await this.repo.applyPatch(set.patch, apply, signal);
			const nextTree = await this.repo.writeTree(indexPath, signal);
			const diff = { base: treeId, head: nextTree, binary: true, maxBytes: maxPatchBytes };
			const actualPaths = new Set(await this.repo.changedFiles(diff, signal));
			if (actualPaths.size !== set.changes.length || set.changes.some(change => !actualPaths.has(change.path))) {
				throw new Error("Graph patch changed undeclared files");
			}
			if (unsupportedMetadata.test(await this.repo.diffText(diff, signal))) {
				throw new Error("Graph MVP rejects symlink, submodule, rename and copy changes");
			}
			for (const { path, newBlob } of set.changes) {
				if (((await this.repo.resolveRef(`${nextTree}:${path}`, signal)) ?? null) !== newBlob) {
					throw new Error("Graph change does not match its expected new blob");
				}
			}
			treeId = nextTree;
		}
		if (treeId === baseTree) throw new Error("Graph candidate has no changes");
		const patch = await this.repo.diffText(
			{ base: baseTree, head: treeId, binary: true, maxBytes: maxPatchBytes },
			signal,
		);
		if (unsupportedMetadata.test(patch)) throw new Error("Graph candidate contains an unsupported change");
		await this.repo.readTree(baseTree, indexPath, signal);
		await this.repo.applyPatch(patch, apply, signal);
		if ((await this.repo.writeTree(indexPath, signal)) !== treeId)
			throw new Error("Graph export patch does not reproduce the candidate");
		const spellings = new Map<string, string>();
		for (const file of await this.repo.lsTree(treeId, [], signal))
			registerSpelling(spellings, repoPathPrefixes(file));
		const candidate = Object.freeze({ baseSha: this.baseSha, treeId });
		this.#candidates.set(candidate, { patch, spellings });
		return candidate;
	}

	async release(
		candidate: GraphCandidate,
		evidence: GraphCandidateEvidence,
		signal?: AbortSignal,
	): Promise<GraphRelease> {
		const data = this.#candidates.get(candidate);
		if (!data) throw new Error("Unknown Graph candidate");
		const { test, review } = evidence;
		if (
			test?.treeId !== candidate.treeId ||
			test.exitCode !== 0 ||
			review?.treeId !== candidate.treeId ||
			review.verdict !== "accepted"
		) {
			return { status: "needs_input" };
		}
		if (!(await graphBaseIsCurrent(this.sourceRoot, this.baseSha, { signal, allowDirty: this.allowDirty })))
			return { status: "stale_base" };
		return { status: "ready_to_export", artifact: { ...candidate, patch: data.patch } };
	}
}
