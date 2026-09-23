/**
 * Per-extension-instance runtime for `/model-audit` (design §3.1, §3.5, §4).
 *
 * Everything that decides attribution — whether this instance owns the root
 * marker, the frozen marker of a non-owner, the turn sequence — lives in the
 * closure of `createModelAuditRuntime`, never at module scope: pi caches
 * extension factories per process, and an in-process subagent host may run a
 * second factory call against the SAME module graph. Only the process-wide
 * observation / failure counters are module-level, by design.
 *
 * The runtime only observes. It never changes request or response bytes,
 * never blocks a stream, and swallows every failure of its own.
 */

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envFlag, isPlainObject } from "../util.js";
import {
	compareModels,
	EMPTY_MODEL_EQUIVALENTS,
	loadModelEquivalents,
	seriesDiffers,
	type ModelEquivalentsLoad,
} from "./compare.js";
import {
	createObservingFetch,
	createResponseModelTracker,
	isModelAuditApi,
	MODEL_AUDIT_APIS,
	type ModelAuditApi,
} from "./observer.js";
import {
	appendModelAuditMismatch,
	MODEL_AUDIT_ROOT_ENV,
	ModelAuditStoreError,
	modelAuditHistoryPath,
	parseRootMarker,
	safeRootSessionId,
	sanitizeAuditText,
	serializeRootMarker,
	type ModelAuditRecord,
	type ModelAuditRootMarker,
	type ModelAuditStoreErrorReason,
} from "./store.js";

/** Default on; `0` / `false` / `off` / `no` disables every part of the audit. */
export const MODEL_AUDIT_ENV = "LLMGATES_MODEL_AUDIT";
/** Upper bound on how long `session_shutdown` waits for pending history writes. */
export const MODEL_AUDIT_SHUTDOWN_FLUSH_MS = 1_500;

export function isModelAuditEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return envFlag(MODEL_AUDIT_ENV, env) !== false;
}

// --- process-wide counters (§3.5, §6) -----------------------------------------

export interface ModelAuditApiCounts {
	/** Provider calls whose fetch wrapper was invoked at least once. */
	fetch: number;
	/** Calls whose response model came from the response bytes. */
	response: number;
	/** Calls whose response model came from `AssistantMessage.responseModel`. */
	field: number;
	/** Calls with no response model, or an unknown request model. */
	none: number;
}

export interface ModelAuditProcessStats {
	byApi: Record<ModelAuditApi, ModelAuditApiCounts>;
	writeFailures: number;
	writeFailuresByReason: Partial<Record<ModelAuditStoreErrorReason, number>>;
	quarantined: number;
	/** Writes still pending when a `session_shutdown` stopped waiting. */
	shutdownUnfinished: number;
}

function emptyProcessStats(): ModelAuditProcessStats {
	const byApi = {} as Record<ModelAuditApi, ModelAuditApiCounts>;
	for (const api of MODEL_AUDIT_APIS) byApi[api] = { fetch: 0, response: 0, field: 0, none: 0 };
	return { byApi, writeFailures: 0, writeFailuresByReason: {}, quarantined: 0, shutdownUnfinished: 0 };
}

let processStats = emptyProcessStats();

/** Snapshot of this process's counters (a child process's failures are not visible here). */
export function modelAuditProcessStats(): ModelAuditProcessStats {
	return structuredClone(processStats);
}

/** A quarantine done outside the runtime's own writes (`/model-audit clear`). */
export function recordModelAuditQuarantine(): void {
	processStats.quarantined += 1;
}

/** @internal Test-only. */
export function resetModelAuditProcessStats(): void {
	processStats = emptyProcessStats();
}

export function formatModelAuditObservationSummary(stats: ModelAuditProcessStats): string {
	return MODEL_AUDIT_APIS.map((api) => {
		const c = stats.byApi[api];
		return `${api} fetch=${c.fetch} response=${c.response} field=${c.field} none=${c.none}`;
	}).join("; ");
}

// --- runtime -----------------------------------------------------------------

export interface ModelAuditSessionInfo {
	hasUI: boolean;
	mode: string;
	cwd: string;
	sessionId: string | undefined;
}

/** What the compat provider needs: one call per `stream` / `streamSimple`. */
export interface ModelAuditStreamCall<S> {
	providerId: string;
	/** The model the adapter receives (after `modelForInferenceRequest`). */
	model: { id: string; api: string };
	options: object | undefined;
	start(options: object | undefined): S;
}

export interface ModelAuditStreamHook {
	/**
	 * Start the stream, observing it when the audit is active. Returns exactly the
	 * adapter's stream object. When inactive, `start` gets the caller's options
	 * object unchanged.
	 */
	observeStream<S extends { result(): Promise<AssistantMessage> }>(call: ModelAuditStreamCall<S>): S;
}

export interface ModelAuditStatus {
	enabled: boolean;
	/** Current attribution: owner's live marker or a non-owner's frozen one. */
	marker: ModelAuditRootMarker | null;
	owner: boolean;
	equivalents: ModelEquivalentsLoad;
}

export interface ModelAuditRuntime extends ModelAuditStreamHook {
	sessionStart(info: ModelAuditSessionInfo): void;
	beforeAgentStart(): void;
	agentSettled(): void;
	sessionShutdown(): Promise<void>;
	status(): ModelAuditStatus;
	/** Re-read the equivalence table (used by `/model-audit`). */
	reloadEquivalents(): ModelEquivalentsLoad;
}

export interface ModelAuditRuntimeOptions {
	agentDir: string;
	/** Defaults to `process.env`; in-process sessions share it. */
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	randomHex?: (bytes: number) => string;
	shutdownFlushMs?: number;
	/** @internal Test seams. */
	appendMismatch?: typeof appendModelAuditMismatch;
	loadEquivalents?: (agentDir: string) => ModelEquivalentsLoad;
	debug?: (message: string) => void;
}

interface Owner {
	kind: "owner";
	marker: ModelAuditRootMarker;
	/** The exact env value this instance last wrote. */
	written: string;
	envBefore: string | undefined;
	seq: number;
	turnActive: boolean;
}

interface Follower {
	kind: "follower";
	marker: ModelAuditRootMarker;
}

type OnPayload = (payload: unknown, model: unknown) => unknown;
type FetchImpl = typeof globalThis.fetch;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

function payloadModel(payload: unknown): string | undefined {
	if (!isPlainObject(payload)) return undefined;
	return typeof payload.model === "string" && payload.model.trim() ? payload.model : undefined;
}

/**
 * Wrap `onPayload` read-only: same `this`, same arguments, the original return
 * value (sync value, `undefined`, or the very same promise) and the original
 * exception. The final payload is the returned value, or the input when that is
 * `undefined` — exactly how the adapters apply it.
 */
function observeOnPayload(original: OnPayload, note: (model: string | undefined) => void): OnPayload {
	return function (this: unknown, payload: unknown, model: unknown) {
		const out = original.call(this, payload, model);
		if (isThenable(out)) {
			out.then(
				(value) => note(payloadModel(value === undefined ? payload : value)),
				() => undefined,
			);
			return out;
		}
		note(payloadModel(out === undefined ? payload : out));
		return out;
	};
}

function debugLog(message: string): void {
	if (envFlag("LLMGATES_DEBUG")) console.info(`[pi-llmgates-model-audit] ${message}`);
}

export function createModelAuditRuntime(options: ModelAuditRuntimeOptions): ModelAuditRuntime {
	const { agentDir } = options;
	const env = options.env ?? process.env;
	const now = options.now ?? (() => Date.now());
	const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
	const flushMs = options.shutdownFlushMs ?? MODEL_AUDIT_SHUTDOWN_FLUSH_MS;
	const appendMismatch = options.appendMismatch ?? appendModelAuditMismatch;
	const loadEquivalents = options.loadEquivalents ?? loadModelEquivalents;
	const debug = options.debug ?? debugLog;

	// Re-read on every session_start; until then report what the env says.
	let enabled = isModelAuditEnabled(env);
	let active = false;
	let role: Owner | Follower | null = null;
	let equivalents: ModelEquivalentsLoad = { status: "missing", equivalents: EMPTY_MODEL_EQUIVALENTS };
	const pendingWrites = new Set<Promise<void>>();
	let lifecycleGeneration = 0;

	function safeLoadEquivalents(): ModelEquivalentsLoad {
		try {
			return loadEquivalents(agentDir);
		} catch (error) {
			return {
				status: "invalid",
				equivalents: EMPTY_MODEL_EQUIVALENTS,
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** Owner-only env write, and only while the env still holds our own value. */
	function publish(owner: Owner): void {
		if (env[MODEL_AUDIT_ROOT_ENV] !== owner.written) return;
		const next = serializeRootMarker(owner.marker);
		env[MODEL_AUDIT_ROOT_ENV] = next;
		owner.written = next;
	}

	function release(): void {
		const current = role;
		role = null;
		if (current?.kind !== "owner") return;
		if (env[MODEL_AUDIT_ROOT_ENV] !== current.written) return;
		if (current.envBefore === undefined) delete env[MODEL_AUDIT_ROOT_ENV];
		else env[MODEL_AUDIT_ROOT_ENV] = current.envBefore;
	}

	function recordFailure(error: unknown): void {
		const reason: ModelAuditStoreErrorReason =
			error instanceof ModelAuditStoreError ? error.reason : "io";
		processStats.writeFailures += 1;
		processStats.writeFailuresByReason[reason] = (processStats.writeFailuresByReason[reason] ?? 0) + 1;
		debug(`history write failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
	}

	function enqueueWrite(marker: ModelAuditRootMarker, record: ModelAuditRecord): void {
		const write = Promise.resolve()
			.then(() => appendMismatch({ historyPath: marker.historyPath, rootCwd: marker.rootCwd, record }))
			.then(
				(result) => {
					if (result.quarantined) processStats.quarantined += 1;
				},
				recordFailure,
			);
		pendingWrites.add(write);
		void write.finally(() => pendingWrites.delete(write));
	}

	return {
		sessionStart(info: ModelAuditSessionInfo): void {
			// A start without a matching shutdown must not strand a marker.
			release();
			lifecycleGeneration += 1;
			active = false;
			enabled = isModelAuditEnabled(env);
			if (!enabled) return;
			equivalents = safeLoadEquivalents();
			const parsedInherited = parseRootMarker(env[MODEL_AUDIT_ROOT_ENV]);
			const inherited =
				parsedInherited &&
				resolve(modelAuditHistoryPath(agentDir, parsedInherited.rootCwd)) === resolve(parsedInherited.historyPath)
					? parsedInherited
					: null;
			const isTuiRoot = info.hasUI && info.mode === "tui";
			if (isTuiRoot || !inherited) {
				const token = randomHex(16);
				const rootCwd = resolve(info.cwd);
				const marker: ModelAuditRootMarker = {
					v: 1,
					token,
					rootSessionId: safeRootSessionId(info.sessionId, `ephemeral-${token}`),
					rootCwd,
					historyPath: modelAuditHistoryPath(agentDir, rootCwd),
				};
				const written = serializeRootMarker(marker);
				role = {
					kind: "owner",
					marker,
					written,
					envBefore: env[MODEL_AUDIT_ROOT_ENV],
					seq: 0,
					turnActive: false,
				};
				env[MODEL_AUDIT_ROOT_ENV] = written;
			} else {
				// Frozen: later requests of this instance stay with the turn that
				// was current when it started, however long they arrive after.
				role = { kind: "follower", marker: inherited };
			}
			active = true;
		},

		beforeAgentStart(): void {
			if (!active || role?.kind !== "owner" || role.turnActive) return;
			role.turnActive = true;
			role.seq += 1;
			role.marker = { ...role.marker, originTurnId: `${role.marker.token}:${role.seq}` };
			publish(role);
		},

		agentSettled(): void {
			if (role?.kind === "owner") role.turnActive = false;
		},

		async sessionShutdown(): Promise<void> {
			lifecycleGeneration += 1;
			active = false;
			release();
			const pending = [...pendingWrites];
			if (pending.length > 0) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const timedOut = await Promise.race([
					Promise.allSettled(pending).then(() => false),
					new Promise<boolean>((resolveTimeout) => {
						timer = setTimeout(() => resolveTimeout(true), flushMs);
						timer.unref?.();
					}),
				]);
				if (timer !== undefined) clearTimeout(timer);
				if (timedOut) {
					processStats.shutdownUnfinished += pending.filter((write) => pendingWrites.has(write)).length;
				}
			}
			const stats = processStats;
			debug(
				`process counters: ${formatModelAuditObservationSummary(stats)}; ` +
					`writeFailures=${stats.writeFailures} quarantined=${stats.quarantined} shutdownUnfinished=${stats.shutdownUnfinished}`,
			);
		},

		status(): ModelAuditStatus {
			return {
				enabled,
				marker: active && role ? role.marker : null,
				owner: role?.kind === "owner",
				equivalents,
			};
		},

		reloadEquivalents(): ModelEquivalentsLoad {
			equivalents = safeLoadEquivalents();
			return equivalents;
		},

		observeStream<S extends { result(): Promise<AssistantMessage> }>(call: ModelAuditStreamCall<S>): S {
			const marker = active && role ? role.marker : null;
			const api = call.model.api;
			if (!marker || !isModelAuditApi(api)) return call.start(call.options);

			const startedAtMs = now();
			const observationGeneration = lifecycleGeneration;
			const table = equivalents.equivalents;
			let sentModel: string | undefined;
			let fetchCalled = false;
			let observed: Record<string, unknown>;
			let sessionId: string | undefined;
			const tracker = createResponseModelTracker(api, () => sentModel, seriesDiffers(table));
			try {
				const base = (call.options ?? {}) as Record<string, unknown>;
				const original = typeof base.onPayload === "function" ? (base.onPayload as OnPayload) : undefined;
				// Without a caller onPayload every adapter sends `model.id` verbatim.
				sentModel = original ? undefined : call.model.id;
				observed = {
					...base,
					fetch: createObservingFetch(base.fetch as FetchImpl | undefined, () => {
						fetchCalled = true;
						return tracker;
					}),
				};
				if (original) {
					observed.onPayload = observeOnPayload(original, (model) => {
						sentModel = model;
					});
				}
				sessionId = typeof base.sessionId === "string" ? base.sessionId : undefined;
			} catch (error) {
				// Setting up the observation must never cost the request itself.
				debug(`observation setup failed: ${error instanceof Error ? error.message : String(error)}`);
				return call.start(call.options);
			}

			const finalize = (message: AssistantMessage | undefined): void => {
				if (!active || observationGeneration !== lifecycleGeneration) return;
				const counts = processStats.byApi[api];
				if (fetchCalled) counts.fetch += 1;
				let responseModel = tracker.selected();
				let source: "response" | "field" = "response";
				if (!responseModel) {
					const field = message?.responseModel;
					if (typeof field === "string" && field.trim()) {
						responseModel = field;
						source = "field";
					}
				}
				if (!sentModel || !responseModel) {
					counts.none += 1;
					return;
				}
				counts[source] += 1;
				if (compareModels(sentModel, responseModel, table) !== "different") return;
				const record: ModelAuditRecord = {
					id: randomHex(8),
					startedAt: new Date(startedAtMs).toISOString(),
					at: new Date(now()).toISOString(),
					rootSessionId: marker.rootSessionId,
					provider: sanitizeAuditText(call.providerId),
					api,
					sentModel: sanitizeAuditText(sentModel),
					responseModel: sanitizeAuditText(responseModel),
				};
				if (sessionId) record.sessionId = sanitizeAuditText(sessionId);
				if (marker.originTurnId !== undefined) record.originTurnId = marker.originTurnId;
				enqueueWrite(marker, record);
			};

			const stream = call.start(observed);
			try {
				stream.result().then(
					(message) => {
						try {
							finalize(message);
						} catch (error) {
							debug(`finalize failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					},
					() => undefined,
				);
			} catch {
				// A stream without a usable result() is simply not audited.
			}
			return stream;
		},
	};
}

/**
 * Wire the runtime to pi's lifecycle. Registered separately from the gateway
 * wiring so a gateway failure cannot take the audit down (and vice versa).
 */
export function registerModelAuditLifecycle(pi: ExtensionAPI, runtime: ModelAuditRuntime): void {
	pi.on("session_start", (_event, ctx) => {
		try {
			runtime.sessionStart({
				hasUI: ctx.hasUI,
				mode: ctx.mode,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			});
		} catch (error) {
			debugLog(`session_start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	pi.on("before_agent_start", () => {
		try {
			runtime.beforeAgentStart();
		} catch (error) {
			debugLog(`before_agent_start failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	pi.on("agent_settled", () => {
		runtime.agentSettled();
	});
	pi.on("session_shutdown", async () => {
		try {
			await runtime.sessionShutdown();
		} catch (error) {
			debugLog(`session_shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}
