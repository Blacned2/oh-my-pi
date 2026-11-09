/**
 * `list_sessions`: the resume picker's rows over RPC, read-only.
 *
 * Unlike the picker this never repairs orphaned backups, migrates legacy
 * session directories, or creates a directory, so a host may poll it while
 * other processes own those sessions.
 */
import * as path from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import {
	isEmptySession,
	listAllSessions,
	listSessionsReadOnly,
	type SessionInfo,
	sessionDisplayName,
} from "../../session/session-listing";
import { sessionDirForCwd, worktreeSessionDirs } from "../../session/session-paths";
import { loadPinnedSessionIds, sortPinnedFirst } from "../../session/session-pins";
import { FileSessionStorage, type SessionStorage } from "../../session/session-storage";

export interface RpcSessionListItem {
	path: string;
	id: string;
	title: string;
	cwd: string;
	mtime: number;
	messageCount: number;
	pinned: boolean;
}

export interface RpcListSessionsParams {
	cwd?: string;
	all?: boolean;
	limit?: number;
}

export interface RpcListSessionsOptions {
	/** Session directory listed when neither `cwd` nor `all` is given. */
	currentSessionDir: string;
	/** Working directory behind `currentSessionDir`; enables its worktree siblings. */
	currentCwd?: string;
	/** Session directories of the folder in other worktrees; defaults to {@link worktreeSessionDirs}. */
	worktreeDirs?: (cwd: string, sessionDir: string) => Promise<string[]>;
	storage?: SessionStorage;
	sessionsRoot?: string;
	agentDir?: string;
}

export async function listRpcSessions(
	params: RpcListSessionsParams,
	options: RpcListSessionsOptions,
): Promise<RpcSessionListItem[]> {
	const storage = options.storage ?? new FileSessionStorage();
	const sessionsRoot = options.sessionsRoot ?? getSessionsDir();
	const [scanned, pinnedIds] = await Promise.all([
		scan(params, options, storage, sessionsRoot),
		loadPinnedSessionIds(options.agentDir ?? getAgentDir()),
	]);
	const visible = scanned.filter(session => pinnedIds.has(session.id) || !isEmptySession(session));
	const ordered = sortPinnedFirst(visible, pinnedIds);
	const limit = params.limit !== undefined && params.limit > 0 ? Math.floor(params.limit) : undefined;
	return (limit === undefined ? ordered : ordered.slice(0, limit)).map(session => ({
		path: session.path,
		id: session.id,
		title: sessionDisplayName(session),
		cwd: session.cwd,
		mtime: session.modified.getTime(),
		messageCount: session.messageCount,
		pinned: pinnedIds.has(session.id),
	}));
}

async function scan(
	params: RpcListSessionsParams,
	options: RpcListSessionsOptions,
	storage: SessionStorage,
	sessionsRoot: string,
): Promise<SessionInfo[]> {
	if (params.all) return listAllSessions(storage, sessionsRoot);
	const requested = params.cwd ? path.resolve(params.cwd) : undefined;
	const cwd = requested ?? options.currentCwd;
	const dir = requested ? sessionDirForCwd(requested, sessionsRoot) : options.currentSessionDir;
	// The resume picker's "repo" scope: the same folder in the other worktrees.
	const siblings = cwd ? await (options.worktreeDirs ?? worktreeSessionDirs)(cwd, dir) : [];
	return listSessionsReadOnly(dir, storage, siblings);
}
