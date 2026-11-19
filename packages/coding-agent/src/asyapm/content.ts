/**
 * AsyaPM issue text for the model: description and comments as markdown with every embedded image
 * replaced by `[Görsel N]` for the N-th downloaded image (or a "not attached" label), so signed
 * attachment URLs never reach the model. Shared by the `asyapm` tool and the desktop hand-off.
 */
import type { FetchImpl, ImageContent } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import imageLabelTemplate from "../prompts/asyapm/image-label.md" with { type: "text" };
import { resizeImage } from "../utils/image-resize";
import { htmlToBasicMarkdown } from "../web/scrapers/types";
import { withHardTimeout } from "../web/search/providers/utils";
import type { AsyapmComment, AsyapmIssue } from "./client";

/** Images attached per issue; later ones keep a "not attached" label. */
const MAX_IMAGES = 8;
/** Download cap per image, before resizing. */
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
/** Private-use code points around an image slot index; turndown never escapes them. */
const SLOT = /\uE000(\d+)\uE001/g;

export interface AsyapmIssueContent {
	/** Description markdown; "" when the issue has none. */
	description: string;
	/** Comment bodies as markdown, in input order. */
	comments: string[];
	/** Downloaded images; `[Görsel N]` in the markdown is `images[N - 1]`. */
	images: ImageContent[];
}

export interface AsyapmIssueContentOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/** Re-encode WebP sources for a model that cannot decode them. */
	excludeWebP?: boolean;
}

export async function issueContent(
	issue: AsyapmIssue,
	comments: readonly AsyapmComment[],
	baseUrl: string,
	options: AsyapmIssueContentOptions = {},
): Promise<AsyapmIssueContent> {
	// One slot per distinct image source, in order of first appearance; `null` = not fetchable.
	const sources: (string | null)[] = [];
	const slotBySource = new Map<string, number>();
	const image = (src: string): string => {
		if (!src) return "";
		let slot = slotBySource.get(src);
		if (slot === undefined) {
			slot = sources.push(imageUrl(src, baseUrl)) - 1;
			slotBySource.set(src, slot);
		}
		return `\uE000${slot}\uE001`;
	};
	// Sequential: slots are numbered in reading order, description first.
	const description = issue.description ? await htmlToBasicMarkdown(issue.description, { image }) : "";
	const bodies: string[] = [];
	for (const comment of comments) bodies.push(await htmlToBasicMarkdown(comment.body, { image }));

	const fetchImpl = options.fetch ?? fetch;
	const downloaded = await Promise.all(
		sources.slice(0, MAX_IMAGES).map(url => (url ? downloadImage(url, fetchImpl, options) : null)),
	);
	const images: ImageContent[] = [];
	const labels = sources.map((_, slot) => {
		const image = downloaded[slot];
		if (image) images.push(image);
		return prompt.render(imageLabelTemplate, {
			number: image ? images.length : undefined,
			skipped: slot >= MAX_IMAGES,
			max: MAX_IMAGES,
		});
	});
	const labelFor = (_match: string, slot: string): string => labels[Number(slot)];
	return {
		description: description.replace(SLOT, labelFor),
		comments: bodies.map(body => body.replace(SLOT, labelFor)),
		images,
	};
}

/** Absolute http(s) URL of an `<img src>`, resolved against the API origin; null for data:, blob:, … */
function imageUrl(src: string, baseUrl: string): string | null {
	try {
		const url = new URL(src, `${baseUrl}/`);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
	} catch {
		return null;
	}
}

async function downloadImage(
	url: string,
	fetchImpl: FetchImpl,
	{ signal, excludeWebP }: AsyapmIssueContentOptions,
): Promise<ImageContent | null> {
	try {
		const response = await fetchImpl(url, {
			headers: { Accept: "image/*" },
			signal: withHardTimeout(signal, IMAGE_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error("too large");
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.length > MAX_IMAGE_DOWNLOAD_BYTES) throw new Error("too large");
		const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || undefined;
		const resized = await resizeImage({ bytes, mimeType }, { excludeWebP });
		if (resized.decodeFailed) throw new Error("not a decodable image");
		return { type: "image", data: resized.data, mimeType: resized.mimeType };
	} catch (err) {
		if (signal?.aborted) throw err;
		// The URL may carry a signed token: log the host only.
		logger.warn("AsyaPM image not attached", { host: new URL(url).host, error: String(err) });
		return null;
	}
}
