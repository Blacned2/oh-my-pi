import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { webpExclusionForModel } from "@oh-my-pi/pi-tui/chat/image-loading";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { AsyapmApiError, AsyapmClient, type AsyapmIssue } from "../asyapm/client";
import { AsyapmConfigError, loadAsyapmOrgs, selectOrg, summarizeOrg } from "../asyapm/config";
import { issueContent } from "../asyapm/content";
import asyapmDescription from "../prompts/tools/asyapm.md" with { type: "text" };
import type { ToolSession } from "./index";
import { cfgAsyapmEnabled } from "./settings";

const asyapmSchema = type({
	op: type("'orgs' | 'projects' | 'board' | 'issues' | 'issue' | 'set_status' | 'comment'").describe(
		"asyapm operation",
	),
	"org?": type("string").describe("organization name; required when several are configured"),
	"project_id?": type("number.integer >= 1").describe("project id (board; filter for issues)"),
	"status?": type("string").describe("comma-separated canonical status names (issues filter)"),
	"label?": type("string").describe("exact label name (issues filter)"),
	"page?": type("number.integer >= 1").describe("issues page, 1-based"),
	"page_size?": type("number.integer >= 1").describe("issues page size, max 200"),
	"issue_id?": type("number.integer >= 1").describe("numeric issue id (issue, set_status, comment)"),
	"status_id?": type("number.integer >= 1").describe("target status id from board (set_status)"),
	"body?": type("string").describe("plain-text comment (comment)"),
});

type AsyapmParams = typeof asyapmSchema.infer;

export interface AsyapmToolDetails {
	op: AsyapmParams["op"];
	org?: string;
	issueId?: number;
	url?: string;
}

const READ_OPS: Record<string, true> = { orgs: true, projects: true, board: true, issues: true, issue: true };

function requireId(value: number | undefined, label: string): number {
	if (value === undefined) throw new ToolError(`${label} is required for this op`);
	return value;
}

function issueLine(issue: AsyapmIssue): string {
	const parts = [
		`#${issue.id} ${issue.key}`,
		`[${issue.statusDisplay || issue.status}]`,
		issue.summary,
		issue.priorityDisplay ? `prio:${issue.priorityDisplay}` : undefined,
		issue.assigneeName ? `@${issue.assigneeName}` : "unassigned",
		issue.labels.length > 0 ? `labels:${issue.labels.join(",")}` : undefined,
	];
	return parts.filter(Boolean).join(" · ");
}

export class AsyapmTool implements AgentTool<typeof asyapmSchema, AsyapmToolDetails> {
	readonly name = "asyapm";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const op = (args as Partial<AsyapmParams>).op;
		return typeof op === "string" && Object.hasOwn(READ_OPS, op) ? "read" : "exec";
	};
	readonly label = "AsyaPM";
	readonly loadMode = "discoverable";
	readonly summary = "Read and update AsyaPM issues (tasks) per organization";
	readonly description = asyapmDescription.trim();
	readonly parameters = asyapmSchema;
	readonly strict = true;

	constructor(readonly session: ToolSession) {}

	/** Present only while at least one organization is configured. */
	static async createIf(session: ToolSession): Promise<AsyapmTool | null> {
		try {
			if ((await loadAsyapmOrgs()).length === 0) return null;
		} catch (err) {
			logger.warn("AsyaPM config unreadable; asyapm tool disabled", { error: String(err) });
			return null;
		}
		return new AsyapmTool(session);
	}

	async execute(
		_toolCallId: string,
		params: AsyapmParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<AsyapmToolDetails>> {
		if (!cfgAsyapmEnabled.get(this.session.settings)) {
			throw new ToolError("AsyaPM is disabled. Enable asyapm.enabled before using the asyapm tool.");
		}
		return untilAborted(signal, async () => {
			try {
				return await this.#run(params, signal);
			} catch (err) {
				if (err instanceof AsyapmApiError || err instanceof AsyapmConfigError) throw new ToolError(err.message);
				throw err;
			}
		});
	}

	async #run(params: AsyapmParams, signal: AbortSignal | undefined): Promise<AgentToolResult<AsyapmToolDetails>> {
		const orgs = await loadAsyapmOrgs();
		if (params.op === "orgs") {
			const lines = orgs.map(o => {
				const s = summarizeOrg(o);
				return `${s.name} · ${s.baseUrl} · ${s.tokenPrefix}…`;
			});
			return text(lines.join("\n") || "No organization configured.", { op: params.op });
		}

		const org = selectOrg(orgs, params.org);
		const client = new AsyapmClient(org, this.session.fetch);
		const details: AsyapmToolDetails = { op: params.op, org: org.name };

		switch (params.op) {
			case "projects": {
				const projects = await client.projects(signal);
				const lines = projects.map(p => `${p.id} ${p.key} · ${p.name} · ${p.type}`);
				return text(lines.join("\n") || "No visible projects.", details);
			}
			case "board": {
				const board = await client.board(requireId(params.project_id, "project_id"), signal);
				const lines = [`${board.projectKey} · ${board.boardName} (${board.mode})`];
				for (const column of board.columns) {
					const statuses = column.statuses.map((name, i) => `${name}=${column.statusIds[i]}`).join(", ");
					lines.push(`- ${column.name}${column.wipLimit ? ` (WIP ${column.wipLimit})` : ""}: ${statuses}`);
				}
				return text(lines.join("\n"), details);
			}
			case "issues": {
				const page = await client.issues(
					{
						projectId: params.project_id,
						status: params.status,
						label: params.label,
						page: params.page,
						pageSize: params.page_size,
					},
					signal,
				);
				const lines = [`${page.total} issue(s); page ${page.page}, size ${page.pageSize}`];
				for (const issue of page.items) lines.push(issueLine(issue));
				return text(lines.join("\n"), details);
			}
			case "issue": {
				const issueId = requireId(params.issue_id, "issue_id");
				const [issue, comments] = await Promise.all([
					client.issue(issueId, signal),
					client.comments(issueId, signal),
				]);
				const url = client.issueWebUrl(issue.key);
				const content = await issueContent(issue, comments, org.baseUrl, {
					fetch: this.session.fetch,
					signal,
					excludeWebP: webpExclusionForModel(this.session.getActiveModel?.()),
				});
				const lines = [
					issueLine(issue),
					`type: ${issue.issueTypeDisplay} · status: ${issue.status} (id ${issue.statusId}, ${issue.statusCategory})${issue.pendingApproval ? " · pending approval" : ""}`,
					`project: ${issue.projectId} · reporter: ${issue.reporterName ?? "-"} · updated: ${issue.updatedAtUtc}`,
					`url: ${url}`,
					"",
					content.description || "(no description)",
				];
				if (comments.length > 0) lines.push("", `Comments (${comments.length}):`);
				comments.forEach((comment, i) => {
					lines.push(
						`--- ${comment.authorName} · ${comment.createdAtUtc}${comment.isInternal ? " · internal" : ""}`,
					);
					lines.push(content.comments[i]);
				});
				if (content.images.length > 0)
					lines.push(
						"",
						`${content.images.length} image(s) attached below in order; [Görsel N] in the text is the N-th.`,
					);
				return {
					content: [{ type: "text", text: lines.join("\n") }, ...content.images],
					details: { ...details, issueId, url },
				};
			}
			case "set_status": {
				const issueId = requireId(params.issue_id, "issue_id");
				const result = await client.setStatus(issueId, requireId(params.status_id, "status_id"), signal);
				return text(`#${result.id} → ${result.status} (status id ${result.statusId})`, { ...details, issueId });
			}
			case "comment": {
				const issueId = requireId(params.issue_id, "issue_id");
				const body = params.body?.trim();
				if (!body) throw new ToolError("body is required for comment");
				const result = await client.addComment(issueId, body, signal);
				return text(`Comment ${result.id} added to #${issueId}.`, { ...details, issueId });
			}
		}
	}
}

function text(value: string, details: AsyapmToolDetails): AgentToolResult<AsyapmToolDetails> {
	return { content: [{ type: "text", text: value }], details };
}
