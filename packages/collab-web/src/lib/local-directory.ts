/**
 * Client for the session directory an omp host serves on this machine's
 * loopback interface (`omp collab pair` prints the token it requires).
 *
 * The listing carries no join links. A link is requested for one session at a
 * time, when the user opens its tab, and is handed straight to the caller —
 * never stored here. The token is a local credential, not a room key.
 */
import {
	COLLAB_DIRECTORY_LINK_PATH,
	COLLAB_DIRECTORY_PORT,
	COLLAB_DIRECTORY_SESSIONS_PATH,
	COLLAB_DIRECTORY_VERSION,
	type CollabDirectoryAccess,
	type CollabDirectoryEntry,
	type CollabDirectoryErrorCode,
	type CollabDirectoryLinkResponse,
	type CollabDirectorySessionsResponse,
} from "@oh-my-pi/pi-wire";

const TOKEN_KEY = "omp.collab.directoryToken";
const BASE_URL = `http://127.0.0.1:${COLLAB_DIRECTORY_PORT}`;

/** The directory refused or could not serve a request. `code` is `unreachable` when nothing answered. */
export class DirectoryError extends Error {
	readonly code: CollabDirectoryErrorCode;
	constructor(code: CollabDirectoryErrorCode) {
		super(code);
		this.name = "DirectoryError";
		this.code = code;
	}
}

export function loadDirectoryToken(): string {
	try {
		return localStorage.getItem(TOKEN_KEY) ?? "";
	} catch {
		return "";
	}
}

export function saveDirectoryToken(token: string): void {
	try {
		if (token) localStorage.setItem(TOKEN_KEY, token);
		else localStorage.removeItem(TOKEN_KEY);
	} catch {
		// storage unavailable — the token just won't survive a reload
	}
}

async function readError(response: Response): Promise<DirectoryError> {
	try {
		const body: unknown = await response.json();
		if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") {
			return new DirectoryError(body.error as CollabDirectoryErrorCode);
		}
	} catch {
		// not a directory response
	}
	return new DirectoryError("unreachable");
}

async function call(token: string, path: string, init: RequestInit): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(BASE_URL + path, {
			...init,
			headers: { ...init.headers, Authorization: `Bearer ${token}` },
			cache: "no-store",
		});
	} catch {
		// Nothing listening (no host running) or the browser blocked the loopback call.
		throw new DirectoryError("unreachable");
	}
	if (!response.ok) throw await readError(response);
	return response.json();
}

/** The live sessions on this machine, as metadata only. */
export async function fetchLocalSessions(token: string, signal?: AbortSignal): Promise<CollabDirectoryEntry[]> {
	const body = (await call(token, COLLAB_DIRECTORY_SESSIONS_PATH, {
		signal,
	})) as Partial<CollabDirectorySessionsResponse>;
	if (body.v !== COLLAB_DIRECTORY_VERSION || !Array.isArray(body.sessions)) throw new DirectoryError("unreachable");
	return body.sessions;
}

/** A join link for one session, bound to the generation seen in the listing. */
export async function fetchLocalLink(
	token: string,
	session: { instanceId: string; generation: number },
	access: CollabDirectoryAccess = "control",
): Promise<string> {
	const body = (await call(token, COLLAB_DIRECTORY_LINK_PATH, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ instanceId: session.instanceId, generation: session.generation, access }),
	})) as Partial<CollabDirectoryLinkResponse>;
	if (body.v !== COLLAB_DIRECTORY_VERSION || typeof body.url !== "string" || !body.url) {
		throw new DirectoryError("unreachable");
	}
	return body.url;
}
