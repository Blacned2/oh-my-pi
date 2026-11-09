/**
 * Local session directory: how a browser on the same machine lists the Collab
 * hosts that are live there.
 *
 * Plain JSON over HTTP on the loopback interface, served by an omp host. It is
 * separate from the relay protocol: the relay never sees it and the directory
 * never carries a room key. A listing is non-capability metadata only; a join
 * link (which embeds the room key) is returned by a separate request, for one
 * session the user picked, and never travels beyond loopback.
 *
 * Authentication: every request carries `Authorization: Bearer <token>`. The
 * token is a local credential created by the host side (`omp collab pair`) and
 * pasted into the browser once; it is not a room key and unlocks nothing on
 * the relay.
 */

/** Loopback port the directory listens on (`127.0.0.1`). */
export const COLLAB_DIRECTORY_PORT = 7467;

/** Directory protocol version, carried in every response as `v`. */
export const COLLAB_DIRECTORY_VERSION = 1;

/** `GET` — the live local sessions. */
export const COLLAB_DIRECTORY_SESSIONS_PATH = "/v1/sessions";

/** `POST` — the join link of one session, on explicit request. */
export const COLLAB_DIRECTORY_LINK_PATH = "/v1/link";

/** Access a directory link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabDirectoryAccess = "view" | "control";

/** One live local session. Carries no URL, room key or write token. */
export interface CollabDirectoryEntry {
	/** Random per-process identity; stable across the host's room generations. */
	instanceId: string;
	/** Increments every time the host starts a new room; a link request is bound to it. */
	generation: number;
	sessionName: string | null;
	cwd: string;
	model: { provider: string; id: string } | null;
	/** Epoch milliseconds when the host first connected to the relay. */
	startedAt: number;
	/** Participant count, including the host. */
	participants: number;
	relayConnected: boolean;
	inputRequired: boolean;
	/** `null` when the host does not report it. */
	busy: boolean | null;
	/** Highest access the host will hand out. */
	access: CollabDirectoryAccess;
}

export interface CollabDirectorySessionsResponse {
	v: typeof COLLAB_DIRECTORY_VERSION;
	sessions: CollabDirectoryEntry[];
}

export interface CollabDirectoryLinkRequest {
	instanceId: string;
	/** The generation seen in the listing; a rotated room answers `stale_generation`. */
	generation: number;
	access: CollabDirectoryAccess;
}

export interface CollabDirectoryLinkResponse {
	v: typeof COLLAB_DIRECTORY_VERSION;
	instanceId: string;
	generation: number;
	access: CollabDirectoryAccess;
	/** Join link carrying the room key. */
	url: string;
}

/** Stable error codes; the response body is `{ v, error }` and never carries a URL. */
export type CollabDirectoryErrorCode =
	| "unauthorized"
	| "forbidden_origin"
	| "bad_request"
	| "not_found"
	| "stale_generation"
	| "access_unavailable"
	| "unreachable";
