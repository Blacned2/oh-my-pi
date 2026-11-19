/**
 * AsyaPM organizations: one API token per organization (kurum).
 *
 * Stored in `asyapm.json` under the agent dir so the agent tool, the
 * `omp asyapm` CLI, and the desktop panel (which shells out to the CLI) share
 * one source of truth. Tokens are secrets: the file is written owner-only.
 */
import { getAsyapmConfigPath, isEnoent, isRecord } from "@oh-my-pi/pi-utils";

export const ASYAPM_DEFAULT_BASE_URL = "https://api.asyapm.com";

/** Token prefix minted by AsyaPM (`ApiTokenService.Prefix`). */
export const ASYAPM_TOKEN_PREFIX = "asyapm_";

export interface AsyapmOrg {
	/** User-chosen organization label, unique case-insensitively. */
	name: string;
	/** API origin, e.g. `https://api.asyapm.com` (no trailing slash). */
	baseUrl: string;
	token: string;
}

/** Org as shown to the agent/desktop: the token reduced to its non-secret prefix. */
export interface AsyapmOrgSummary {
	name: string;
	baseUrl: string;
	tokenPrefix: string;
}

export class AsyapmConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AsyapmConfigError";
	}
}

export function summarizeOrg(org: AsyapmOrg): AsyapmOrgSummary {
	return { name: org.name, baseUrl: org.baseUrl, tokenPrefix: org.token.slice(0, 14) };
}

export function normalizeBaseUrl(raw: string | undefined): string {
	const value = (raw ?? "").trim() || ASYAPM_DEFAULT_BASE_URL;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AsyapmConfigError(`Invalid AsyaPM base URL: ${value}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new AsyapmConfigError(`AsyaPM base URL must be http(s): ${value}`);
	}
	return url.origin;
}

function parseOrg(value: unknown, index: number): AsyapmOrg {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		typeof value.baseUrl !== "string" ||
		typeof value.token !== "string"
	) {
		throw new AsyapmConfigError(`asyapm.json: orgs[${index}] needs string name, baseUrl, token`);
	}
	return { name: value.name, baseUrl: value.baseUrl, token: value.token };
}

export async function loadAsyapmOrgs(configPath = getAsyapmConfigPath()): Promise<AsyapmOrg[]> {
	let data: unknown;
	try {
		data = await Bun.file(configPath).json();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	if (!isRecord(data) || !Array.isArray(data.orgs)) {
		throw new AsyapmConfigError(`${configPath}: expected { "orgs": [...] }`);
	}
	return data.orgs.map(parseOrg);
}

export async function saveAsyapmOrgs(orgs: readonly AsyapmOrg[], configPath = getAsyapmConfigPath()): Promise<void> {
	await Bun.write(configPath, `${JSON.stringify({ orgs }, null, 2)}\n`, { mode: 0o600 });
}

function sameName(a: string, b: string): boolean {
	return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * Pick the org a call targets. A name is required once more than one org is
 * configured, so a token is never chosen implicitly for the wrong organization.
 */
export function selectOrg(orgs: readonly AsyapmOrg[], name: string | undefined): AsyapmOrg {
	if (orgs.length === 0) {
		throw new AsyapmConfigError("No AsyaPM organization configured. Add one with `omp asyapm org-set`.");
	}
	const wanted = name?.trim();
	if (!wanted) {
		if (orgs.length === 1) return orgs[0];
		throw new AsyapmConfigError(
			`Several AsyaPM organizations configured; pass org (one of: ${orgs.map(o => o.name).join(", ")}).`,
		);
	}
	const org = orgs.find(o => sameName(o.name, wanted));
	if (!org) {
		throw new AsyapmConfigError(
			`Unknown AsyaPM organization "${wanted}" (configured: ${orgs.map(o => o.name).join(", ") || "none"}).`,
		);
	}
	return org;
}

/** Insert or replace (by name, case-insensitive) and return the new list. */
export function upsertOrg(orgs: readonly AsyapmOrg[], org: AsyapmOrg): AsyapmOrg[] {
	const name = org.name.trim();
	if (!name) throw new AsyapmConfigError("Organization name is required.");
	const token = org.token.trim();
	if (!token.startsWith(ASYAPM_TOKEN_PREFIX)) {
		throw new AsyapmConfigError(`AsyaPM tokens start with "${ASYAPM_TOKEN_PREFIX}".`);
	}
	const next: AsyapmOrg = { name, baseUrl: normalizeBaseUrl(org.baseUrl), token };
	const index = orgs.findIndex(o => sameName(o.name, name));
	if (index === -1) return [...orgs, next];
	return orgs.map((o, i) => (i === index ? next : o));
}

export function removeOrg(orgs: readonly AsyapmOrg[], name: string): AsyapmOrg[] {
	const next = orgs.filter(o => !sameName(o.name, name.trim()));
	if (next.length === orgs.length) throw new AsyapmConfigError(`Unknown AsyaPM organization "${name}".`);
	return next;
}
