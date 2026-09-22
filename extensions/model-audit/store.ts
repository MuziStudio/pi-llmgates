/**
 * On-disk history for `/model-audit` (design §4.1 marker, §4.3 counts, §6 store).
 *
 * One JSON file per root working directory. Counts live in `roots` and are
 * incremented in the same locked read-modify-write that appends a record, so
 * they never shrink when the 300-record display list is truncated.
 *
 * The file is an audit convenience, never a source of truth: a damaged file is
 * quarantined and replaced, a newer-version file is left untouched, and any
 * failure is reported to the caller instead of being retried here.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { encodeCwdSegment } from "../input-history-store.js";
import {
	atomicWriteJson,
	isPlainObject,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	withFileLock,
} from "../util.js";

export const LLMGATES_MODEL_AUDIT_DIR = "llmgates/model-audit";
export const MODEL_AUDIT_FILE_VERSION = 1;
export const MAX_MODEL_AUDIT_RECORDS = 300;
export const MAX_MODEL_AUDIT_ROOTS = 100;
export const MAX_MODEL_AUDIT_TURNS_PER_ROOT = 20;
/** Cap on stored model / provider / session strings, in UTF-8 bytes. */
export const MAX_MODEL_AUDIT_FIELD_BYTES = 200;

// --- root marker (§4.1) ------------------------------------------------------

export const MODEL_AUDIT_ROOT_ENV = "LLMGATES_MODEL_AUDIT_ROOT";
export const MAX_ROOT_MARKER_BYTES = 4096;

export interface ModelAuditRootMarker {
	v: 1;
	/** 128-bit hex, new on every owner `session_start`. */
	token: string;
	rootSessionId: string;
	/** Absolute, resolved root working directory. */
	rootCwd: string;
	historyPath: string;
	/** `${token}:${seq}`; absent before the root's first turn. */
	originTurnId?: string;
}

const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Root session ids become JSON object keys. pi's own ids (uuidv7) always pass;
 * anything else is replaced by a stable digest so it can never be `__proto__`
 * or an unbounded string.
 */
export function safeRootSessionId(sessionId: string | undefined, fallback: string): string {
	if (sessionId && SAFE_ID_PATTERN.test(sessionId)) return sessionId;
	if (!sessionId) return fallback;
	return `sid-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}

export function modelAuditDir(agentDir: string): string {
	return join(agentDir, LLMGATES_MODEL_AUDIT_DIR);
}

export function modelAuditHistoryPath(agentDir: string, cwd: string): string {
	return join(modelAuditDir(agentDir), `${encodeCwdSegment(resolve(cwd))}.json`);
}

export function isTurnIdOf(token: string, originTurnId: string): boolean {
	return originTurnId.startsWith(`${token}:`) && /^\d+$/.test(originTurnId.slice(token.length + 1));
}

function isValidHistoryPath(historyPath: string, rootCwd: string): boolean {
	if (!isAbsolute(historyPath) || !isAbsolute(rootCwd) || !historyPath.endsWith(".json")) {
		return false;
	}
	const dir = dirname(historyPath);
	return (
		basename(dir) === "model-audit" &&
		basename(dirname(dir)) === "llmgates" &&
		basename(historyPath) === `${encodeCwdSegment(rootCwd)}.json`
	);
}

/**
 * Parse and validate an inherited marker. Anything off — size, JSON, a missing
 * field, a history path outside `…/llmgates/model-audit/<encoded cwd>.json` —
 * makes the whole marker invalid: none of its fields are used.
 */
export function parseRootMarker(raw: string | undefined): ModelAuditRootMarker | null {
	if (!raw || Buffer.byteLength(raw, "utf8") > MAX_ROOT_MARKER_BYTES) return null;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isPlainObject(value) || value.v !== 1) return null;
	const { token, rootSessionId, rootCwd, historyPath, originTurnId } = value;
	if (
		typeof token !== "string" ||
		!TOKEN_PATTERN.test(token) ||
		typeof rootSessionId !== "string" ||
		!SAFE_ID_PATTERN.test(rootSessionId) ||
		typeof rootCwd !== "string" ||
		typeof historyPath !== "string" ||
		!isValidHistoryPath(historyPath, rootCwd)
	) {
		return null;
	}
	if (
		originTurnId !== undefined &&
		(typeof originTurnId !== "string" || !isTurnIdOf(token, originTurnId))
	) {
		return null;
	}
	const marker: ModelAuditRootMarker = { v: 1, token, rootSessionId, rootCwd, historyPath };
	if (originTurnId !== undefined) marker.originTurnId = originTurnId;
	return marker;
}

export function serializeRootMarker(marker: ModelAuditRootMarker): string {
	const value: ModelAuditRootMarker = {
		v: 1,
		token: marker.token,
		rootSessionId: marker.rootSessionId,
		rootCwd: marker.rootCwd,
		historyPath: marker.historyPath,
	};
	if (marker.originTurnId !== undefined) value.originTurnId = marker.originTurnId;
	return JSON.stringify(value);
}

// --- history file (§6) ---------------------------------------------------------

export interface ModelAuditRecord {
	id: string;
	startedAt: string;
	at: string;
	rootSessionId: string;
	sessionId?: string;
	originTurnId?: string;
	provider: string;
	api: string;
	sentModel: string;
	responseModel: string;
}

export interface ModelAuditRootCounts {
	all: number;
	unattributed: number;
	/** originTurnId → count, oldest insertion first. */
	turns: Record<string, number>;
	updatedAt: string;
}

export interface ModelAuditFile {
	version: typeof MODEL_AUDIT_FILE_VERSION;
	cwd: string;
	updatedAt: string;
	roots: Record<string, ModelAuditRootCounts>;
	/** Newest first, at most MAX_MODEL_AUDIT_RECORDS. */
	records: ModelAuditRecord[];
}

export type ModelAuditRead =
	| { status: "ok"; file: ModelAuditFile }
	| { status: "missing" }
	| { status: "corrupt" }
	| { status: "newer"; version: number }
	| { status: "unreadable"; code: string };

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let bytes = 0;
	let end = 0;
	for (const char of value) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return value.slice(0, end);
}

/**
 * Strip C0/C1 controls, DEL, line/paragraph separators and bidi overrides, then
 * cap the UTF-8 length. Upstream model names are gateway-controlled text that
 * ends up in the terminal.
 */
export function sanitizeAuditText(value: string): string {
	const cleaned = value.replace(
		/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
		"",
	);
	return truncateUtf8(cleaned.trim(), MAX_MODEL_AUDIT_FIELD_BYTES);
}

function nonNegativeInt(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function emptyRecordTable<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function sanitizeRootCounts(value: unknown): ModelAuditRootCounts | null {
	if (!isPlainObject(value)) return null;
	const turns = emptyRecordTable<number>();
	if (isPlainObject(value.turns)) {
		for (const [turnId, count] of Object.entries(value.turns)) {
			const n = nonNegativeInt(count);
			if (SAFE_ID_PATTERN.test(turnId) && n > 0) turns[turnId] = n;
		}
	}
	return {
		all: nonNegativeInt(value.all),
		unattributed: nonNegativeInt(value.unattributed),
		turns,
		updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
	};
}

const REQUIRED_RECORD_FIELDS = [
	"id",
	"startedAt",
	"at",
	"rootSessionId",
	"provider",
	"api",
	"sentModel",
	"responseModel",
] as const;

function sanitizeRecord(value: unknown): ModelAuditRecord | null {
	if (!isPlainObject(value)) return null;
	for (const field of REQUIRED_RECORD_FIELDS) {
		if (typeof value[field] !== "string") return null;
	}
	const record: ModelAuditRecord = {
		id: value.id as string,
		startedAt: value.startedAt as string,
		at: value.at as string,
		rootSessionId: value.rootSessionId as string,
		provider: value.provider as string,
		api: value.api as string,
		sentModel: value.sentModel as string,
		responseModel: value.responseModel as string,
	};
	if (typeof value.sessionId === "string") record.sessionId = value.sessionId;
	if (typeof value.originTurnId === "string") record.originTurnId = value.originTurnId;
	return record;
}

/**
 * Top-level shape errors mean "corrupt" (quarantine on the next write);
 * individual bad roots / records are dropped rather than condemning the file.
 */
function parseModelAuditFile(raw: string): ModelAuditRead {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return { status: "corrupt" };
	}
	if (!isPlainObject(value) || typeof value.version !== "number") return { status: "corrupt" };
	if (value.version > MODEL_AUDIT_FILE_VERSION) return { status: "newer", version: value.version };
	if (
		value.version !== MODEL_AUDIT_FILE_VERSION ||
		!isPlainObject(value.roots) ||
		!Array.isArray(value.records)
	) {
		return { status: "corrupt" };
	}
	const roots = emptyRecordTable<ModelAuditRootCounts>();
	for (const [rootId, counts] of Object.entries(value.roots)) {
		const sanitized = SAFE_ID_PATTERN.test(rootId) ? sanitizeRootCounts(counts) : null;
		if (sanitized) roots[rootId] = sanitized;
	}
	const records = value.records
		.map(sanitizeRecord)
		.filter((record): record is ModelAuditRecord => record !== null)
		.slice(0, MAX_MODEL_AUDIT_RECORDS);
	return {
		status: "ok",
		file: {
			version: MODEL_AUDIT_FILE_VERSION,
			cwd: typeof value.cwd === "string" ? value.cwd : "",
			updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
			roots,
			records,
		},
	};
}

export function readModelAuditFile(historyPath: string): ModelAuditRead {
	let raw: string;
	try {
		raw = readFileSync(historyPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "EIO";
		return code === "ENOENT" ? { status: "missing" } : { status: "unreadable", code };
	}
	return parseModelAuditFile(raw);
}

export interface ModelAuditCounts {
	all: number;
	turn: number;
	unattributed: number;
}

/** Counts for one root; `originTurnId` absent means Turn is 0. */
export function modelAuditCounts(
	file: ModelAuditFile | undefined,
	rootSessionId: string,
	originTurnId: string | undefined,
): ModelAuditCounts {
	if (!file || !Object.hasOwn(file.roots, rootSessionId)) return { all: 0, turn: 0, unattributed: 0 };
	const root = file.roots[rootSessionId]!;
	const turn =
		originTurnId !== undefined && Object.hasOwn(root.turns, originTurnId)
			? root.turns[originTurnId]!
			: 0;
	return { all: root.all, turn, unattributed: root.unattributed };
}

export type ModelAuditStoreErrorReason = "newer-version" | "unsafe-dir" | "lock" | "io";

export class ModelAuditStoreError extends Error {
	constructor(
		readonly reason: ModelAuditStoreErrorReason,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "ModelAuditStoreError";
	}
}

/**
 * Create / verify ONLY the `model-audit` directory itself: refuse a symlink or a
 * non-directory, create it 0700, and tighten an existing one to 0700. Parent
 * directories are never chmod'ed.
 *
 * Must run BEFORE taking the lock: proper-lockfile's non-recursive mkdir of
 * `<file>.lock` would otherwise burn its whole retry budget on ENOENT.
 */
export function ensureModelAuditDir(historyPath: string): void {
	const dir = dirname(historyPath);
	let stat: ReturnType<typeof lstatSync> | undefined;
	try {
		stat = lstatSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new ModelAuditStoreError("io", `cannot inspect ${basename(dir)} directory`, { cause: error });
		}
	}
	if (!stat) {
		try {
			mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
			stat = lstatSync(dir);
		} catch (error) {
			throw new ModelAuditStoreError("io", "cannot create the model-audit directory", { cause: error });
		}
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new ModelAuditStoreError("unsafe-dir", "the model-audit path is not a plain directory");
	}
	if (process.platform !== "win32" && (Number(stat.mode) & 0o777) !== SECRET_DIR_MODE) {
		try {
			chmodSync(dir, SECRET_DIR_MODE);
		} catch (error) {
			throw new ModelAuditStoreError("io", "cannot restrict the model-audit directory", { cause: error });
		}
	}
}

export function quarantinePath(historyPath: string): string {
	return join(dirname(historyPath), `.${basename(historyPath)}.corrupt`);
}

function emptyFile(rootCwd: string, updatedAt: string): ModelAuditFile {
	return {
		version: MODEL_AUDIT_FILE_VERSION,
		cwd: rootCwd,
		updatedAt,
		roots: emptyRecordTable<ModelAuditRootCounts>(),
		records: [],
	};
}

type LockRunner = <T>(path: string, fn: () => Promise<T> | T) => Promise<T>;

export interface ModelAuditStoreOptions {
	/** @internal Test seam; production uses the shared cross-process `withFileLock`. */
	withLock?: LockRunner;
}

interface LoadedForWrite {
	file: ModelAuditFile;
	quarantined: boolean;
}

/** Resolve every §6 read outcome (taken under the lock) to a writable file. */
function loadForWrite(
	read: ModelAuditRead,
	historyPath: string,
	rootCwd: string,
	nowIso: string,
): LoadedForWrite {
	switch (read.status) {
		case "ok":
			return { file: { ...read.file, cwd: rootCwd }, quarantined: false };
		case "missing":
			return { file: emptyFile(rootCwd, nowIso), quarantined: false };
		case "newer":
			throw new ModelAuditStoreError(
				"newer-version",
				`history file version ${read.version} is newer than this plugin; left read-only`,
			);
		case "unreadable":
			throw new ModelAuditStoreError("io", `history file is unreadable (${read.code})`);
		case "corrupt":
			try {
				// Keep one quarantined copy; rename replaces an older one.
				renameSync(historyPath, quarantinePath(historyPath));
			} catch (error) {
				throw new ModelAuditStoreError("io", "cannot quarantine the damaged history file", {
					cause: error,
				});
			}
			return { file: emptyFile(rootCwd, nowIso), quarantined: true };
	}
}

async function lockedUpdate<T>(
	historyPath: string,
	options: ModelAuditStoreOptions,
	fn: () => T,
): Promise<T> {
	ensureModelAuditDir(historyPath);
	const withLock = options.withLock ?? withFileLock;
	try {
		return await withLock(historyPath, fn);
	} catch (error) {
		if (error instanceof ModelAuditStoreError) throw error;
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ELOCKED" || code === "ECOMPROMISED") {
			throw new ModelAuditStoreError("lock", "history file is locked by another writer", { cause: error });
		}
		throw new ModelAuditStoreError("io", "history file write failed", { cause: error });
	}
}

function writeFile(historyPath: string, file: ModelAuditFile): void {
	atomicWriteJson(historyPath, file, { fileMode: SECRET_FILE_MODE, dirMode: SECRET_DIR_MODE });
}

function trimTurns(turns: Record<string, number>): void {
	const ids = Object.keys(turns);
	for (let i = 0; i < ids.length - MAX_MODEL_AUDIT_TURNS_PER_ROOT; i++) {
		delete turns[ids[i]!];
	}
}

function trimRoots(roots: Record<string, ModelAuditRootCounts>): void {
	const ids = Object.keys(roots);
	if (ids.length <= MAX_MODEL_AUDIT_ROOTS) return;
	// ISO timestamps order correctly by code unit; a missing one sorts oldest.
	const updatedAt = (id: string) => roots[id]!.updatedAt;
	ids.sort((a, b) => (updatedAt(a) < updatedAt(b) ? -1 : updatedAt(a) > updatedAt(b) ? 1 : 0));
	for (const id of ids.slice(0, ids.length - MAX_MODEL_AUDIT_ROOTS)) delete roots[id];
}

export interface AppendModelAuditInput {
	historyPath: string;
	rootCwd: string;
	record: ModelAuditRecord;
}

export interface ModelAuditWriteResult {
	/** A damaged file was moved to `.<name>.corrupt` before this write. */
	quarantined: boolean;
}

/**
 * Append one mismatch and bump its root's All / Turn (or unattributed) count in
 * a single locked read-modify-write. Throws `ModelAuditStoreError` without
 * touching the file on lock, I/O, or newer-version failures.
 */
export async function appendModelAuditMismatch(
	input: AppendModelAuditInput,
	options: ModelAuditStoreOptions = {},
): Promise<ModelAuditWriteResult> {
	const { historyPath, rootCwd, record } = input;
	return lockedUpdate(historyPath, options, () => {
		const nowIso = record.at;
		const { file, quarantined } = loadForWrite(
			readModelAuditFile(historyPath),
			historyPath,
			rootCwd,
			nowIso,
		);
		const rootId = record.rootSessionId;
		const root = Object.hasOwn(file.roots, rootId)
			? file.roots[rootId]!
			: { all: 0, unattributed: 0, turns: emptyRecordTable<number>(), updatedAt: nowIso };
		root.all += 1;
		const turnId = record.originTurnId;
		if (turnId !== undefined) {
			root.turns[turnId] = (Object.hasOwn(root.turns, turnId) ? root.turns[turnId]! : 0) + 1;
			trimTurns(root.turns);
		} else {
			root.unattributed += 1;
		}
		root.updatedAt = nowIso;
		file.roots[rootId] = root;
		trimRoots(file.roots);
		file.records = [record, ...file.records].slice(0, MAX_MODEL_AUDIT_RECORDS);
		file.updatedAt = nowIso;
		writeFile(historyPath, file);
		return { quarantined };
	});
}

export interface ClearModelAuditResult extends ModelAuditWriteResult {
	/** False when there was no file to clear. */
	cleared: boolean;
}

/**
 * Empty `records` AND `roots` under the same lock. This resets All / Turn for
 * every session in this working directory; the file itself is kept.
 */
export async function clearModelAuditHistory(
	historyPath: string,
	rootCwd: string,
	nowMs: number = Date.now(),
	options: ModelAuditStoreOptions = {},
): Promise<ClearModelAuditResult> {
	return lockedUpdate(historyPath, options, () => {
		const nowIso = new Date(nowMs).toISOString();
		const existing = readModelAuditFile(historyPath);
		if (existing.status === "missing") return { cleared: false, quarantined: false };
		const { quarantined } = loadForWrite(existing, historyPath, rootCwd, nowIso);
		writeFile(historyPath, emptyFile(rootCwd, nowIso));
		return { cleared: true, quarantined };
	});
}
