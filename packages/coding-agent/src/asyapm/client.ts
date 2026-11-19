/**
 * Minimal client for the AsyaPM public API (`/api/public/v1`, `Authorization: Bearer asyapm_…`).
 * Shapes mirror `PublicApiEndpoints.cs`; only the fields kostomp reads are typed.
 */
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { withHardTimeout } from "../web/search/providers/utils";
import type { AsyapmOrg } from "./config";

const REQUEST_TIMEOUT_MS = 20_000;

export interface AsyapmMe {
	tokenId: number;
	userId: number;
	tenantId: number;
	projectId: number | null;
	scopes: string[];
}

export interface AsyapmProject {
	id: number;
	key: string;
	name: string;
	description: string | null;
	category: string | null;
	type: string;
}

export interface AsyapmBoardColumn {
	id: number;
	name: string;
	sortOrder: number;
	wipLimit: number | null;
	statuses: string[];
	statusIds: number[];
}

export interface AsyapmBoard {
	projectId: number;
	projectKey: string;
	projectName: string;
	boardId: number;
	boardName: string;
	mode: string;
	columns: AsyapmBoardColumn[];
}

export interface AsyapmIssue {
	id: number;
	key: string;
	summary: string;
	/** HTML; only filled by the single-issue endpoint. */
	description: string | null;
	labels: string[];
	status: string;
	statusDisplay: string;
	statusId: number;
	statusCategory: string;
	pendingApproval: boolean;
	issueType: string;
	issueTypeDisplay: string;
	priority: string | null;
	priorityDisplay: string | null;
	projectId: number;
	assigneeId: number | null;
	assigneeName: string | null;
	reporterId: number | null;
	reporterName: string | null;
	createdAtUtc: string;
	updatedAtUtc: string;
}

export interface AsyapmIssuePage {
	total: number;
	page: number;
	pageSize: number;
	items: AsyapmIssue[];
}

export interface AsyapmComment {
	id: number;
	authorId: number;
	authorName: string;
	body: string;
	isInternal: boolean;
	createdAtUtc: string;
	updatedAtUtc: string | null;
}

export interface AsyapmIssueQuery {
	projectId?: number;
	/** Comma-separated canonical status names. */
	status?: string;
	label?: string;
	page?: number;
	pageSize?: number;
}

export class AsyapmApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string,
	) {
		super(message);
		this.name = "AsyapmApiError";
	}
}

/** Pull a readable message out of `{error,message}`, ValidationProblem, or ProblemDetails bodies. */
function describeError(status: number, text: string): AsyapmApiError {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return new AsyapmApiError(status, undefined, `AsyaPM HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ""}`);
	}
	if (!isRecord(body)) return new AsyapmApiError(status, undefined, `AsyaPM HTTP ${status}`);
	const code = typeof body.error === "string" ? body.error : undefined;
	const parts: string[] = [];
	for (const key of ["message", "title", "detail"] as const) {
		if (typeof body[key] === "string") parts.push(body[key]);
	}
	if (isRecord(body.errors)) {
		for (const [field, messages] of Object.entries(body.errors)) {
			if (Array.isArray(messages)) parts.push(`${field}: ${messages.join(" ")}`);
		}
	}
	const detail = parts.join(" — ") || code || text.slice(0, 300);
	return new AsyapmApiError(status, code, `AsyaPM HTTP ${status}${code ? ` ${code}` : ""}: ${detail}`);
}

/** Plain text → the HTML the AsyaPM rich-text sanitizer keeps (paragraphs, line breaks). */
export function plainTextToHtml(text: string): string {
	const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return escaped
		.split(/\r?\n\s*\r?\n/)
		.map(p => p.trim())
		.filter(p => p.length > 0)
		.map(p => `<p>${p.replace(/\r?\n/g, "<br>")}</p>`)
		.join("");
}

export class AsyapmClient {
	readonly #org: AsyapmOrg;
	readonly #fetch: FetchImpl;

	constructor(org: AsyapmOrg, fetchImpl: FetchImpl = fetch) {
		this.#org = org;
		this.#fetch = fetchImpl;
	}

	/** Browser URL of an issue in the AsyaPM web app (`api.` host → `www.`, route `/issues/<KEY>`). */
	issueWebUrl(key: string): string {
		const url = new URL(this.#org.baseUrl);
		if (url.hostname.startsWith("api.")) url.hostname = `www.${url.hostname.slice(4)}`;
		return `${url.origin}/issues/${encodeURIComponent(key.trim().toUpperCase())}`;
	}

	async #request<T>(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<T> {
		const response = await this.#fetch(`${this.#org.baseUrl}/api/public/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.#org.token}`,
				Accept: "application/json",
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: withHardTimeout(signal, REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		if (!response.ok) throw describeError(response.status, text);
		return (text ? JSON.parse(text) : undefined) as T;
	}

	me(signal?: AbortSignal): Promise<AsyapmMe> {
		return this.#request("GET", "/me", undefined, signal);
	}

	projects(signal?: AbortSignal): Promise<AsyapmProject[]> {
		return this.#request("GET", "/projects", undefined, signal);
	}

	board(projectId: number, signal?: AbortSignal): Promise<AsyapmBoard> {
		return this.#request("GET", `/projects/${projectId}/board`, undefined, signal);
	}

	issues(query: AsyapmIssueQuery, signal?: AbortSignal): Promise<AsyapmIssuePage> {
		const params = new URLSearchParams();
		if (query.projectId !== undefined) params.set("projectId", String(query.projectId));
		if (query.status) params.set("status", query.status);
		if (query.label) params.set("label", query.label);
		if (query.page !== undefined) params.set("page", String(query.page));
		if (query.pageSize !== undefined) params.set("pageSize", String(query.pageSize));
		const qs = params.toString();
		return this.#request("GET", `/issues${qs ? `?${qs}` : ""}`, undefined, signal);
	}

	issue(issueId: number, signal?: AbortSignal): Promise<AsyapmIssue> {
		return this.#request("GET", `/issues/${issueId}`, undefined, signal);
	}

	comments(issueId: number, signal?: AbortSignal): Promise<AsyapmComment[]> {
		return this.#request("GET", `/issues/${issueId}/comments`, undefined, signal);
	}

	setStatus(
		issueId: number,
		statusId: number,
		signal?: AbortSignal,
	): Promise<{ id: number; statusId: number; status: string }> {
		return this.#request("PATCH", `/issues/${issueId}/status`, { statusId }, signal);
	}

	/** `body` is plain text; converted to sanitizer-safe HTML. */
	addComment(issueId: number, body: string, signal?: AbortSignal): Promise<{ id: number }> {
		return this.#request("POST", `/issues/${issueId}/comments`, { body: plainTextToHtml(body) }, signal);
	}
}
