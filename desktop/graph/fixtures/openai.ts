export interface CompletionRequest {
	tools?: { function: { name: string } }[];
	messages: { role: string; content: unknown }[];
}

export function completion(model: string, delta: object, finishReason: string): Response {
	const chunk = { id: "graph-smoke", object: "chat.completion.chunk", created: 1, model };
	const body = [
		{ ...chunk, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] },
		{ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
	].map(event => `data: ${JSON.stringify(event)}\n\n`);
	return new Response(`${body.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
