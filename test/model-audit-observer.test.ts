import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createObservingFetch,
	createResponseModelTracker,
	isObservableResponse,
	MAX_SSE_EVENT_CHARS,
	observeSseResponse,
	SseDataParser,
	type ModelAuditApi,
	type ResponseModelTracker,
} from "../extensions/model-audit/observer.js";

const encoder = new TextEncoder();
const differs = (request: string, candidate: string) => request !== candidate;

function sseResponse(
	chunks: readonly (string | Uint8Array)[],
	init: { status?: number; contentType?: string | null } = {},
): Response {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
			}
			controller.close();
		},
	});
	const headers = new Headers();
	const contentType = init.contentType === undefined ? "text/event-stream" : init.contentType;
	if (contentType !== null) headers.set("content-type", contentType);
	return new Response(body, { status: init.status ?? 200, headers });
}

async function readAllBytes(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

function tracker(api: ModelAuditApi, request: string | undefined = "gpt-5"): ResponseModelTracker {
	return createResponseModelTracker(api, () => request, differs);
}

function countingTracker(inner: ResponseModelTracker): ResponseModelTracker & { offers: number } {
	const counted = {
		api: inner.api,
		offers: 0,
		concluded: () => inner.concluded(),
		offerEventData(data: string) {
			counted.offers += 1;
			inner.offerEventData(data);
		},
		selected: () => inner.selected(),
	};
	return counted;
}

function data(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

describe("SseDataParser", () => {
	function parse(chunks: readonly string[], max?: number): string[] {
		const out: string[] = [];
		const parser = new SseDataParser((value) => out.push(value), max);
		for (const chunk of chunks) parser.push(chunk);
		parser.end();
		return out;
	}

	it("handles LF, CRLF, CR, and a CRLF split across chunks", () => {
		expect(parse(["data: a\n\n", "data: b\r\n\r\n", "data: c\r\r"])).toEqual(["a", "b", "c"]);
		expect(parse(["data: a\r", "\n\r", "\ndata: b\n\n"])).toEqual(["a", "b"]);
	});

	it("joins multiple data lines and ignores other fields and comments", () => {
		expect(
			parse([": keep-alive\n", "event: x\nid: 1\ndata: {\"a\":\ndata:1}\n\n"]),
		).toEqual(['{"a":\n1}']);
	});

	it("reassembles a line split across chunks", () => {
		expect(parse(['data: {"mo', 'del":"x"}', "\n\n"])).toEqual(['{"model":"x"}']);
	});

	it("dispatches a trailing event with no blank line at end of stream", () => {
		expect(parse(["data: tail"])).toEqual(["tail"]);
	});

	it("drops only the oversized event and keeps parsing the next one", () => {
		const big = "x".repeat(64);
		expect(parse([`data: ${big}\n`, `data: ${big}\n\n`, "data: ok\n\n"], 100)).toEqual(["ok"]);
		// A single huge line split across chunks is dropped as a whole.
		expect(parse(["data: ", big, big, "\n\ndata: next\n\n"], 100)).toEqual(["next"]);
	});
});

describe("response model tracker", () => {
	it("openai-responses takes the terminal response.model over earlier declarations", () => {
		const t = tracker("openai-responses");
		t.offerEventData(JSON.stringify({ type: "response.created", response: { model: "gpt-5" } }));
		t.offerEventData(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
		expect(t.concluded()).toBe(false);
		t.offerEventData(
			JSON.stringify({ type: "response.completed", response: { model: "gpt-4o-mini" } }),
		);
		expect(t.concluded()).toBe(true);
		expect(t.selected()).toBe("gpt-4o-mini");
	});

	it.each(["response.incomplete", "response.failed"])(
		"openai-responses treats %s as terminal",
		(type) => {
			const t = tracker("openai-responses");
			t.offerEventData(JSON.stringify({ type, response: { model: "other" } }));
			expect(t.concluded()).toBe(true);
			expect(t.selected()).toBe("other");
		},
	);

	it("openai-responses without a terminal event falls back to the first differing declaration", () => {
		const t = tracker("openai-responses");
		t.offerEventData(JSON.stringify({ type: "response.created", response: { model: "gpt-5" } }));
		t.offerEventData(JSON.stringify({ type: "response.in_progress", model: "gpt-4o" }));
		expect(t.selected()).toBe("gpt-4o");
	});

	it("openai-completions: an echoed first chunk does not hide a later different model", () => {
		const t = tracker("openai-completions");
		t.offerEventData(JSON.stringify({ model: "gpt-5", choices: [] }));
		expect(t.concluded()).toBe(false);
		t.offerEventData(JSON.stringify({ model: "gpt-4o", choices: [] }));
		expect(t.concluded()).toBe(true);
		expect(t.selected()).toBe("gpt-4o");
	});

	it("openai-completions: all-consistent chunks select the first declaration", () => {
		const t = tracker("openai-completions");
		t.offerEventData(JSON.stringify({ model: "gpt-5", choices: [] }));
		t.offerEventData(JSON.stringify({ model: "gpt-5", choices: [] }));
		expect(t.concluded()).toBe(false);
		expect(t.selected()).toBe("gpt-5");
	});

	it("anthropic-messages settles on message_start.message.model", () => {
		const t = tracker("anthropic-messages", "claude-sonnet-4-5");
		t.offerEventData(
			JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-3-5-haiku-20241022" } }),
		);
		expect(t.concluded()).toBe(true);
		expect(t.selected()).toBe("claude-3-5-haiku-20241022");
	});

	it("ignores non-JSON, [DONE], non-object and model-less events", () => {
		const t = tracker("openai-completions");
		for (const value of ["[DONE]", "not json", '"model"', "[1]", JSON.stringify({ choices: [] })]) {
			t.offerEventData(value);
		}
		expect(t.selected()).toBeUndefined();
		expect(t.concluded()).toBe(false);
	});

	it("skips JSON.parse for events without a \"model\" substring", () => {
		const parse = vi.spyOn(JSON, "parse");
		try {
			const t = tracker("openai-responses");
			t.offerEventData(JSON.stringify({ type: "response.output_text.delta", delta: "x" }));
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});

	it("an unknown request model ends the observation without a result", () => {
		const t = createResponseModelTracker("openai-completions", () => undefined, differs);
		t.offerEventData(JSON.stringify({ model: "gpt-4o" }));
		expect(t.concluded()).toBe(true);
		expect(t.selected()).toBeUndefined();
	});
});

describe("observeSseResponse", () => {
	it("passes bytes through unchanged and observes the model across chunk boundaries", async () => {
		const raw = [
			'data: {"id":"c1","object":"chat.completion.chunk","mod',
			'el":"gpt-5","choices":[{"delta":{"content":"héllo"}}]}\r\n\r\n',
			data({ model: "gpt-4o", choices: [] }),
			"data: [DONE]\n\n",
		];
		const original = await readAllBytes(sseResponse(raw));
		const t = tracker("openai-completions");
		const wrapped = observeSseResponse(sseResponse(raw), t);
		expect(await readAllBytes(wrapped)).toEqual(original);
		expect(t.selected()).toBe("gpt-4o");
	});

	it("keeps status, statusText, and headers", () => {
		const source = sseResponse([data({ model: "x" })], { contentType: "text/event-stream; charset=utf-8" });
		const wrapped = observeSseResponse(source, tracker("openai-completions"));
		expect(wrapped).not.toBe(source);
		expect(wrapped.status).toBe(200);
		expect(wrapped.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
	});

	it("stops parsing once the result is settled", async () => {
		const t = countingTracker(tracker("anthropic-messages", "claude-sonnet-4-5"));
		const wrapped = observeSseResponse(
			sseResponse([
				data({ type: "message_start", message: { model: "claude-sonnet-4-5" } }),
				data({ type: "content_block_delta", model: "ignored" }),
				data({ type: "message_stop" }),
			]),
			t,
		);
		await readAllBytes(wrapped);
		expect(t.offers).toBe(1);
		expect(t.selected()).toBe("claude-sonnet-4-5");
	});

	it("does not wrap non-2xx, bodiless, or non-SSE responses", () => {
		const t = tracker("openai-completions");
		const rejected = [
			sseResponse([data({ model: "x" })], { status: 429 }),
			new Response(null, { status: 200, headers: { "content-type": "text/event-stream" } }),
			new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } }),
			sseResponse([data({ model: "x" })], { contentType: "application/json" }),
			sseResponse([data({ model: "x" })], { contentType: null }),
		];
		for (const response of rejected) {
			expect(isObservableResponse(response)).toBe(false);
			expect(observeSseResponse(response, t)).toBe(response);
		}
	});

	it("passes an oversized event through and still observes the next one", async () => {
		const huge = data({ model: "gpt-5", pad: "x".repeat(MAX_SSE_EVENT_CHARS) });
		const raw = [huge, data({ model: "gpt-4o" })];
		const t = tracker("openai-completions");
		const wrapped = observeSseResponse(sseResponse(raw), t);
		const text = new TextDecoder().decode(await readAllBytes(wrapped));
		expect(text).toBe(raw.join(""));
		expect(t.selected()).toBe("gpt-4o");
	});

	it("propagates the source's stream error object unchanged", async () => {
		const failure = new Error("upstream reset");
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(encoder.encode(data({ model: "gpt-5" })));
				else controller.error(failure);
			},
		});
		const wrapped = observeSseResponse(
			new Response(body, { headers: { "content-type": "text/event-stream" } }),
			tracker("openai-completions"),
		);
		const reader = wrapped.body!.getReader();
		await reader.read();
		await expect(reader.read()).rejects.toBe(failure);
	});

	it("propagates a consumer cancel reason to the source", async () => {
		let cancelled: unknown;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(encoder.encode(data({ model: "gpt-5" })));
			},
			cancel(reason) {
				cancelled = reason;
			},
		});
		const wrapped = observeSseResponse(
			new Response(body, { headers: { "content-type": "text/event-stream" } }),
			tracker("openai-completions"),
		);
		const reason = new DOMException("stop", "AbortError");
		const reader = wrapped.body!.getReader();
		await reader.read();
		await reader.cancel(reason);
		await vi.waitFor(() => expect(cancelled).toBe(reason));
	});
});

describe("createObservingFetch", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("uses the given base fetch and passes arguments through", async () => {
		const base = vi.fn(async () => sseResponse([data({ model: "gpt-4o" })]));
		const t = tracker("openai-completions");
		const wrapped = createObservingFetch(base as unknown as typeof fetch, () => t);
		const init = { method: "POST", body: "{}" };
		const response = await wrapped("https://gateway.example/v1/chat/completions", init);
		expect(base).toHaveBeenCalledWith("https://gateway.example/v1/chat/completions", init);
		await response.text();
		expect(t.selected()).toBe("gpt-4o");
	});

	it("looks globalThis.fetch up per call when no base is given", async () => {
		const wrapped = createObservingFetch(undefined, () => undefined);
		const replacement = vi.fn(async () => new Response("ok"));
		globalThis.fetch = replacement as unknown as typeof fetch;
		const response = await wrapped("https://gateway.example/");
		expect(replacement).toHaveBeenCalledTimes(1);
		expect(await response.text()).toBe("ok");
	});

	it("a failing begin() never affects the request", async () => {
		const source = sseResponse([data({ model: "gpt-4o" })]);
		const wrapped = createObservingFetch(
			(async () => source) as unknown as typeof fetch,
			() => {
				throw new Error("observer broke");
			},
		);
		expect(await wrapped("https://gateway.example/")).toBe(source);
	});

	it("propagates the base fetch rejection unchanged", async () => {
		const failure = new TypeError("fetch failed");
		const wrapped = createObservingFetch(
			(async () => {
				throw failure;
			}) as unknown as typeof fetch,
			() => tracker("openai-completions"),
		);
		await expect(wrapped("https://gateway.example/")).rejects.toBe(failure);
	});
});
