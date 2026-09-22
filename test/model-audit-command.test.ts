import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { modelAuditEquivalentsPath } from "../extensions/model-audit/compare.js";
import {
	formatModelAuditRecord,
	parseModelAuditCommand,
	registerModelAuditCommand,
} from "../extensions/model-audit/command.js";
import {
	createModelAuditRuntime,
	modelAuditProcessStats,
	resetModelAuditProcessStats,
	type ModelAuditRuntime,
} from "../extensions/model-audit/runtime.js";
import {
	appendModelAuditMismatch,
	readModelAuditFile,
	type ModelAuditRecord,
} from "../extensions/model-audit/store.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

type Handler = (args: string, ctx: ExtensionContext) => Promise<void>;

interface UiLog {
	selects: Array<{ title: string; options: string[] }>;
	notes: Array<{ message: string; level?: string }>;
	confirms: Array<{ title: string; message: string }>;
}

function fakeCtx(
	mode: "tui" | "rpc" | "print",
	cwd: string,
	confirmAnswer = true,
): { ctx: ExtensionContext; log: UiLog } {
	const log: UiLog = { selects: [], notes: [], confirms: [] };
	const ctx = {
		hasUI: mode !== "print",
		mode,
		cwd,
		ui: {
			select: async (title: string, options: string[]) => {
				log.selects.push({ title, options });
				return undefined;
			},
			notify: (message: string, level?: string) => log.notes.push({ message, level }),
			confirm: async (title: string, message: string) => {
				log.confirms.push({ title, message });
				return confirmAnswer;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, log };
}

function setup(envOverrides: NodeJS.ProcessEnv = {}) {
	const temp = withTempAgentDir();
	const cwd = resolve(temp.agentDir, "project");
	const runtime: ModelAuditRuntime = createModelAuditRuntime({
		agentDir: temp.agentDir,
		env: { ...envOverrides },
		debug: () => undefined,
	});
	let handler: Handler | undefined;
	const pi = {
		registerCommand: (name: string, options: { handler: Handler }) => {
			if (name === "model-audit") handler = options.handler;
		},
	} as unknown as ExtensionAPI;
	registerModelAuditCommand(pi, temp.agentDir, runtime);
	return { ...temp, cwd, runtime, run: (args: string, ctx: ExtensionContext) => handler!(args, ctx) };
}

let seq = 0;
function record(overrides: Partial<ModelAuditRecord>): ModelAuditRecord {
	seq += 1;
	const at = new Date(Date.UTC(2026, 8, 22, 1, 2, seq)).toISOString();
	return {
		id: seq.toString(16).padStart(16, "0"),
		startedAt: at,
		at,
		rootSessionId: "root-1",
		provider: "work-newapi",
		api: "openai-completions",
		sentModel: "gpt-5",
		responseModel: "gpt-4o",
		...overrides,
	};
}

beforeEach(() => resetModelAuditProcessStats());

describe("parseModelAuditCommand", () => {
	it.each([
		["", { action: "show" }],
		["  ", { action: "show" }],
		["clear", { action: "clear" }],
		["CLEAR", { action: "clear" }],
		["help", { action: "help" }],
	])("%j", (args, expected) => {
		expect(parseModelAuditCommand(args)).toEqual(expected);
	});

	it.each(["clear now", "list", "clear --yes"])("rejects %j with the usage line", (args) => {
		expect(() => parseModelAuditCommand(args)).toThrow(/Usage: \/model-audit/);
	});
});

describe("/model-audit", () => {
	it("TUI: shows this root's counts, process counters, equivalents, and newest-first records", async () => {
		const s = setup();
		try {
			s.runtime.sessionStart({ hasUI: true, mode: "tui", cwd: s.cwd, sessionId: "root-1" });
			s.runtime.beforeAgentStart();
			const marker = s.runtime.status().marker!;
			const turn = marker.originTurnId!;
			for (const overrides of [
				{ originTurnId: turn, responseModel: "gpt-4o" },
				{ originTurnId: turn, responseModel: "gpt-4o-mini" },
				{ responseModel: "claude-3-5-haiku" },
				{ rootSessionId: "someone-else" },
			] satisfies Partial<ModelAuditRecord>[]) {
				await appendModelAuditMismatch({ historyPath: marker.historyPath, rootCwd: s.cwd, record: record(overrides) });
			}
			const { ctx, log } = fakeCtx("tui", s.cwd);
			await s.run("", ctx);
			expect(log.selects).toHaveLength(1);
			const { title, options } = log.selects[0]!;
			expect(title).toBe("Model audit · this session: All 3 · Turn 2 · unattributed 1");
			expect(options[0]).toBe(`Directory: ${s.cwd}`);
			expect(options).toContain(
				"This process: write failures 0, quarantined 0, unfinished at shutdown 0",
			);
			expect(options.some((line) => line.startsWith("Observed (this process): openai-completions fetch=0"))).toBe(true);
			expect(options).toContain(`Equivalents: none (${modelAuditEquivalentsPath(s.agentDir)})`);
			expect(options).toContain("Recent mismatches (4, newest first):");
			const records = options.slice(options.indexOf("Recent mismatches (4, newest first):") + 1);
			expect(records).toHaveLength(4);
			expect(records[1]).toMatch(/ · work-newapi · sent gpt-5 → got claude-3-5-haiku$/);
		} finally {
			await s.runtime.sessionShutdown();
			s.cleanup();
		}
	});

	it("non-TUI with a UI channel notifies the same report; without one it stays silent", async () => {
		const s = setup();
		try {
			const rpc = fakeCtx("rpc", s.cwd);
			await s.run("", rpc.ctx);
			expect(rpc.log.selects).toHaveLength(0);
			expect(rpc.log.notes).toHaveLength(1);
			expect(rpc.log.notes[0]!.message).toContain("No mismatches recorded for this directory.");
			expect(rpc.log.notes[0]!.message).toContain("Model audit · not started in this session");

			const print = fakeCtx("print", s.cwd);
			await expect(s.run("", print.ctx)).resolves.toBeUndefined();
			expect(print.log.notes).toHaveLength(0);
		} finally {
			s.cleanup();
		}
	});

	it("says when the audit is switched off", async () => {
		const s = setup({ LLMGATES_MODEL_AUDIT: "0" });
		try {
			s.runtime.sessionStart({ hasUI: true, mode: "tui", cwd: s.cwd, sessionId: "root-1" });
			const { ctx, log } = fakeCtx("rpc", s.cwd);
			await s.run("", ctx);
			expect(log.notes[0]!.message).toContain("Model audit · off (LLMGATES_MODEL_AUDIT=0)");
		} finally {
			s.cleanup();
		}
	});

	it("re-reads the equivalence table and reports an invalid one", async () => {
		const s = setup();
		try {
			const path = modelAuditEquivalentsPath(s.agentDir);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "{ nope");
			const { ctx, log } = fakeCtx("rpc", s.cwd);
			await s.run("", ctx);
			expect(log.notes[0]!.message).toContain("Equivalents: INVALID, ignored — not valid JSON");
			writeFileSync(path, JSON.stringify({ version: 1, equivalents: [["a", "b"]] }));
			await s.run("", ctx);
			expect(log.notes[1]!.message).toContain("Equivalents: 1 group(s)");
		} finally {
			s.cleanup();
		}
	});

	it("escapes control characters from a hand-edited history file", () => {
		expect(
			formatModelAuditRecord(record({ provider: "p\u001b[2J", responseModel: "gpt-4o\nFAKE LINE" })),
		).toMatch(/ · p\[2J · sent gpt-5 → got gpt-4oFAKE LINE$/);
	});

	it("clear asks first, keeps the file on 'no', and empties records and counts on 'yes'", async () => {
		const s = setup();
		try {
			s.runtime.sessionStart({ hasUI: true, mode: "tui", cwd: s.cwd, sessionId: "root-1" });
			const { historyPath } = s.runtime.status().marker!;
			await appendModelAuditMismatch({ historyPath, rootCwd: s.cwd, record: record({}) });
			const before = readFileSync(historyPath, "utf8");

			const no = fakeCtx("tui", s.cwd, false);
			await s.run("clear", no.ctx);
			expect(no.log.confirms[0]!.message).toContain("EVERY session in this directory");
			expect(readFileSync(historyPath, "utf8")).toBe(before);

			const yes = fakeCtx("tui", s.cwd, true);
			await s.run("clear", yes.ctx);
			expect(yes.log.notes.at(-1)).toEqual({ message: "Model audit history cleared.", level: "info" });
			const read = readModelAuditFile(historyPath);
			expect(read.status === "ok" && read.file.records.length === 0 && Object.keys(read.file.roots).length === 0).toBe(true);

			const noUi = fakeCtx("print", s.cwd, true);
			await s.run("clear", noUi.ctx);
			expect(noUi.log.confirms).toHaveLength(0);
		} finally {
			await s.runtime.sessionShutdown();
			s.cleanup();
		}
	});

	it("clear reports a failure and keeps a newer-version file untouched", async () => {
		const s = setup();
		try {
			s.runtime.sessionStart({ hasUI: true, mode: "tui", cwd: s.cwd, sessionId: "root-1" });
			const { historyPath } = s.runtime.status().marker!;
			mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
			const newer = JSON.stringify({ version: 9, roots: {}, records: [] });
			writeFileSync(historyPath, newer);
			const { ctx, log } = fakeCtx("tui", s.cwd, true);
			await s.run("clear", ctx);
			expect(log.notes.at(-1)!.level).toBe("error");
			expect(log.notes.at(-1)!.message).toMatch(/NOT cleared/);
			expect(readFileSync(historyPath, "utf8")).toBe(newer);

			await s.run("", ctx);
			expect(log.selects.at(-1)!.options).toContain(
				"History file has version 9, newer than this plugin: shown read-only, not written.",
			);
		} finally {
			await s.runtime.sessionShutdown();
			s.cleanup();
		}
	});

	it("clear of a damaged file quarantines it and counts that for this process", async () => {
		const s = setup();
		try {
			s.runtime.sessionStart({ hasUI: true, mode: "tui", cwd: s.cwd, sessionId: "root-1" });
			const { historyPath } = s.runtime.status().marker!;
			mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
			writeFileSync(historyPath, "garbage");
			const { ctx } = fakeCtx("tui", s.cwd, true);
			await s.run("clear", ctx);
			expect(modelAuditProcessStats().quarantined).toBe(1);
		} finally {
			await s.runtime.sessionShutdown();
			s.cleanup();
		}
	});

	it("rejects unknown arguments with the usage line", async () => {
		const s = setup();
		try {
			const { ctx, log } = fakeCtx("rpc", s.cwd);
			await s.run("bogus", ctx);
			expect(log.notes).toEqual([{ message: "Usage: /model-audit | /model-audit clear", level: "error" }]);
		} finally {
			s.cleanup();
		}
	});
});
