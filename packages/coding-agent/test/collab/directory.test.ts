import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type CollabDirectoryServer,
	readOrCreateDirectoryToken,
	startCollabDirectory,
} from "@oh-my-pi/pi-coding-agent/collab/directory";
import {
	type CollabHostPublication,
	type CollabHostSnapshot,
	listCollabHosts,
	publishCollabHost,
} from "@oh-my-pi/pi-coding-agent/collab/registry";
import { COLLAB_DIRECTORY_LINK_PATH, COLLAB_DIRECTORY_SESSIONS_PATH } from "@oh-my-pi/pi-wire";

const WEB_ORIGIN = "https://my.omp.sh";
const cleanupDirs: string[] = [];
const publications: CollabHostPublication[] = [];
const servers: CollabDirectoryServer[] = [];

afterEach(async () => {
	for (const pub of publications.splice(0)) await pub.close().catch(() => {});
	for (const server of servers.splice(0)) await server.close();
	for (const dir of cleanupDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Harness {
	dir: string;
	base: string;
	token: string;
	port: number;
}

async function harness(): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-collab-directory-"));
	cleanupDirs.push(dir);
	const server = startCollabDirectory({ dir, port: 0 }, () => new Set([WEB_ORIGIN]));
	servers.push(server);
	const token = await readOrCreateDirectoryToken({ dir });
	return { dir, base: `http://127.0.0.1:${server.port}`, token, port: server.port };
}

interface HostFixture {
	snapshot: CollabHostSnapshot;
	roomKey: string;
	viewUrl: string;
	controlUrl: string;
}

async function publishHost(dir: string, over: Partial<CollabHostSnapshot> = {}): Promise<HostFixture> {
	const roomKey = `ROOMKEY-${crypto.randomBytes(6).toString("hex")}`;
	const writeToken = `WRITETOKEN-${crypto.randomBytes(6).toString("hex")}`;
	const fixture: HostFixture = {
		snapshot: {
			instanceId: crypto.randomBytes(8).toString("hex"),
			generation: 1,
			sessionId: "sess-1",
			sessionName: "Fixture Session",
			cwd: "/tmp/fixture-cwd",
			pid: process.pid,
			model: { provider: "test", id: "fixture-model" },
			startedAt: 1_700_000_000_000,
			participants: 2,
			relayConnected: true,
			inputRequired: false,
			busy: false,
			access: "control",
			...over,
		},
		roomKey,
		viewUrl: `https://collab.example/view/#room=${roomKey}`,
		controlUrl: `https://collab.example/control/#room=${roomKey}&k=${writeToken}`,
	};
	const pub = await publishCollabHost(
		{
			snapshot: () => fixture.snapshot,
			link: access => (access === "view" ? fixture.viewUrl : fixture.controlUrl),
		},
		{ dir, instanceId: fixture.snapshot.instanceId },
	);
	publications.push(pub);
	return fixture;
}

function auth(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
	return { Authorization: `Bearer ${h.token}`, ...extra };
}

function postLink(h: Harness, body: object, headers: Record<string, string> = auth(h)): Promise<Response> {
	return fetch(`${h.base}${COLLAB_DIRECTORY_LINK_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("collab directory", () => {
	describe("pairing token", () => {
		it("is created owner-only, is stable, and survives registry pruning", async () => {
			const h = await harness();
			expect(await readOrCreateDirectoryToken({ dir: h.dir })).toBe(h.token);
			if (process.platform !== "win32") {
				const stat = await fs.stat(path.join(h.dir, "directory-token"));
				expect(stat.mode & 0o777).toBe(0o600);
			}
			await listCollabHosts({ dir: h.dir });
			expect(await readOrCreateDirectoryToken({ dir: h.dir })).toBe(h.token);
		});
	});

	describe("access control", () => {
		it("answers 401 without a token or with a wrong one, before revealing anything", async () => {
			const h = await harness();
			await publishHost(h.dir);
			const url = `${h.base}${COLLAB_DIRECTORY_SESSIONS_PATH}`;
			expect((await fetch(url)).status).toBe(401);
			expect((await fetch(url, { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
			expect((await fetch(url, { headers: { Authorization: h.token } })).status).toBe(401);
		});

		it("refuses a foreign browser origin even with a valid token", async () => {
			const h = await harness();
			const res = await fetch(`${h.base}${COLLAB_DIRECTORY_SESSIONS_PATH}`, {
				headers: auth(h, { Origin: "https://evil.example" }),
			});
			expect(res.status).toBe(403);
			expect(res.headers.get("access-control-allow-origin")).toBeNull();
		});

		it("refuses a Host header that is not loopback on this port (DNS rebinding)", async () => {
			const h = await harness();
			const res = await fetch(`${h.base}${COLLAB_DIRECTORY_SESSIONS_PATH}`, {
				headers: auth(h, { Host: `rebind.example:${h.port}` }),
			});
			expect(res.status).toBe(403);
		});

		it("answers the CORS preflight for the web UI without needing a token", async () => {
			const h = await harness();
			const res = await fetch(`${h.base}${COLLAB_DIRECTORY_SESSIONS_PATH}`, {
				method: "OPTIONS",
				headers: { Origin: WEB_ORIGIN, "Access-Control-Request-Private-Network": "true" },
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
			expect(res.headers.get("access-control-allow-private-network")).toBe("true");
		});
	});

	describe("session list", () => {
		it("lists live hosts with metadata only: no URL, room key or write token", async () => {
			const h = await harness();
			const first = await publishHost(h.dir, { sessionName: "alpha" });
			const second = await publishHost(h.dir, { sessionName: "beta", generation: 4, access: "view" });
			const res = await fetch(`${h.base}${COLLAB_DIRECTORY_SESSIONS_PATH}`, {
				headers: auth(h, { Origin: WEB_ORIGIN }),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(res.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
			const text = await res.text();
			expect(text).not.toContain(first.roomKey);
			expect(text).not.toContain("WRITETOKEN");
			expect(text).not.toContain("https://collab.example");
			const body = JSON.parse(text) as {
				sessions: { instanceId: string; generation: number; sessionName: string }[];
			};
			const byId = new Map(body.sessions.map(s => [s.instanceId, s]));
			expect(byId.get(first.snapshot.instanceId)?.sessionName).toBe("alpha");
			expect(byId.get(second.snapshot.instanceId)?.generation).toBe(4);
		});
	});

	describe("link", () => {
		it("hands out the link for the exact instance and generation the user picked", async () => {
			const h = await harness();
			const host = await publishHost(h.dir, { generation: 3 });
			const res = await postLink(h, { instanceId: host.snapshot.instanceId, generation: 3, access: "view" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { url: string; generation: number; access: string };
			expect(body.url).toBe(host.viewUrl);
			expect(body.generation).toBe(3);
			expect(body.access).toBe("view");
		});

		it("answers 409 without the link when the room rotated since the listing", async () => {
			const h = await harness();
			const host = await publishHost(h.dir, { generation: 2 });
			const res = await postLink(h, { instanceId: host.snapshot.instanceId, generation: 1, access: "control" });
			expect(res.status).toBe(409);
			const text = await res.text();
			expect(text).not.toContain(host.roomKey);
			expect(text).not.toContain("https://");
		});

		it("answers 404 for an unknown instance", async () => {
			const h = await harness();
			await publishHost(h.dir);
			const res = await postLink(h, { instanceId: "ffffffffffffffff", generation: 1, access: "control" });
			expect(res.status).toBe(404);
		});

		it("rejects malformed requests and non-POST access to the link route", async () => {
			const h = await harness();
			const host = await publishHost(h.dir);
			const id = host.snapshot.instanceId;
			expect((await postLink(h, { instanceId: id, generation: 0, access: "view" })).status).toBe(400);
			expect((await postLink(h, { instanceId: id, generation: 1.5, access: "view" })).status).toBe(400);
			expect((await postLink(h, { instanceId: id, generation: 1, access: "admin" })).status).toBe(400);
			expect((await postLink(h, { instanceId: "../etc", generation: 1, access: "view" })).status).toBe(400);
			expect(
				(await fetch(`${h.base}${COLLAB_DIRECTORY_LINK_PATH}?instanceId=${id}`, { headers: auth(h) })).status,
			).toBe(404);
		});

		it("requires the token for link requests too", async () => {
			const h = await harness();
			const host = await publishHost(h.dir);
			const res = await postLink(h, { instanceId: host.snapshot.instanceId, generation: 1, access: "view" }, {});
			expect(res.status).toBe(401);
			expect(await res.text()).not.toContain(host.roomKey);
		});
	});
});
