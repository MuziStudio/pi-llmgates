import type { AssistantMessage } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_MODEL_EQUIVALENTS, parseModelEquivalents } from "../extensions/model-audit/compare.js";
import {
	createModelAuditRuntime,
	modelAuditProcessStats,
	registerModelAuditLifecycle,
	resetModelAuditProcessStats,
	type ModelAuditRuntimeOptions,
	type ModelAuditSessionInfo,
} from "../extensions/model-audit/runtime.js";
import {
	MODEL_AUDIT_ROOT_ENV,
	ModelAuditStoreError,
	modelAuditHistoryPath,
	parseRootMarker,
	serializeRootMarker,
	type AppendModelAuditInput,
} from "../extensions/model-audit/store.js";

const AGENT_DIR = resolve("/home/u/.pi/agent");
const TUI: ModelAuditSessionInfo = { hasUI: true, mode: "tui", cwd: resolve("/work/project"), sessionId: "root-session" };
const PRINT: ModelAuditSessionInfo = { hasUI: false, mode: "print", cwd: resolve("/work/project/.worktrees/child"), sessionId: "child-session" };

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "work-newapi",
		model: "gpt-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function sse(models: readonly string[]): Response {
	const text = models.map((model) => `data: ${JSON.stringify({ model, choices: [] })}\n\n`).join("");
	return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

interface FakeCall {
	options: Record<string, unknown> | undefined;
	finish(message?: AssistantMessage): void;
}

/**
 * Stand-in for a pi-ai >= 0.83 adapter: onPayload -> fetch -> read body -> done.
 * `fetchModels` undefined skips the fetch step (pi-ai 0.81/0.82 behaviour).
 */
function fakeAdapter(fetchModels?: readonly string[]) {
	const calls: FakeCall[] = [];
	const start = (options: object | undefined) => {
		const opts = options as Record<string, unknown> | undefined;
		let resolveResult!: (message: AssistantMessage) => void;
		const result = new Promise<AssistantMessage>((r) => {
			resolveResult = r;
		});
		const run = async () => {
			const onPayload = opts?.onPayload as ((p: unknown, m: unknown) => unknown) | undefined;
			await onPayload?.({ model: "gpt-5", messages: [] }, {});
			if (fetchModels) {
				const fetchImpl = opts?.fetch as typeof fetch;
				const response = await fetchImpl("https://gateway.example/v1/chat/completions", { method: "POST" });
				await response.text();
			}
		};
		const ready = run();
		calls.push({
			options: opts,
			finish(message = assistant()) {
				void ready.then(() => resolveResult(message));
			},
		});
		return { result: () => result };
	};
	return { calls, start };
}

function setup(overrides: Partial<ModelAuditRuntimeOptions> = {}) {
	const env: NodeJS.ProcessEnv = {};
	const writes: AppendModelAuditInput[] = [];
	let hex = 0;
	const options: ModelAuditRuntimeOptions = {
		agentDir: AGENT_DIR,
		env,
		randomHex: (bytes) => (++hex).toString(16).padStart(bytes * 2, "0"),
		appendMismatch: async (input) => {
			writes.push(input);
			return { quarantined: false };
		},
		loadEquivalents: () => ({ status: "missing", equivalents: EMPTY_MODEL_EQUIVALENTS }),
		debug: () => undefined,
		...overrides,
	};
	return { env, writes, options, create: () => createModelAuditRuntime(options) };
}

async function runCall(
	runtime: ReturnType<ReturnType<typeof setup>["create"]>,
	fetchModels: readonly string[] | undefined,
	options: Record<string, unknown> = { fetch: async () => sse(fetchModels ?? []) },
	message?: AssistantMessage,
) {
	const adapter = fakeAdapter(fetchModels);
	const stream = runtime.observeStream({
		providerId: "work-newapi",
		model: { id: "gpt-5", api: "openai-completions" },
		options,
		start: adapter.start,
	});
	adapter.calls[0]!.finish(message);
	await stream.result();
	// Let finalize and the queued history write run.
	await new Promise((r) => setTimeout(r, 0));
	return adapter.calls[0]!;
}

beforeEach(() => resetModelAuditProcessStats());

describe("root marker ownership", () => {
	it("a TUI session owns the marker, rotates it per turn, and removes it on shutdown", async () => {
		const { env, create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		const first = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!;
		expect(first).toMatchObject({ rootSessionId: "root-session", rootCwd: TUI.cwd });
		expect(first.originTurnId).toBeUndefined();

		runtime.beforeAgentStart();
		expect(parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!.originTurnId).toBe(`${first.token}:1`);
		// turnActive guard: a second before_agent_start inside the run does not rotate.
		runtime.beforeAgentStart();
		expect(parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!.originTurnId).toBe(`${first.token}:1`);
		runtime.agentSettled();
		runtime.beforeAgentStart();
		expect(parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!.originTurnId).toBe(`${first.token}:2`);

		await runtime.sessionShutdown();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBeUndefined();
	});

	it("restores a pre-existing value on shutdown instead of deleting it", async () => {
		const { env, create } = setup();
		env[MODEL_AUDIT_ROOT_ENV] = "not-a-marker";
		const runtime = create();
		runtime.sessionStart(TUI);
		expect(env[MODEL_AUDIT_ROOT_ENV]).not.toBe("not-a-marker");
		await runtime.sessionShutdown();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe("not-a-marker");
	});

	it("a non-owner in the same process (and module graph) never rotates or removes the marker", async () => {
		const { env, create } = setup();
		const parent = create();
		const child = create();
		parent.sessionStart(TUI);
		parent.beforeAgentStart();
		const parentMarker = env[MODEL_AUDIT_ROOT_ENV];

		child.sessionStart(PRINT);
		expect(child.status()).toMatchObject({ owner: false });
		child.beforeAgentStart();
		child.agentSettled();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe(parentMarker);
		await child.sessionShutdown();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe(parentMarker);
		expect(parent.status()).toMatchObject({ owner: true });
	});

	it("the owner only touches the env while it still holds its own value", async () => {
		const { env, create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		env[MODEL_AUDIT_ROOT_ENV] = "someone-else";
		runtime.beforeAgentStart();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe("someone-else");
		await runtime.sessionShutdown();
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe("someone-else");
	});

	it("a non-TUI session with no valid marker becomes an independent root", () => {
		const { env, create } = setup();
		env[MODEL_AUDIT_ROOT_ENV] = JSON.stringify({ v: 1, token: "x" });
		const runtime = create();
		runtime.sessionStart(PRINT);
		expect(runtime.status()).toMatchObject({ owner: true });
		expect(parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])).toMatchObject({ rootCwd: PRINT.cwd });
	});

	it("rejects a valid marker whose history path belongs to another agent directory", () => {
		const { env, create } = setup();
		env[MODEL_AUDIT_ROOT_ENV] = serializeRootMarker({
			v: 1,
			token: "0123456789abcdef0123456789abcdef",
			rootSessionId: "parent-session",
			rootCwd: TUI.cwd,
			historyPath: modelAuditHistoryPath(resolve("/other/pi/agent"), TUI.cwd),
		});
		const runtime = create();

		runtime.sessionStart(PRINT);

		expect(runtime.status().owner).toBe(true);
		expect(runtime.status().marker).toMatchObject({
			rootCwd: PRINT.cwd,
			historyPath: modelAuditHistoryPath(AGENT_DIR, PRINT.cwd),
		});
	});

	it("/reload and /resume get a new token so turn ids never collide", async () => {
		const { env, create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		runtime.beforeAgentStart();
		const before = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!.originTurnId;
		await runtime.sessionShutdown();
		runtime.sessionStart(TUI);
		runtime.beforeAgentStart();
		const after = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!.originTurnId;
		expect(after).not.toBe(before);
		expect(after?.endsWith(":1")).toBe(true);
	});

	it("a session_start without a matching shutdown releases first and never strands its marker", async () => {
		const { env, create } = setup();
		env[MODEL_AUDIT_ROOT_ENV] = "outer";
		const runtime = create();
		runtime.sessionStart(TUI);
		const first = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!;
		runtime.sessionStart(TUI);
		const second = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])!;
		expect(second.token).not.toBe(first.token);
		await runtime.sessionShutdown();
		// Restored to what was there before the FIRST start, not to the first marker.
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBe("outer");
	});
});

describe("attribution snapshots", () => {
	it("the owner's calls use its live turn", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		runtime.beforeAgentStart();
		await runCall(runtime, ["gpt-4o"]);
		const marker = runtime.status().marker!;
		expect(writes[0]!.record).toMatchObject({
			rootSessionId: "root-session",
			originTurnId: marker.originTurnId,
			sentModel: "gpt-5",
			responseModel: "gpt-4o",
		});
		expect(writes[0]!.historyPath).toBe(marker.historyPath);
	});

	it("a non-owner keeps the turn that was current when it started", async () => {
		const { create, writes } = setup();
		const parent = create();
		const child = create();
		parent.sessionStart(TUI);
		parent.beforeAgentStart();
		const startTurn = parent.status().marker!.originTurnId;
		child.sessionStart(PRINT);
		parent.agentSettled();
		parent.beforeAgentStart(); // parent moved on to its next turn
		expect(parent.status().marker!.originTurnId).not.toBe(startTurn);

		await runCall(child, ["gpt-4o"]);
		expect(writes[0]!.record.originTurnId).toBe(startTurn);
		// Written to the PARENT's history even though the child runs in a worktree.
		expect(writes[0]!.historyPath).toBe(parent.status().marker!.historyPath);
	});

	it("records made before the first turn are unattributed", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["gpt-4o"]);
		expect(writes[0]!.record.originTurnId).toBeUndefined();
	});
});

describe("stream observation", () => {
	it("does not wrap anything when disabled, before start, or after shutdown", async () => {
		const { env, create } = setup();
		env.LLMGATES_MODEL_AUDIT = "0";
		const runtime = create();
		const options = { onPayload: () => undefined };
		const seen: unknown[] = [];
		const start = (value: object | undefined) => {
			seen.push(value);
			return { result: async () => assistant() };
		};
		const call = { providerId: "p", model: { id: "gpt-5", api: "openai-completions" }, options, start };
		runtime.observeStream(call);
		runtime.sessionStart(TUI);
		runtime.observeStream(call);
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBeUndefined();

		delete env.LLMGATES_MODEL_AUDIT;
		runtime.sessionStart(TUI);
		await runtime.sessionShutdown();
		runtime.observeStream(call);
		expect(seen).toEqual([options, options, options]);
	});

	it("falls back to the caller's untouched options when observation setup fails", () => {
		const { create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		const options = {};
		Object.defineProperty(options, "fetch", {
			enumerable: true,
			get() {
				throw new Error("hostile getter");
			},
		});
		const seen: unknown[] = [];
		const stream = { result: () => new Promise<AssistantMessage>(() => undefined) };
		const returned = runtime.observeStream({
			providerId: "p",
			model: { id: "gpt-5", api: "openai-completions" },
			options,
			start: (value) => {
				seen.push(value);
				return stream;
			},
		});
		expect(returned).toBe(stream);
		expect(seen).toEqual([options]);
		expect(seen[0]).toBe(options);
	});

	it("passes onPayload return values and exceptions through unchanged", async () => {
		const { create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		const replaced = { model: "rewritten" };
		const promised = Promise.resolve(replaced);
		const failure = new Error("hook failed");
		const results: unknown[] = [];
		for (const hook of [
			() => undefined,
			() => replaced,
			() => promised,
			() => {
				throw failure;
			},
		]) {
			runtime.observeStream({
				providerId: "p",
				model: { id: "gpt-5", api: "openai-completions" },
				options: { onPayload: hook },
				start: (opts) => {
					const wrapped = (opts as { onPayload: (p: unknown, m: unknown) => unknown }).onPayload;
					try {
						results.push(wrapped({ model: "gpt-5" }, {}));
					} catch (error) {
						results.push(error);
					}
					return { result: () => new Promise<AssistantMessage>(() => undefined) };
				},
			});
		}
		expect(results[0]).toBeUndefined();
		expect(results[1]).toBe(replaced);
		expect(results[2]).toBe(promised);
		expect(results[3]).toBe(failure);
	});

	it("compares against the model onPayload actually sends", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["gpt-4o"], {
			onPayload: async (payload: Record<string, unknown>) => ({ ...payload, model: "gpt-4o" }),
			fetch: async () => sse(["gpt-4o"]),
		});
		expect(writes).toHaveLength(0);
		expect(modelAuditProcessStats().byApi["openai-completions"]).toMatchObject({ fetch: 1, response: 1 });
	});

	it("keeps the caller's own fetch and other options", async () => {
		const { create } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		const callerFetch = vi.fn(async () => sse(["gpt-5"]));
		const call = await runCall(runtime, ["gpt-5"], { fetch: callerFetch, sessionId: "s1", maxTokens: 7 });
		expect(callerFetch).toHaveBeenCalledTimes(1);
		expect(call.options).toMatchObject({ sessionId: "s1", maxTokens: 7 });
		expect(call.options!.fetch).not.toBe(callerFetch);
	});

	it("falls back to AssistantMessage.responseModel when fetch saw nothing", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, undefined, {}, assistant({ responseModel: "gpt-4o" }));
		expect(writes[0]!.record.responseModel).toBe("gpt-4o");
		expect(modelAuditProcessStats().byApi["openai-completions"]).toEqual({ fetch: 0, response: 0, field: 1, none: 0 });
	});

	it("counts calls with no response model as none and writes nothing for version variants", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, undefined, {});
		await runCall(runtime, ["gpt-5-2025-08-07"]);
		expect(writes).toHaveLength(0);
		expect(modelAuditProcessStats().byApi["openai-completions"]).toEqual({ fetch: 1, response: 1, field: 0, none: 1 });
	});

	it("applies the equivalence table loaded at session start", async () => {
		const { create, writes } = setup({
			loadEquivalents: () => ({
				status: "ok",
				equivalents: parseModelEquivalents({ version: 1, equivalents: [["gpt-5", "house-model"]] })!,
			}),
		});
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["house-model"]);
		expect(writes).toHaveLength(0);
	});

	it("counts write failures by reason and quarantines", async () => {
		let mode: "fail" | "quarantine" = "fail";
		const { create } = setup({
			appendMismatch: async () => {
				if (mode === "fail") throw new ModelAuditStoreError("newer-version", "newer");
				return { quarantined: true };
			},
		});
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["gpt-4o"]);
		mode = "quarantine";
		await runCall(runtime, ["gpt-4o"]);
		await vi.waitFor(() => expect(modelAuditProcessStats().quarantined).toBe(1));
		expect(modelAuditProcessStats()).toMatchObject({
			writeFailures: 1,
			writeFailuresByReason: { "newer-version": 1 },
		});
	});
});

describe("session shutdown", () => {
	it("drops a stream result that settles after shutdown", async () => {
		const { create, writes } = setup();
		const runtime = create();
		runtime.sessionStart(TUI);
		let resolveResult!: (message: AssistantMessage) => void;
		const result = new Promise<AssistantMessage>((resolve) => {
			resolveResult = resolve;
		});
		const stream = { result: () => result };

		runtime.observeStream({
			providerId: "work-newapi",
			model: { id: "gpt-5", api: "openai-completions" },
			options: {},
			start: () => stream,
		});
		await runtime.sessionShutdown();
		runtime.sessionStart(TUI);
		resolveResult(assistant({ responseModel: "gpt-4o" }));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(writes).toHaveLength(0);
	});

	it("waits at most the flush budget for a stuck history write", async () => {
		const { create } = setup({
			shutdownFlushMs: 50,
			appendMismatch: () => new Promise(() => undefined),
		});
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["gpt-4o"]);
		const started = Date.now();
		await runtime.sessionShutdown();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(modelAuditProcessStats().shutdownUnfinished).toBe(1);
	});

	it("does not wait when writes already finished", async () => {
		const { create } = setup({ shutdownFlushMs: 10_000 });
		const runtime = create();
		runtime.sessionStart(TUI);
		await runCall(runtime, ["gpt-4o"]);
		const started = Date.now();
		await runtime.sessionShutdown();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(modelAuditProcessStats().shutdownUnfinished).toBe(0);
	});
});

describe("registerModelAuditLifecycle", () => {
	it("wires session_start / before_agent_start / agent_settled / session_shutdown", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) };
		const { env, create } = setup();
		const runtime = create();
		registerModelAuditLifecycle(pi as never, runtime);
		const ctx = { hasUI: true, mode: "tui", cwd: TUI.cwd, sessionManager: { getSessionId: () => "sid-1" } };
		handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
		expect(parseRootMarker(env[MODEL_AUDIT_ROOT_ENV])).toMatchObject({ rootSessionId: "sid-1" });
		handlers.get("before_agent_start")!({}, ctx);
		expect(runtime.status().marker?.originTurnId).toMatch(/:1$/);
		handlers.get("agent_settled")!({}, ctx);
		await handlers.get("session_shutdown")!({}, ctx);
		expect(env[MODEL_AUDIT_ROOT_ENV]).toBeUndefined();
	});
});
