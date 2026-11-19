import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { buildIssueBrief } from "../src/asyapm/brief";
import { encodeRawPng } from "../src/utils/png-encode";

const BASE = "https://api.test";
const SIGNED = `${BASE}/files/a.png?tenant=2&token=SECRET-TOKEN`;

function png(width: number, height: number): Buffer {
	return encodeRawPng(new Uint8Array(width * height * 3).fill(200), width, height, 3);
}

const issue = {
	id: 7,
	key: "WEB-7",
	summary: "Ana bileşene hammadde eklenemiyor",
	description: `<p>Ekran:</p><img src="${SIGNED.replace("&", "&amp;")}"><p>Bozuk: <img src="https://cdn.example/missing.png"></p>`,
	labels: [],
	status: "To Do",
	statusDisplay: "To Do",
	statusId: 1,
	statusCategory: "todo",
	pendingApproval: false,
	issueType: "Story",
	issueTypeDisplay: "Hikâye",
	priority: null,
	priorityDisplay: null,
	projectId: 3,
	assigneeId: null,
	assigneeName: null,
	reporterId: 1,
	reporterName: "Evren",
	createdAtUtc: "2026-11-17T08:00:00Z",
	updatedAtUtc: "2026-11-17T08:00:00Z",
};

const comments = [
	{
		id: 1,
		authorId: 1,
		authorName: "Evren",
		body: `<p>Aynısı <img src="${SIGNED.replace("&", "&amp;")}"> ve <img src="/files/b.png"></p>`,
		isInternal: true,
		createdAtUtc: "2026-11-17T09:30:00Z",
		updatedAtUtc: null,
	},
];

const imageA = png(240, 220);
const imageB = png(220, 240);

const fakeFetch: FetchImpl = async input => {
	const url = input instanceof Request ? input.url : String(input);
	if (url === `${BASE}/api/public/v1/issues/7`) return Response.json(issue);
	if (url === `${BASE}/api/public/v1/issues/7/comments`) return Response.json(comments);
	if (url === SIGNED) return new Response(imageA, { headers: { "content-type": "image/png" } });
	if (url === `${BASE}/files/b.png`) return new Response(imageB, { headers: { "content-type": "image/png" } });
	return new Response("not found", { status: 404 });
};

describe("buildIssueBrief", () => {
	it("labels each embedded image with the number of its attachment and keeps signed URLs out of the text", async () => {
		const brief = await buildIssueBrief(
			{ name: "acme", baseUrl: BASE, token: "asyapm_test" },
			7,
			{ instruction: "Önce sadece analiz et", note: "Repo: ASP.NET WebForms" },
			fakeFetch,
		);

		// Same source in description and comment → one attachment; relative src resolves against the API origin.
		expect(brief.images.map(image => image.data)).toEqual([imageA.toBase64(), imageB.toBase64()]);
		expect(brief.prompt.match(/\[Görsel 1\]/g)).toHaveLength(2);
		expect(brief.prompt).toContain("[Görsel 2]");
		// A failed download is labeled, never numbered, so numbers stay aligned with attachments.
		expect(brief.prompt).toContain("[Görsel alınamadı]");
		expect(brief.prompt).not.toContain("[Görsel 3]");
		expect(brief.prompt).not.toContain("SECRET-TOKEN");
		expect(brief.prompt).not.toContain("cdn.example");
		expect(brief.prompt).toContain("Önce sadece analiz et");
		expect(brief.prompt).toContain("Repo: ASP.NET WebForms");
	});
});
