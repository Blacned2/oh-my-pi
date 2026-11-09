/**
 * Session-event forwarding for RPC mode: stamps message lifecycle frames with a
 * `messageId` and applies the host's `set_event_filter` selection.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "../../session/agent-session";
import type {
	RpcAgentSessionEventFrame,
	RpcBashOutputMode,
	RpcDeltaAssistantMessageEvent,
	RpcMessageUpdates,
	RpcProjectedSessionEventFrame,
} from "./rpc-types";

/**
 * The shell of a block a `*_start` opens. The snapshot behind a start event is cloned when the agent loop consumes the
 * event, after the provider may have streamed more into the same partial, so its streamed content is not trustworthy:
 * empty it, and every following delta applies cleanly. The matching `*_end` carries the final content.
 */
function openedBlock(block: AssistantMessage["content"][number] | undefined) {
	switch (block?.type) {
		case "text":
			return { ...block, text: "" };
		case "thinking":
			return { ...block, thinking: "" };
		case "toolCall":
			return { ...block, arguments: {} };
		default:
			return block;
	}
}

/** Drops the accumulated snapshot a streaming event carries, keeping what a client needs to rebuild it; `done` and `error` have none. */
function toDelta(event: AssistantMessageEvent): RpcDeltaAssistantMessageEvent {
	switch (event.type) {
		case "done":
		case "error":
			return event;
		case "start": {
			const { partial, ...rest } = event;
			return { ...rest, message: partial };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const { partial: _partial, ...increment } = event;
			return increment;
		}
		case "text_end": {
			// `content` already carries the text; the block adds only what it cannot (the signature).
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "text") return rest;
			const { text: _text, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "thinking_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "thinking") return rest;
			const { thinking: _thinking, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "image_end":
		case "toolcall_end": {
			// `content` / `toolCall` is the whole block.
			const { partial: _partial, ...rest } = event;
			return rest;
		}
		default: {
			const { partial, ...rest } = event;
			const block = openedBlock(partial.content[event.contentIndex]);
			return block === undefined ? rest : { ...rest, block };
		}
	}
}

/** The single text block a bash progress snapshot carries, or `undefined` when the partial has another shape. */
function bashPreviewText(partialResult: unknown): string | undefined {
	if (typeof partialResult !== "object" || partialResult === null) return undefined;
	const content = (partialResult as { content?: unknown }).content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = content[0] as { type?: unknown; text?: unknown } | undefined;
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

/** Length of the common prefix of `a` and `b`, never ending between the halves of a surrogate pair. */
function commonPrefixLength(a: string, b: string): number {
	const max = Math.min(a.length, b.length);
	let keep = 0;
	while (keep < max && a.charCodeAt(keep) === b.charCodeAt(keep)) keep++;
	if (keep > 0 && keep < b.length) {
		const last = b.charCodeAt(keep - 1);
		if (last >= 0xd800 && last <= 0xdbff) keep--;
	}
	return keep;
}

/**
 * Writes session events to the RPC output. Message ids are assigned whether or
 * not the frame passes the filter, so changing the filter mid-message never
 * splits one message across two ids.
 */
export class RpcSessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: RpcMessageUpdates = "full";
	#bashOutput: RpcBashOutputMode = "full";
	/** Last preview text sent per running bash call, for the `chunks` projection. */
	#bashPreviews = new Map<string, string>();
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	readonly #output: (frame: RpcProjectedSessionEventFrame) => void;

	constructor(output: (frame: RpcProjectedSessionEventFrame) => void) {
		this.#output = output;
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(
		events: readonly string[] | null,
		messageUpdates: RpcMessageUpdates = "full",
		bashOutput: RpcBashOutputMode = "full",
	): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		this.#bashOutput = bashOutput;
		this.#bashPreviews.clear();
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(event: AgentSessionEvent): void {
		const frame = this.#stamp(event);
		if (frame.type === "tool_execution_end") this.#bashPreviews.delete(frame.toolCallId);
		if (this.#filter && !this.#filter.has(frame.type)) return;
		if (frame.type === "tool_execution_update" && frame.toolName === "bash" && this.#bashOutput === "chunks") {
			this.#forwardBashUpdate(frame);
			return;
		}
		if (frame.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...frame,
				message: { role: frame.message.role },
				assistantMessageEvent: toDelta(frame.assistantMessageEvent),
			});
			return;
		}
		this.#output(frame);
	}

	/**
	 * `chunks` projection of a bash progress snapshot: the text goes out as a splice against the previous snapshot of
	 * the same call (`bash_output`), and the update itself only when it still carries details (replies, trace).
	 */
	#forwardBashUpdate(frame: Extract<RpcAgentSessionEventFrame, { type: "tool_execution_update" }>): void {
		const text = bashPreviewText(frame.partialResult);
		if (text === undefined) {
			this.#output(frame);
			return;
		}
		const previous = this.#bashPreviews.get(frame.toolCallId) ?? "";
		const keep = commonPrefixLength(previous, text);
		if (keep !== previous.length || keep !== text.length) {
			this.#bashPreviews.set(frame.toolCallId, text);
			this.#output({ type: "bash_output", toolCallId: frame.toolCallId, keep, chunk: text.slice(keep) });
		}
		const details = (frame.partialResult as { details?: unknown }).details;
		if (typeof details === "object" && details !== null && Object.keys(details).length > 0) {
			this.#output({ ...frame, partialResult: { content: [], details } });
		}
	}

	#stamp(event: AgentSessionEvent): RpcAgentSessionEventFrame {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId();
				this.#openMessageIds.push(messageId);
				return { ...event, messageId };
			}
			case "message_update": {
				let messageId = this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId();
					this.#openMessageIds.push(messageId);
				}
				return { ...event, messageId };
			}
			case "message_end":
				return { ...event, messageId: this.#openMessageIds.pop() ?? this.#mintMessageId() };
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				return event;
			default:
				return event;
		}
	}

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}
