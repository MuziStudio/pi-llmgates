import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeCwdSegment } from "../extensions/input-history-store.js";
import {
	appendModelAuditMismatch,
	clearModelAuditHistory,
	MAX_MODEL_AUDIT_FIELD_BYTES,
	MAX_MODEL_AUDIT_RECORDS,
	MAX_MODEL_AUDIT_ROOTS,
	MAX_MODEL_AUDIT_TURNS_PER_ROOT,
	modelAuditCounts,
	modelAuditDir,
	modelAuditHistoryPath,
	MAX_ROOT_MARKER_BYTES,
	MODEL_AUDIT_LOCK_OPTIONS,
	ModelAuditStoreError,
	parseRootMarker,
	quarantinePath,
	readModelAuditFile,
	safeRootSessionId,
	sanitizeAuditText,
	serializeRootMarker,
	type ModelAuditFile,
	type ModelAuditRecord,
	type ModelAuditRootMarker,
} from "../extensions/model-audit/store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const posixOnly = process.platform === "win32" ? it.skip : it;

let seq = 0;
function record(overrides: Partial<ModelAuditRecord> = {}): ModelAuditRecord {
	seq += 1;
	const at = new Date(Date.UTC(2026, 8, 22, 0, 0, seq)).toISOString();
	return {
		id: seq.toString(16).padStart(16, "0"),
		startedAt: at,
		at,
		rootSessionId: "root-a",
		originTurnId: `${TOKEN}:1`,
		provider: "work-newapi",
		api: "openai-completions",
		sentModel: "gpt-5",
		responseModel: "gpt-4o",
		...overrides,
	};
}

function okFile(path: string): ModelAuditFile {
	const read = readModelAuditFile(path);
	if (read.status !== "ok") throw new Error(`expected ok, got ${read.status}`);
	return read.file;
}

function setup() {
	const temp = withTempAgentDir();
	const rootCwd = resolve(temp.agentDir, "project");
	const historyPath = modelAuditHistoryPath(temp.agentDir, rootCwd);
	const append = (overrides: Partial<ModelAuditRecord> = {}) =>
		appendModelAuditMismatch({ historyPath, rootCwd, record: record(overrides) });
	return { ...temp, rootCwd, historyPath, append };
}

describe("root marker", () => {
	function marker(overrides: Partial<ModelAuditRootMarker> = {}): ModelAuditRootMarker {
		const rootCwd = resolve("/abs/project");
		return {
			v: 1,
			token: TOKEN,
			rootSessionId: "0199-session",
			rootCwd,
			historyPath: modelAuditHistoryPath(resolve("/home/u/.pi/agent"), rootCwd),
			...overrides,
		};
	}

	it("round-trips a valid marker with and without originTurnId", () => {
		const base = marker();
		expect(parseRootMarker(serializeRootMarker(base))).toEqual(base);
		const withTurn = marker({ originTurnId: `${TOKEN}:3` });
		expect(parseRootMarker(serializeRootMarker(withTurn))).toEqual(withTurn);
	});

	it.each([
		["undefined", undefined],
		["not JSON", "{"],
		["wrong version", JSON.stringify({ ...marker(), v: 2 })],
		["short token", JSON.stringify({ ...marker(), token: "abc" })],
		["missing session", JSON.stringify({ ...marker(), rootSessionId: undefined })],
		["unsafe session id", JSON.stringify({ ...marker(), rootSessionId: "__proto__" })],
		["relative history path", JSON.stringify({ ...marker(), historyPath: "llmgates/model-audit/x.json" })],
		["not .json", JSON.stringify({ ...marker(), historyPath: marker().historyPath.replace(/\.json$/, ".txt") })],
		[
			"parent is not model-audit",
			JSON.stringify({ ...marker(), historyPath: join(resolve("/tmp/llmgates/other"), `${encodeCwdSegment(resolve("/abs/project"))}.json`) }),
		],
		[
			"name does not match rootCwd",
			JSON.stringify({ ...marker(), historyPath: modelAuditHistoryPath(resolve("/home/u/.pi/agent"), resolve("/elsewhere")) }),
		],
		["foreign turn id", JSON.stringify({ ...marker(), originTurnId: "ffffffffffffffffffffffffffffffff:1" })],
		[
			"non-canonical history path",
			JSON.stringify({
				...marker(),
				historyPath: marker().historyPath.replace("/llmgates/model-audit/", "/llmgates/model-audit/../model-audit/"),
			}),
		],
		["non-canonical rootCwd", JSON.stringify({ ...marker(), rootCwd: `${resolve("/abs/project")}/.` })],
		["over the size cap", JSON.stringify({ ...marker(), pad: "x".repeat(MAX_ROOT_MARKER_BYTES) })],
	])("rejects %s as a whole", (_label, raw) => {
		expect(parseRootMarker(raw)).toBeNull();
	});

	it("accepts a marker for a working directory near PATH_MAX", () => {
		// 16 × 251 bytes: a real directory can be this deep (NAME_MAX 255, PATH_MAX 4096).
		const rootCwd = resolve("/", ...Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(250)));
		const long = marker({
			rootCwd,
			historyPath: modelAuditHistoryPath(resolve("/home/u/.pi/agent"), rootCwd),
			originTurnId: `${TOKEN}:1`,
		});
		expect(Buffer.byteLength(serializeRootMarker(long))).toBeGreaterThan(4096);
		expect(parseRootMarker(serializeRootMarker(long))).toEqual(long);
	});

	it("safeRootSessionId keeps pi ids and digests anything else", () => {
		expect(safeRootSessionId("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "fb")).toBe(
			"0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
		);
		expect(safeRootSessionId(undefined, "fb")).toBe("fb");
		const hashed = safeRootSessionId("__proto__", "fb");
		expect(hashed).toMatch(/^sid-[0-9a-f]{32}$/);
		expect(safeRootSessionId("__proto__", "fb")).toBe(hashed);
	});
});

describe("model audit store", () => {
	it("waits for the history lock with unref'd retry timers", () => {
		expect(MODEL_AUDIT_LOCK_OPTIONS.retries).toMatchObject({ unref: true, retries: 10 });
		expect(MODEL_AUDIT_LOCK_OPTIONS.stale).toBe(30_000);
	});

	it("appends newest-first and keeps counts per root and turn", async () => {
		const { historyPath, rootCwd, append, cleanup } = setup();
		try {
			await append({ sentModel: "a" });
			await append({ sentModel: "b", originTurnId: `${TOKEN}:2` });
			await append({ sentModel: "c", originTurnId: undefined });
			await append({ sentModel: "d", rootSessionId: "root-b" });
			const file = okFile(historyPath);
			expect(file.cwd).toBe(rootCwd);
			expect(file.records.map((r) => r.sentModel)).toEqual(["d", "c", "b", "a"]);
			expect(modelAuditCounts(file, "root-a", `${TOKEN}:1`)).toEqual({ all: 3, turn: 1, unattributed: 1 });
			expect(modelAuditCounts(file, "root-a", `${TOKEN}:2`)).toMatchObject({ turn: 1 });
			expect(modelAuditCounts(file, "root-a", undefined)).toMatchObject({ all: 3, turn: 0 });
			expect(modelAuditCounts(file, "root-b", `${TOKEN}:1`)).toEqual({ all: 1, turn: 1, unattributed: 0 });
			expect(modelAuditCounts(file, "missing", undefined)).toEqual({ all: 0, turn: 0, unattributed: 0 });
		} finally {
			cleanup();
		}
	});

	it("counts are not affected by the record cap", async () => {
		const { historyPath, append, cleanup } = setup();
		try {
			for (let i = 0; i < MAX_MODEL_AUDIT_RECORDS + 5; i++) await append();
			const file = okFile(historyPath);
			expect(file.records).toHaveLength(MAX_MODEL_AUDIT_RECORDS);
			expect(modelAuditCounts(file, "root-a", `${TOKEN}:1`)).toMatchObject({
				all: MAX_MODEL_AUDIT_RECORDS + 5,
				turn: MAX_MODEL_AUDIT_RECORDS + 5,
			});
		} finally {
			cleanup();
		}
	}, 60_000);

	it("keeps the most recent turns per root and evicts the oldest roots", async () => {
		const { historyPath, append, cleanup } = setup();
		try {
			for (let i = 1; i <= MAX_MODEL_AUDIT_TURNS_PER_ROOT + 2; i++) {
				await append({ originTurnId: `${TOKEN}:${i}` });
			}
			let file = okFile(historyPath);
			const turns = Object.keys(file.roots["root-a"]!.turns);
			expect(turns).toHaveLength(MAX_MODEL_AUDIT_TURNS_PER_ROOT);
			expect(turns[0]).toBe(`${TOKEN}:3`);
			expect(file.roots["root-a"]!.all).toBe(MAX_MODEL_AUDIT_TURNS_PER_ROOT + 2);

			for (let i = 0; i < MAX_MODEL_AUDIT_ROOTS; i++) await append({ rootSessionId: `root-${i}` });
			file = okFile(historyPath);
			expect(Object.keys(file.roots)).toHaveLength(MAX_MODEL_AUDIT_ROOTS);
			expect(Object.hasOwn(file.roots, "root-a")).toBe(false);
			expect(Object.hasOwn(file.roots, `root-${MAX_MODEL_AUDIT_ROOTS - 1}`)).toBe(true);
		} finally {
			cleanup();
		}
	}, 60_000);

	it("isolates working directories into separate files", async () => {
		const { agentDir, cleanup } = setup();
		try {
			const a = modelAuditHistoryPath(agentDir, join(agentDir, "a"));
			const b = modelAuditHistoryPath(agentDir, join(agentDir, "b"));
			expect(a).not.toBe(b);
			await appendModelAuditMismatch({ historyPath: a, rootCwd: join(agentDir, "a"), record: record() });
			expect(okFile(a).records).toHaveLength(1);
			expect(readModelAuditFile(b).status).toBe("missing");
		} finally {
			cleanup();
		}
	});

	it("serializes concurrent appends and a concurrent clear", async () => {
		const { historyPath, rootCwd, append, cleanup } = setup();
		try {
			await Promise.all(Array.from({ length: 20 }, () => append()));
			expect(okFile(historyPath).roots["root-a"]!.all).toBe(20);

			const racing = [
				...Array.from({ length: 5 }, () => append()),
				clearModelAuditHistory(historyPath, rootCwd),
				...Array.from({ length: 5 }, () => append()),
			];
			await Promise.all(racing);
			const file = okFile(historyPath);
			// Whatever landed after the clear is internally consistent.
			expect(file.records.length).toBe(file.roots["root-a"]?.all ?? 0);
		} finally {
			cleanup();
		}
	});

	it("leaves a newer-version file read-only", async () => {
		const { historyPath, append, cleanup } = setup();
		try {
			mkdirSync(modelAuditDir(join(historyPath, "../../..")), { recursive: true });
			const newer = JSON.stringify({ version: 2, roots: {}, records: [] });
			writeFileSync(historyPath, newer);
			expect(readModelAuditFile(historyPath)).toEqual({ status: "newer", version: 2 });
			await expect(append()).rejects.toMatchObject({ reason: "newer-version" });
			expect(readFileSync(historyPath, "utf8")).toBe(newer);
		} finally {
			cleanup();
		}
	});

	it("quarantines a damaged file, keeps one copy, and starts fresh", async () => {
		const { historyPath, append, cleanup } = setup();
		try {
			await append();
			writeFileSync(historyPath, "{ broken one");
			expect(readModelAuditFile(historyPath).status).toBe("corrupt");
			await expect(append()).resolves.toEqual({ quarantined: true });
			expect(readFileSync(quarantinePath(historyPath), "utf8")).toBe("{ broken one");
			expect(okFile(historyPath).roots["root-a"]!.all).toBe(1);

			writeFileSync(historyPath, JSON.stringify({ version: 1, roots: [], records: [] }));
			await expect(append()).resolves.toEqual({ quarantined: true });
			expect(JSON.parse(readFileSync(quarantinePath(historyPath), "utf8"))).toMatchObject({ roots: [] });
		} finally {
			cleanup();
		}
	});

	it("drops individual bad roots and records instead of condemning the file", async () => {
		const { historyPath, append, cleanup } = setup();
		try {
			await append();
			const raw = JSON.parse(readFileSync(historyPath, "utf8"));
			raw.records.push({ id: 1 }, "junk");
			raw.roots["__proto__"] = { all: 5 };
			raw.roots["root-z"] = { all: -3, turns: { [`${TOKEN}:1`]: "x" } };
			writeFileSync(historyPath, JSON.stringify(raw));
			const file = okFile(historyPath);
			expect(file.records).toHaveLength(1);
			expect(Object.getPrototypeOf(file.roots)).toBeNull();
			expect(file.roots["root-z"]).toMatchObject({ all: 0, turns: {} });
		} finally {
			cleanup();
		}
	});

	it("clear empties records and every root's counts but keeps the file", async () => {
		const { historyPath, rootCwd, append, cleanup } = setup();
		try {
			expect(await clearModelAuditHistory(historyPath, rootCwd)).toEqual({ cleared: false, quarantined: false });
			await append();
			await append({ rootSessionId: "root-b" });
			expect(await clearModelAuditHistory(historyPath, rootCwd)).toEqual({ cleared: true, quarantined: false });
			const file = okFile(historyPath);
			expect(file.records).toEqual([]);
			expect(file.roots).toEqual({});

			writeFileSync(historyPath, "garbage");
			expect(await clearModelAuditHistory(historyPath, rootCwd)).toEqual({ cleared: true, quarantined: true });
			expect(okFile(historyPath).records).toEqual([]);
		} finally {
			cleanup();
		}
	});

	posixOnly("creates the model-audit dir 0700 / file 0600 and fixes only that dir", async () => {
		const { agentDir, historyPath, append, cleanup } = setup();
		try {
			chmodSync(join(agentDir, "llmgates"), 0o755);
			mkdirSync(modelAuditDir(agentDir), { mode: 0o755 });
			chmodSync(modelAuditDir(agentDir), 0o755);
			await append();
			expect(statSync(modelAuditDir(agentDir)).mode & 0o777).toBe(0o700);
			expect(statSync(historyPath).mode & 0o777).toBe(0o600);
			expect(statSync(join(agentDir, "llmgates")).mode & 0o777).toBe(0o755);
		} finally {
			cleanup();
		}
	});

	posixOnly("refuses a symlinked model-audit directory", async () => {
		const { agentDir, append, cleanup } = setup();
		try {
			const elsewhere = join(agentDir, "elsewhere");
			mkdirSync(elsewhere);
			symlinkSync(elsewhere, modelAuditDir(agentDir));
			await expect(append()).rejects.toMatchObject({ reason: "unsafe-dir" });
		} finally {
			cleanup();
		}
	});

	it("maps a lock failure to a lock error without touching the file", async () => {
		const { historyPath, rootCwd, append, cleanup } = setup();
		try {
			await append();
			const before = readFileSync(historyPath, "utf8");
			const busy = Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
			const failure = appendModelAuditMismatch(
				{ historyPath, rootCwd, record: record() },
				{ withLock: async () => Promise.reject(busy) },
			);
			await expect(failure).rejects.toBeInstanceOf(ModelAuditStoreError);
			await expect(failure).rejects.toMatchObject({ reason: "lock" });
			expect(readFileSync(historyPath, "utf8")).toBe(before);
			expect(existsSync(quarantinePath(historyPath))).toBe(false);
		} finally {
			cleanup();
		}
	});
});

describe("sanitizeAuditText", () => {
	it("strips control, separator and bidi characters", () => {
		expect(sanitizeAuditText("gpt\u001b[31m-4o\n\u2028\u202e")).toBe("gpt[31m-4o");
	});

	it("caps the UTF-8 length without splitting a code point", () => {
		const long = "模".repeat(MAX_MODEL_AUDIT_FIELD_BYTES);
		const capped = sanitizeAuditText(long);
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThanOrEqual(MAX_MODEL_AUDIT_FIELD_BYTES);
		expect(capped).toBe("模".repeat(Math.floor(MAX_MODEL_AUDIT_FIELD_BYTES / 3)));
	});
});
