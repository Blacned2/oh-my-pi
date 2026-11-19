/**
 * AsyaPM organizations and issues from the command line.
 *
 * Machine interface: every action prints one JSON document on stdout; failures
 * print `{ "error": { "message", "status"?, "code"? } }` and exit 1. The desktop
 * AsyaPM panel drives this command, so output shapes are a contract.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type AsyapmBriefInput, buildIssueBrief } from "../asyapm/brief";
import { AsyapmApiError, AsyapmClient } from "../asyapm/client";
import {
	type AsyapmOrg,
	AsyapmConfigError,
	loadAsyapmOrgs,
	normalizeBaseUrl,
	removeOrg,
	saveAsyapmOrgs,
	selectOrg,
	summarizeOrg,
	upsertOrg,
} from "../asyapm/config";
import { asyapmHelp as commandHelp } from "../cli/command-help";

const ACTIONS = [
	"orgs",
	"org-set",
	"org-remove",
	"projects",
	"board",
	"issues",
	"issue",
	"comments",
	"set-status",
	"comment",
	"brief",
] as const;

type Action = (typeof ACTIONS)[number];

function required<T>(value: T | undefined, flag: string): T {
	if (value === undefined || value === "") throw new CliUsageError(`--${flag} is required for this action`);
	return value;
}

export default class Asyapm extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "Action", required: true, options: [...ACTIONS] }),
	};

	static flags = {
		org: Flags.string({ description: "Organization name (required when several are configured)" }),
		name: Flags.string({ description: "Organization name (org-set, org-remove)" }),
		token: Flags.string({ description: "API token for org-set; read from stdin when omitted" }),
		"base-url": Flags.string({ description: "API origin for org-set (default https://api.asyapm.com)" }),
		project: Flags.integer({ description: "Project id" }),
		status: Flags.string({ description: "Comma-separated canonical status names (issues)" }),
		label: Flags.string({ description: "Exact label name (issues)" }),
		page: Flags.integer({ description: "Page, 1-based (issues)" }),
		"page-size": Flags.integer({ description: "Page size, max 200 (issues)" }),
		id: Flags.integer({ description: "Issue id" }),
		"status-id": Flags.integer({ description: "Target status id (set-status)" }),
		body: Flags.string({ description: "Plain-text comment; read from stdin when omitted (comment)" }),
	};

	static examples = [
		"# Add or replace an organization (token from stdin keeps it out of the process list)\n  echo asyapm_… | omp asyapm org-set --name goldtakas",
		"# Open issues of a project\n  omp asyapm issues --org goldtakas --project 3 --status 'To Do,In Progress'",
		"# Move an issue (status ids come from `board`)\n  omp asyapm set-status --org goldtakas --id 812 --status-id 4",
		'# Agent hand-off message + attached images; optional instruction/note as JSON on stdin\n  echo \'{"instruction":"Önce sadece analiz et"}\' | omp asyapm brief --org goldtakas --id 812',
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Asyapm);
		try {
			const result = await runAction(args.action as Action, flags);
			process.stdout.write(`${JSON.stringify(result)}\n`);
		} catch (err) {
			if (err instanceof CliUsageError) throw err;
			if (!(err instanceof AsyapmApiError || err instanceof AsyapmConfigError)) throw err;
			const error =
				err instanceof AsyapmApiError
					? { message: err.message, status: err.status, code: err.code }
					: { message: err.message };
			process.stdout.write(`${JSON.stringify({ error })}\n`);
			process.exitCode = 1;
		}
	}
}

interface AsyapmFlags {
	org?: string;
	name?: string;
	token?: string;
	"base-url"?: string;
	project?: number;
	status?: string;
	label?: string;
	page?: number;
	"page-size"?: number;
	id?: number;
	"status-id"?: number;
	body?: string;
}

async function readStdinValue(flag: string): Promise<string> {
	if (process.stdin.isTTY) throw new CliUsageError(`--${flag} is required (or pipe it on stdin)`);
	return (await Bun.stdin.text()).trim();
}

/** `brief` stdin: optional JSON `{ "instruction"?: string, "note"?: string }`; none or empty → no extras. */
async function readBriefInput(): Promise<AsyapmBriefInput> {
	const text = process.stdin.isTTY ? "" : (await Bun.stdin.text()).trim();
	if (!text) return {};
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new CliUsageError('brief: stdin must be a JSON object like {"instruction": "…", "note": "…"}');
	}
	if (!isRecord(value)) throw new CliUsageError("brief: stdin must be a JSON object");
	return {
		instruction: typeof value.instruction === "string" ? value.instruction : undefined,
		note: typeof value.note === "string" ? value.note : undefined,
	};
}

async function runAction(action: Action, flags: AsyapmFlags): Promise<unknown> {
	const orgs = await loadAsyapmOrgs();
	switch (action) {
		case "orgs":
			return orgs.map(summarizeOrg);
		case "org-set": {
			const name = required(flags.name, "name");
			const token = flags.token ?? (await readStdinValue("token"));
			const candidate: AsyapmOrg = { name, baseUrl: normalizeBaseUrl(flags["base-url"]), token };
			const next = upsertOrg(orgs, candidate);
			const saved = selectOrg(next, name);
			// Verify before persisting: a mistyped token must not replace a working one.
			const me = await new AsyapmClient(saved).me();
			await saveAsyapmOrgs(next);
			return { ...summarizeOrg(saved), me };
		}
		case "org-remove": {
			await saveAsyapmOrgs(removeOrg(orgs, required(flags.name, "name")));
			return { removed: flags.name };
		}
	}

	const org = selectOrg(orgs, flags.org);
	const client = new AsyapmClient(org);
	switch (action) {
		case "projects":
			return client.projects();
		case "board":
			return client.board(required(flags.project, "project"));
		case "issues":
			return client.issues({
				projectId: flags.project,
				status: flags.status,
				label: flags.label,
				page: flags.page,
				pageSize: flags["page-size"],
			});
		case "issue": {
			const issue = await client.issue(required(flags.id, "id"));
			return { ...issue, webUrl: client.issueWebUrl(issue.key) };
		}
		case "comments":
			return client.comments(required(flags.id, "id"));
		case "set-status":
			return client.setStatus(required(flags.id, "id"), required(flags["status-id"], "status-id"));
		case "comment": {
			const body = flags.body ?? (await readStdinValue("body"));
			if (!body.trim()) throw new CliUsageError("Comment body is empty");
			return client.addComment(required(flags.id, "id"), body);
		}
		case "brief":
			return buildIssueBrief(org, required(flags.id, "id"), await readBriefInput());
	}
}
