/**
 * First message of an AsyaPM hand-off chat: the issue's fields, description and comments as
 * markdown, and the images they embed, attached in order behind inline `[Görsel N]` labels.
 */
import type { FetchImpl, ImageContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import handoffTemplate from "../prompts/asyapm/handoff.md" with { type: "text" };
import { AsyapmClient } from "./client";
import type { AsyapmOrg } from "./config";
import { issueContent } from "./content";

export interface AsyapmBriefInput {
	/** What the user wants done; shown first and wins over the default workflow. */
	instruction?: string;
	/** Standing context for the issue's project: repository, stack, test URL. */
	note?: string;
}

export interface AsyapmBrief {
	prompt: string;
	images: ImageContent[];
}

export async function buildIssueBrief(
	org: AsyapmOrg,
	issueId: number,
	input: AsyapmBriefInput,
	fetchImpl: FetchImpl = fetch,
	signal?: AbortSignal,
): Promise<AsyapmBrief> {
	const client = new AsyapmClient(org, fetchImpl);
	const [issue, comments] = await Promise.all([client.issue(issueId, signal), client.comments(issueId, signal)]);
	const content = await issueContent(issue, comments, org.baseUrl, { fetch: fetchImpl, signal });

	const text = prompt.render(handoffTemplate, {
		org: org.name,
		id: issue.id,
		key: issue.key,
		summary: issue.summary,
		type: issue.issueTypeDisplay || issue.issueType,
		status: issue.statusDisplay || issue.status,
		priority: issue.priorityDisplay || issue.priority,
		reporter: issue.reporterName,
		assignee: issue.assigneeName,
		labels: issue.labels.join(", "),
		webUrl: client.issueWebUrl(issue.key),
		description: content.description,
		comments: comments.map((comment, i) => ({
			author: comment.authorName,
			date: utcMinute(comment.createdAtUtc),
			internal: comment.isInternal,
			body: content.comments[i],
		})),
		imageCount: content.images.length,
		instruction: input.instruction?.trim(),
		note: input.note?.trim(),
	});
	return { prompt: text, images: content.images };
}

/** `2026-11-17T10:22:31.5Z` → `2026-11-17 10:22`. */
function utcMinute(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 16).replace("T", " ");
}
