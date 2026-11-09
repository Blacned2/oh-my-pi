/**
 * Local session directory for the Collab web client.
 *
 * A browser cannot read the on-disk host registry (`registry.ts`), so an omp
 * host that is publishing a room also serves a small HTTP API on the loopback
 * interface. It reads the very same registry, so one server lists every live
 * host on the machine regardless of which process answers.
 *
 * - `GET  /v1/sessions` — non-capability metadata for every live host;
 * - `POST /v1/link`     — one join link, for one session the user picked,
 *   bound to the generation seen in the listing.
 *
 * Nothing here reaches the relay and room keys stay on the machine: a link is
 * resolved from the host over its private IPC endpoint on request, handed to
 * the caller, and neither stored nor logged.
 *
 * Who may ask:
 * - the socket is bound to `127.0.0.1`;
 * - the `Host` header must name loopback and this port (DNS rebinding);
 * - a browser `Origin` must be the Collab web UI, or a loopback dev server —
 *   a script on any other site is refused before authentication;
 * - every request needs the pairing token (`Authorization: Bearer`), a local
 *   credential kept owner-only beside the registry (`omp collab pair`). It
 *   keeps other OS users on a shared machine out of a loopback port.
 *
 * One process per machine owns the port. Every publishing host asks for a
 * lease; the first binds, the others retry quietly and take over when the
 * owner exits.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import {
	COLLAB_DIRECTORY_LINK_PATH,
	COLLAB_DIRECTORY_PORT,
	COLLAB_DIRECTORY_SESSIONS_PATH,
	COLLAB_DIRECTORY_VERSION,
	type CollabDirectoryAccess,
	type CollabDirectoryEntry,
	type CollabDirectoryErrorCode,
	type CollabDirectoryLinkRequest,
	type CollabDirectoryLinkResponse,
	type CollabDirectorySessionsResponse,
	DEFAULT_RELAY_URL,
} from "@oh-my-pi/pi-wire";
import {
	type CollabHostSnapshot,
	CollabLinkError,
	type CollabLinkErrorCode,
	type CollabRegistryOptions,
	collabHostsRuntimeDir,
	listCollabHosts,
	resolveCollabHostLink,
} from "./registry";

const TOKEN_FILE = "directory-token";
/** A valid link request is well under 200 bytes. */
const MAX_BODY_BYTES = 1024;
const RETRY_BIND_MS = 10_000;
const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export interface CollabDirectoryOptions extends CollabRegistryOptions {
	/** Listening port; defaults to {@link COLLAB_DIRECTORY_PORT}. `0` picks a free one (tests). */
	port?: number;
	/** Extra web origins allowed to call the directory (a self-hosted Collab UI). */
	allowedOrigins?: readonly string[];
}

/** The origin of the default public Collab UI, derived from the default relay. */
function defaultWebOrigin(): string {
	return new URL(DEFAULT_RELAY_URL.replace(/^ws/, "http")).origin;
}

/** `origin` of an absolute web URL, or `null` when it is not one. */
export function webOrigin(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
	} catch {
		return null;
	}
}

function tokenPath(dir: string): string {
	return path.join(dir, TOKEN_FILE);
}

/**
 * The pairing token, created owner-only on first use. The file lives in the
 * registry directory but is not `*.json`, so the registry's pruning of
 * malformed discovery metadata never touches it. Deleting the file revokes
 * every paired browser: the next request reads (and creates) a fresh one.
 */
export async function readOrCreateDirectoryToken(options?: CollabRegistryOptions): Promise<string> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	const file = tokenPath(dir);
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const existing = (await Bun.file(file).text()).trim();
			if (existing) return existing;
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
		const token = crypto.randomBytes(32).toString("base64url");
		try {
			const handle = await fs.promises.open(file, "wx", 0o600);
			try {
				await handle.writeFile(token, "utf8");
			} finally {
				await handle.close();
			}
			return token;
		} catch (err) {
			// Another process created it first: read theirs.
			if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
		}
	}
	throw new Error("could not read or create the collab directory token");
}

function tokensEqual(expected: string, presented: string): boolean {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function toEntry(snapshot: CollabHostSnapshot): CollabDirectoryEntry {
	return {
		instanceId: snapshot.instanceId,
		generation: snapshot.generation,
		sessionName: snapshot.sessionName,
		cwd: snapshot.cwd,
		model: snapshot.model,
		startedAt: snapshot.startedAt,
		participants: snapshot.participants,
		relayConnected: snapshot.relayConnected,
		inputRequired: snapshot.inputRequired,
		busy: snapshot.busy,
		access: snapshot.access,
	};
}

const LINK_ERROR_STATUS: Record<CollabLinkErrorCode, { status: number; code: CollabDirectoryErrorCode }> = {
	not_found: { status: 404, code: "not_found" },
	ambiguous: { status: 502, code: "unreachable" },
	stale_generation: { status: 409, code: "stale_generation" },
	access_unavailable: { status: 403, code: "access_unavailable" },
	unreachable: { status: 502, code: "unreachable" },
};

function parseLinkRequest(raw: unknown): CollabDirectoryLinkRequest | null {
	if (typeof raw !== "object" || raw === null) return null;
	const { instanceId, generation, access } = raw as Record<string, unknown>;
	if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) return null;
	if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) return null;
	if (access !== "view" && access !== "control") return null;
	return { instanceId, generation, access: access as CollabDirectoryAccess };
}

interface HandlerContext {
	options: CollabDirectoryOptions;
	port(): number;
	origins(): ReadonlySet<string>;
}

function createHandler(ctx: HandlerContext): (request: Request) => Promise<Response> {
	const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	const json = (status: number, body: object, extra?: Record<string, string>): Response =>
		Response.json(body, { status, headers: { ...baseHeaders, ...extra } });
	const failure = (status: number, error: CollabDirectoryErrorCode, extra?: Record<string, string>): Response =>
		json(status, { v: COLLAB_DIRECTORY_VERSION, error }, extra);

	return async request => {
		const port = ctx.port();
		const host = request.headers.get("host");
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) {
			return failure(403, "forbidden_origin");
		}
		const origin = request.headers.get("origin");
		let cors: Record<string, string> = {};
		if (origin !== null) {
			if (!ctx.origins().has(origin) && !LOOPBACK_ORIGIN_PATTERN.test(origin)) {
				return failure(403, "forbidden_origin");
			}
			cors = {
				"Access-Control-Allow-Origin": origin,
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				// Chromium's Private Network Access preflight for a public page calling loopback.
				"Access-Control-Allow-Private-Network": "true",
				"Access-Control-Max-Age": "600",
				Vary: "Origin",
			};
		}
		if (request.method === "OPTIONS")
			return new Response(null, { status: 204, headers: { ...baseHeaders, ...cors } });

		const authorization = request.headers.get("authorization") ?? "";
		const presented = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
		let expected: string;
		try {
			expected = await readOrCreateDirectoryToken(ctx.options);
		} catch (err) {
			logger.warn("Collab directory token unavailable", { error: String(err) });
			return failure(500, "unreachable", cors);
		}
		if (!presented || !tokensEqual(expected, presented)) return failure(401, "unauthorized", cors);

		const url = new URL(request.url);
		if (url.pathname === COLLAB_DIRECTORY_SESSIONS_PATH && request.method === "GET") {
			try {
				const hosts = await listCollabHosts(ctx.options);
				const body: CollabDirectorySessionsResponse = { v: COLLAB_DIRECTORY_VERSION, sessions: hosts.map(toEntry) };
				return json(200, body, cors);
			} catch (err) {
				logger.warn("Collab directory listing failed", { error: String(err) });
				return failure(502, "unreachable", cors);
			}
		}
		if (url.pathname === COLLAB_DIRECTORY_LINK_PATH && request.method === "POST") {
			const text = await request.text();
			if (text.length > MAX_BODY_BYTES) return failure(400, "bad_request", cors);
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				return failure(400, "bad_request", cors);
			}
			const wanted = parseLinkRequest(raw);
			if (!wanted) return failure(400, "bad_request", cors);
			try {
				const link = await resolveCollabHostLink(wanted.instanceId, wanted.access, ctx.options);
				// The registry resolves by instance ID, falling back to a PID; only the exact
				// instance and generation the user picked may leave. The link is dropped otherwise.
				if (link.instanceId !== wanted.instanceId) return failure(404, "not_found", cors);
				if (link.generation !== wanted.generation) return failure(409, "stale_generation", cors);
				const body: CollabDirectoryLinkResponse = { v: COLLAB_DIRECTORY_VERSION, ...link };
				return json(200, body, cors);
			} catch (err) {
				if (err instanceof CollabLinkError) {
					const mapped = LINK_ERROR_STATUS[err.code];
					return failure(mapped.status, mapped.code, cors);
				}
				logger.warn("Collab directory link request failed", { error: String(err) });
				return failure(502, "unreachable", cors);
			}
		}
		return failure(404, "not_found", cors);
	};
}

/** A running directory server. */
export interface CollabDirectoryServer {
	readonly port: number;
	close(): Promise<void>;
}

/** Bind the directory. Rejects when the port is taken. */
export function startCollabDirectory(
	options: CollabDirectoryOptions = {},
	origins: () => ReadonlySet<string> = () => new Set(options.allowedOrigins ?? [defaultWebOrigin()]),
): CollabDirectoryServer {
	let boundPort = 0;
	const handler = createHandler({ options, port: () => boundPort, origins });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? COLLAB_DIRECTORY_PORT,
		fetch: handler,
	});
	boundPort = server.port ?? 0;
	return {
		port: boundPort,
		async close(): Promise<void> {
			await server.stop(true);
		},
	};
}

/** Released when the publishing host goes away. */
export interface CollabDirectoryLease {
	release(): void;
}

interface LeaseState {
	options: CollabDirectoryOptions;
	leases: Map<symbol, readonly string[]>;
	server: CollabDirectoryServer | null;
	retry: ReturnType<typeof setInterval> | null;
}

let shared: LeaseState | null = null;

function leaseOrigins(state: LeaseState): ReadonlySet<string> {
	const origins = new Set<string>([defaultWebOrigin()]);
	for (const list of state.leases.values()) for (const origin of list) origins.add(origin);
	return origins;
}

function tryBind(state: LeaseState): void {
	if (state.server) return;
	try {
		state.server = startCollabDirectory(state.options, () => leaseOrigins(state));
	} catch (err) {
		// Port taken: another omp process serves the same registry. Keep quiet and retry.
		logger.debug("Collab directory port unavailable; another process may serve it", { error: String(err) });
	}
}

/**
 * Take part in serving the local directory for as long as a host is published.
 * `webOrigins` are the Collab UI origins that host's links point at, so a
 * self-hosted UI is allowed to call the directory.
 */
export function acquireCollabDirectory(
	webOrigins: readonly string[] = [],
	options: CollabDirectoryOptions = {},
): CollabDirectoryLease {
	const state: LeaseState = (shared ??= { options, leases: new Map(), server: null, retry: null });
	const id = Symbol("collab-directory-lease");
	state.leases.set(id, webOrigins);
	tryBind(state);
	if (!state.server && !state.retry) {
		state.retry = setInterval(() => tryBind(state), RETRY_BIND_MS);
		state.retry.unref();
	}
	if (state.server && state.retry) {
		clearInterval(state.retry);
		state.retry = null;
	}
	return {
		release(): void {
			if (!state.leases.delete(id) || state.leases.size > 0) return;
			if (state.retry) clearInterval(state.retry);
			const server = state.server;
			if (shared === state) shared = null;
			void server?.close().catch(err => logger.warn("Collab directory stop failed", { error: String(err) }));
		},
	};
}
