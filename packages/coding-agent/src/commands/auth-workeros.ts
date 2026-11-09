/**
 * Import the Claude accounts connected in the Worker OS desktop app.
 *
 * Worker OS keeps its runtime settings as one JSON document in the `Setting`
 * table of `%APPDATA%/com.workeros.desktop/sidecar/sidecar.db` (key
 * `sidecar.runtime`). `headless.accounts` lists `{ id, name, token }`, where
 * `token` is a long-lived `claude setup-token` bearer, sealed on Windows with
 * DPAPI for the current user (`dpapi:<base64>`).
 *
 * A setup-token has no refresh token and lives about a year, so each account
 * becomes an Anthropic OAuth credential with an empty refresh slot and a
 * one-year expiry: omp never tries to refresh it, uses it as a Claude
 * subscription bearer, and rotates across the imported accounts like any
 * other set of `/login` accounts.
 */
import { Database } from "bun:sqlite";
import * as path from "node:path";
import type { OAuthCredential } from "@oh-my-pi/pi-ai";
import { fetchAnthropicBootstrapIdentity } from "@oh-my-pi/pi-ai/oauth/anthropic";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import { AUTH_EXPORT_VERSION, type AuthExport, AuthTransferError } from "./auth";

/** Prefix Worker OS puts on DPAPI-sealed secrets. */
export const WORKEROS_PROTECTED_PREFIX = "dpapi:";
/** Lifetime of a `claude setup-token` bearer. */
export const SETUP_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const SETTINGS_KEY = "sidecar.runtime";
const TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** One Claude account as Worker OS stores it, token possibly still sealed. */
export interface WorkerOsAccount {
	id: string;
	name: string;
	token: string;
	active: boolean;
}

/** Default location of the Worker OS sidecar database, or null off Windows. */
export function defaultWorkerOsDbPath(): string | null {
	const appData = process.env.APPDATA;
	if (!appData) return null;
	return path.join(appData, "com.workeros.desktop", "sidecar", "sidecar.db");
}

/** Accounts listed in a Worker OS `sidecar.runtime` settings document. */
export function parseWorkerOsAccounts(value: unknown): WorkerOsAccount[] {
	const doc = typeof value === "string" ? safeJson(value) : value;
	if (!isRecord(doc) || !isRecord(doc.headless)) return [];
	const { accounts, activeAccountId } = doc.headless;
	if (!Array.isArray(accounts)) return [];
	const result: WorkerOsAccount[] = [];
	for (const entry of accounts) {
		if (!isRecord(entry)) continue;
		const { id, name, token } = entry;
		if (typeof id !== "string" || typeof token !== "string" || token.length === 0) continue;
		result.push({
			id,
			name: typeof name === "string" && name.trim().length > 0 ? name.trim() : id,
			token,
			active: id === activeAccountId,
		});
	}
	return result;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Read the accounts (tokens still sealed) from a Worker OS sidecar database. */
export function readWorkerOsAccounts(dbPath: string): WorkerOsAccount[] {
	let db: Database;
	try {
		db = new Database(dbPath, { readonly: true });
	} catch (error) {
		throw new AuthTransferError(`cannot open Worker OS database ${dbPath}: ${String(error)}`);
	}
	try {
		const row = db.query("SELECT value FROM Setting WHERE key = ?").get(SETTINGS_KEY) as { value?: unknown } | null;
		if (!row || typeof row.value !== "string") {
			throw new AuthTransferError(`${dbPath} has no "${SETTINGS_KEY}" settings row.`);
		}
		return parseWorkerOsAccounts(row.value);
	} finally {
		db.close();
	}
}

const UNPROTECT_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
	"$stdin = New-Object System.IO.StreamReader ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding $false)",
	"Add-Type -AssemblyName System.Security",
	"$items = @($stdin.ReadToEnd() | ConvertFrom-Json | ForEach-Object { $_ })",
	"$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
	"$out = @($items | ForEach-Object { try { [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$_), $null, $scope)) } catch { '' } })",
	"[Console]::Out.Write((ConvertTo-Json -InputObject $out -Compress))",
].join("; ");

/**
 * Open DPAPI-sealed values for the current Windows user. Values travel over
 * stdin/stdout, never the command line. Unreadable values come back as "".
 */
export async function unprotectDpapi(values: readonly string[]): Promise<string[]> {
	if (values.length === 0) return [];
	if (process.platform !== "win32") {
		throw new AuthTransferError("Worker OS tokens are DPAPI-sealed; they can only be opened on Windows.");
	}
	const child = Bun.spawn(
		["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", UNPROTECT_SCRIPT],
		{ stdin: Buffer.from(JSON.stringify(values)), stdout: "pipe", stderr: "pipe", windowsHide: true },
	);
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (exitCode !== 0) {
		const stderr = await new Response(child.stderr).text();
		throw new AuthTransferError(`DPAPI unprotect failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	const parsed = safeJson(stdout.trim() || "[]");
	const list = Array.isArray(parsed) ? parsed : [parsed];
	return values.map((_, index) => (typeof list[index] === "string" ? (list[index] as string) : ""));
}

/** Replace every `dpapi:` token with its plain value. */
export async function unsealWorkerOsAccounts(
	accounts: readonly WorkerOsAccount[],
	unprotect: (values: readonly string[]) => Promise<string[]> = unprotectDpapi,
): Promise<WorkerOsAccount[]> {
	const sealed = accounts
		.map((account, index) => ({ account, index }))
		.filter(entry => entry.account.token.startsWith(WORKEROS_PROTECTED_PREFIX));
	const opened = await unprotect(sealed.map(entry => entry.account.token.slice(WORKEROS_PROTECTED_PREFIX.length)));
	const result = accounts.map(account => ({ ...account }));
	sealed.forEach((entry, i) => {
		result[entry.index].token = opened[i] ?? "";
	});
	return result;
}

/** Identity Anthropic reports for a bearer; empty when it cannot be resolved. */
export type IdentityResolver = (
	token: string,
) => Promise<{ accountId?: string; email?: string; orgId?: string; orgName?: string }>;

const bootstrapIdentity: IdentityResolver = async token => {
	try {
		return await fetchAnthropicBootstrapIdentity(token, fetch);
	} catch (error) {
		logger.debug("Worker OS import: bootstrap identity lookup failed", { error: String(error) });
		return {};
	}
};

/** Result of {@link buildWorkerOsImport}. */
export interface WorkerOsImportPlan {
	data: AuthExport;
	/** One line per account: what is imported, or why it is skipped. */
	report: { name: string; imported: boolean; reason?: string; identity?: string }[];
}

/**
 * Turn unsealed Worker OS accounts into an `omp auth import` document for the
 * `anthropic` provider. The account name doubles as the email when it is one
 * (Worker OS operators name accounts by their login email); Anthropic's
 * bootstrap identity wins when it answers.
 */
export async function buildWorkerOsImport(
	accounts: readonly WorkerOsAccount[],
	options: { now?: number; resolveIdentity?: IdentityResolver } = {},
): Promise<WorkerOsImportPlan> {
	const now = options.now ?? Date.now();
	const resolveIdentity = options.resolveIdentity ?? bootstrapIdentity;
	const report: WorkerOsImportPlan["report"] = [];
	const credentials: AuthExport["credentials"] = [];
	const seen = new Set<string>();
	for (const account of accounts) {
		const token = account.token.replace(/\s+/g, "");
		if (!TOKEN_PATTERN.test(token)) {
			report.push({
				name: account.name,
				imported: false,
				reason: token.length === 0 ? "token could not be decrypted" : "not a Claude token",
			});
			continue;
		}
		if (seen.has(token)) {
			report.push({ name: account.name, imported: false, reason: "duplicate token" });
			continue;
		}
		seen.add(token);
		const identity = await resolveIdentity(token);
		const nameEmail = EMAIL_PATTERN.test(account.name) ? account.name.toLowerCase() : undefined;
		const email = identity.email ?? nameEmail;
		const credential: OAuthCredential = {
			type: "oauth",
			access: token,
			refresh: "",
			expires: now + SETUP_TOKEN_TTL_MS,
			...(email ? { email } : {}),
			// Without an email the Worker OS account id keeps the rows apart.
			accountId: identity.accountId ?? (email ? undefined : `workeros:${account.id}`),
			...(identity.orgId ? { orgId: identity.orgId } : {}),
			...(identity.orgName ? { orgName: identity.orgName } : {}),
		};
		if (credential.accountId === undefined) delete credential.accountId;
		credentials.push({ provider: "anthropic", credential });
		report.push({
			name: account.name,
			imported: true,
			identity: [email, identity.orgName].filter(Boolean).join(" / ") || credential.accountId,
		});
	}
	return { data: { version: AUTH_EXPORT_VERSION, credentials }, report };
}
