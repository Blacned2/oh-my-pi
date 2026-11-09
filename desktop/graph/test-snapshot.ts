import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import { repoPathPrefixes } from "./repo-path";

const maxFiles = 8192;
const maxBytes = 64 * 1024 * 1024;
const indexHeaderBytes = 12;
const indexEntryPrefixBytes = 62;
const sha1Bytes = 20;

interface IndexFile {
	path: string;
	blobId: string;
	executable: boolean;
}

/** Read the fresh v2 index produced by readTree. It carries modes omitted by lsTree. */
function snapshotEntries(index: Buffer): IndexFile[] {
	const end = index.length - sha1Bytes;
	if (end < indexHeaderBytes || index.toString("ascii", 0, 4) !== "DIRC" || index.readUInt32BE(4) !== 2) {
		throw new Error("Unsupported Graph snapshot index");
	}
	const count = index.readUInt32BE(8);
	if (count > maxFiles) throw new Error("Graph snapshot exceeds 8192 tracked files");
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	const entries: IndexFile[] = [];
	let offset = indexHeaderBytes;
	for (let i = 0; i < count; i++) {
		const start = offset + indexEntryPrefixBytes;
		if (start >= end) throw new Error("Truncated Graph snapshot index");
		const mode = index.readUInt32BE(offset + 24);
		if (mode !== 0o100644 && mode !== 0o100755) {
			throw new Error("Graph Tester requires regular tracked files and rejects symlinks and submodules");
		}
		const flags = index.readUInt16BE(offset + 60);
		const terminator = index.indexOf(0, start);
		if (
			(flags & 0x7000) !== 0 ||
			terminator < start ||
			terminator >= end ||
			(flags & 0xfff) !== Math.min(0xfff, terminator - start)
		) {
			throw new Error("Invalid Graph snapshot index entry");
		}
		const path = decoder.decode(index.subarray(start, terminator));
		repoPathPrefixes(path);
		entries.push({ path, blobId: index.toString("hex", offset + 40, offset + 60), executable: mode === 0o100755 });
		offset += Math.ceil((terminator - offset + 1) / 8) * 8;
	}
	if (offset > end) throw new Error("Truncated Graph snapshot index padding");
	return entries;
}

/** Package only committed candidate bytes. The control file is outside the project prefix. */
export async function buildTestSnapshot(
	repo: VcsGitRepo,
	indexPath: string,
	signal?: AbortSignal,
): Promise<Bun.Archive> {
	const index = Buffer.from(await Bun.file(indexPath).arrayBuffer());
	const files: [string, Buffer | string][] = [];
	const executable: string[] = [];
	let remaining = maxBytes;
	for (const entry of snapshotEntries(index)) {
		signal?.throwIfAborted();
		const { data, truncated } = await repo.showBlob(entry.blobId, remaining + 1, signal);
		remaining -= data.byteLength;
		if (truncated || remaining < 0) throw new Error("Graph snapshot exceeds 64 MiB");
		files.push([`project/${entry.path}`, data]);
		if (entry.executable) executable.push(`./${entry.path}\0`);
	}
	files.push(["graph-executables", executable.join("")]);
	return new Bun.Archive(Object.fromEntries(files));
}
