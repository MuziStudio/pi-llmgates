/**
 * Read-only side channel for the model an upstream reports in its streamed
 * response (`/model-audit`, design §3.3).
 *
 * The wrapped `fetch` hands the SDK a new `Response` whose body is the original
 * body piped through a TransformStream: every chunk is enqueued untouched BEFORE
 * it is inspected, bytes are never re-encoded, and cancel / backpressure / errors
 * travel through the pipe as-is. Observation failures of any kind only end the
 * observation — they can never reach inference.
 */

import { isPlainObject } from "../util.js";

/** The three pi APIs the compat provider can route to. */
export const MODEL_AUDIT_APIS = [
	"openai-completions",
	"anthropic-messages",
	"openai-responses",
] as const;

export type ModelAuditApi = (typeof MODEL_AUDIT_APIS)[number];

export function isModelAuditApi(api: string): api is ModelAuditApi {
	return (MODEL_AUDIT_APIS as readonly string[]).includes(api);
}

/**
 * Cap on one SSE event's buffered text. Counted in UTF-16 code units, which is
 * at least the UTF-8 byte count for the ASCII JSON these streams carry. An event
 * over the cap is dropped from observation only; its bytes still pass through.
 */
export const MAX_SSE_EVENT_CHARS = 256 * 1024;

const RESPONSES_TERMINAL_EVENTS = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
]);

function modelString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Picks the response model for one provider call from the declarations seen in
 * its stream:
 *
 * 1. a terminal value (Responses terminal event, Anthropic `message_start`);
 * 2. otherwise the FIRST declaration whose series differs from the request —
 *    the same reading pi-ai's `responseModel` field uses, so a stream that echoes
 *    the request name first and names the real model later is not missed;
 * 3. otherwise the first declaration (the call is consistent).
 *
 * A request model that is unknown when the first event arrives ends the
 * observation without a result: there is nothing to compare against.
 */
export interface ResponseModelTracker {
	readonly api: ModelAuditApi;
	/** True once parsing can stop: the result is fixed or cannot be reached. */
	concluded(): boolean;
	/** Feed one SSE event's joined `data` payload. Never throws. */
	offerEventData(data: string): void;
	selected(): string | undefined;
}

export function createResponseModelTracker(
	api: ModelAuditApi,
	requestModel: () => string | undefined,
	differs: (request: string, candidate: string) => boolean,
): ResponseModelTracker {
	let first: string | undefined;
	let firstDifferent: string | undefined;
	let terminal: string | undefined;
	let concluded = false;

	function declare(request: string, model: string): void {
		first ??= model;
		if (firstDifferent === undefined && differs(request, model)) {
			firstDifferent = model;
			// Completions has no terminal value: the first differing chunk settles it.
			if (api === "openai-completions") concluded = true;
		}
	}

	function settle(model: string): void {
		terminal = model;
		concluded = true;
	}

	function offer(request: string, event: Record<string, unknown>): void {
		switch (api) {
			case "openai-responses": {
				const nested = isPlainObject(event.response)
					? modelString(event.response.model)
					: undefined;
				if (
					nested &&
					typeof event.type === "string" &&
					RESPONSES_TERMINAL_EVENTS.has(event.type)
				) {
					settle(nested);
					return;
				}
				const model = nested ?? modelString(event.model);
				if (model) declare(request, model);
				return;
			}
			case "anthropic-messages": {
				const started =
					event.type === "message_start" && isPlainObject(event.message)
						? modelString(event.message.model)
						: undefined;
				if (started) {
					settle(started);
					return;
				}
				const model = modelString(event.model);
				if (model) declare(request, model);
				return;
			}
			case "openai-completions": {
				const model = modelString(event.model);
				if (model) declare(request, model);
				return;
			}
		}
	}

	return {
		api,
		concluded: () => concluded,
		offerEventData(data: string): void {
			if (concluded) return;
			const request = requestModel();
			if (!request) {
				concluded = true;
				return;
			}
			// Cheap filter: most Responses / Anthropic events never name a model.
			if (!data.includes('"model"')) return;
			let event: unknown;
			try {
				event = JSON.parse(data);
			} catch {
				return;
			}
			if (!isPlainObject(event)) return;
			try {
				offer(request, event);
			} catch {
				concluded = true;
			}
		},
		selected: () => terminal ?? firstDifferent ?? first,
	};
}

/**
 * Incremental SSE field parser that only surfaces `data` payloads: CR, LF and
 * CRLF line ends (including a CRLF split across chunks), multi-line `data:`
 * joined with "\n", dispatch on the blank line. Other fields and comments are
 * ignored. Memory stays bounded by `maxEventChars` plus one decoded chunk.
 */
export class SseDataParser {
	private line = "";
	private lineChars = 0;
	private data: string[] = [];
	private dataChars = 0;
	private overflow = false;
	private skipLeadingLf = false;

	constructor(
		private readonly onData: (data: string) => void,
		private readonly maxEventChars = MAX_SSE_EVENT_CHARS,
	) {}

	push(text: string): void {
		let start = 0;
		if (this.skipLeadingLf) {
			this.skipLeadingLf = false;
			if (text.charCodeAt(0) === 10) start = 1;
		}
		const lineEnd = /[\r\n]/g;
		lineEnd.lastIndex = start;
		for (let match = lineEnd.exec(text); match; match = lineEnd.exec(text)) {
			const index = match.index;
			this.appendLinePart(text.slice(start, index));
			this.endLine();
			start = index + 1;
			if (text.charCodeAt(index) === 13) {
				if (index + 1 === text.length) this.skipLeadingLf = true;
				else if (text.charCodeAt(index + 1) === 10) start += 1;
			}
			lineEnd.lastIndex = start;
		}
		this.appendLinePart(text.slice(start));
	}

	/** End of stream: dispatch a trailing event that had no blank line. */
	end(): void {
		if (this.lineChars > 0) this.endLine();
		this.dispatch();
	}

	private appendLinePart(part: string): void {
		if (!part) return;
		this.lineChars += part.length;
		if (this.overflow) return;
		if (this.dataChars + this.line.length + part.length > this.maxEventChars) {
			this.overflow = true;
			this.line = "";
			this.data = [];
			this.dataChars = 0;
			return;
		}
		this.line += part;
	}

	private endLine(): void {
		const blank = this.lineChars === 0;
		const line = this.line;
		this.line = "";
		this.lineChars = 0;
		if (blank) {
			this.dispatch();
			return;
		}
		if (this.overflow) return;
		if (line === "data") {
			this.data.push("");
		} else if (line.startsWith("data:")) {
			const value = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5);
			this.data.push(value);
			this.dataChars += value.length + 1;
		}
	}

	private dispatch(): void {
		const data = this.data;
		const overflow = this.overflow;
		this.data = [];
		this.dataChars = 0;
		this.overflow = false;
		if (!overflow && data.length > 0) this.onData(data.join("\n"));
	}
}

/** Statuses whose Response cannot carry a body; never wrapped. */
const NULL_BODY_STATUSES = new Set([204, 205]);

function isEventStream(contentType: string | null): boolean {
	if (!contentType) return false;
	return contentType.split(";")[0]!.trim().toLowerCase() === "text/event-stream";
}

/** Whether `response` is a 2xx SSE stream with a body — the only shape observed. */
export function isObservableResponse(response: Response): boolean {
	return (
		response.status >= 200 &&
		response.status < 300 &&
		!NULL_BODY_STATUSES.has(response.status) &&
		response.body !== null &&
		isEventStream(response.headers.get("content-type"))
	);
}

/**
 * Return `response` with its body teed into `tracker`, or `response` itself
 * when it is not an observable SSE stream. Once the tracker concludes, chunks
 * are forwarded without decoding.
 */
export function observeSseResponse(
	response: Response,
	tracker: ResponseModelTracker,
): Response {
	if (!isObservableResponse(response) || tracker.concluded()) return response;
	const init: ResponseInit = {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	};
	const decoder = new TextDecoder();
	const parser = new SseDataParser((data) => tracker.offerEventData(data));
	let stopped = false;
	const feed = (text: string, end: boolean): void => {
		try {
			parser.push(text);
			if (end) parser.end();
		} catch {
			stopped = true;
		}
		if (tracker.concluded()) stopped = true;
	};
	const body = response.body!.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				controller.enqueue(chunk);
				if (stopped) return;
				let text: string;
				try {
					text = decoder.decode(chunk, { stream: true });
				} catch {
					stopped = true;
					return;
				}
				feed(text, false);
			},
			flush() {
				if (stopped) return;
				let text: string;
				try {
					text = decoder.decode();
				} catch {
					return;
				}
				feed(text, true);
			},
		}),
	);
	const wrapped = new Response(body, init);
	// The SDKs only log these, but keep them truthful rather than blank.
	try {
		Object.defineProperty(wrapped, "url", { value: response.url });
		Object.defineProperty(wrapped, "redirected", { value: response.redirected });
	} catch {
		// Cosmetic only.
	}
	return wrapped;
}

type FetchImpl = typeof globalThis.fetch;

/**
 * A `fetch` that behaves exactly like `base ?? globalThis.fetch` (looked up per
 * call) and tees observable responses into the tracker `begin()` returns.
 * `begin` runs once per HTTP attempt, before the request is sent.
 */
export function createObservingFetch(
	base: FetchImpl | undefined,
	begin: () => ResponseModelTracker | undefined,
): FetchImpl {
	const observingFetch = async (
		input: Parameters<FetchImpl>[0],
		init?: Parameters<FetchImpl>[1],
	): Promise<Response> => {
		let tracker: ResponseModelTracker | undefined;
		try {
			tracker = begin();
		} catch {
			tracker = undefined;
		}
		const impl = base ?? globalThis.fetch;
		const response = await impl(input, init);
		if (!tracker) return response;
		try {
			return observeSseResponse(response, tracker);
		} catch {
			return response;
		}
	};
	return observingFetch as FetchImpl;
}
