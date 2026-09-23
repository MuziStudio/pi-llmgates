/**
 * `/model-audit`: show or clear the upstream response-model mismatches recorded
 * for the current root working directory (design §7).
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { envFlag } from "../util.js";
import { modelAuditEquivalentsPath, type ModelEquivalentsLoad } from "./compare.js";
import {
	formatModelAuditObservationSummary,
	MODEL_AUDIT_ENV,
	modelAuditProcessStats,
	recordModelAuditQuarantine,
	type ModelAuditProcessStats,
	type ModelAuditRuntime,
} from "./runtime.js";
import {
	clearModelAuditHistory,
	modelAuditCounts,
	modelAuditHistoryPath,
	readModelAuditFile,
	sanitizeAuditText,
	type ModelAuditRead,
	type ModelAuditRecord,
} from "./store.js";

export const MODEL_AUDIT_COMMAND = "model-audit";
const USAGE = "Usage: /model-audit | /model-audit clear";

export type ModelAuditCommand = { action: "show" } | { action: "clear" } | { action: "help" };

export function parseModelAuditCommand(args: string): ModelAuditCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { action: "show" };
	if (parts.length === 1 && parts[0]!.toLowerCase() === "clear") return { action: "clear" };
	if (parts.length === 1 && parts[0]!.toLowerCase() === "help") return { action: "help" };
	throw new Error(USAGE);
}

interface AuditView {
	historyPath: string;
	rootCwd: string;
	rootSessionId: string | undefined;
	originTurnId: string | undefined;
	enabled: boolean;
}

/**
 * The file this session's records go to: the runtime's marker when the audit is
 * running (a nested session writes to its root's file), else the file for the
 * current working directory.
 */
function currentView(agentDir: string, runtime: ModelAuditRuntime, ctx: ExtensionContext): AuditView {
	const status = runtime.status();
	if (status.marker) {
		return {
			historyPath: status.marker.historyPath,
			rootCwd: status.marker.rootCwd,
			rootSessionId: status.marker.rootSessionId,
			originTurnId: status.marker.originTurnId,
			enabled: status.enabled,
		};
	}
	const rootCwd = resolve(ctx.cwd);
	return {
		historyPath: modelAuditHistoryPath(agentDir, rootCwd),
		rootCwd,
		rootSessionId: undefined,
		originTurnId: undefined,
		enabled: status.enabled,
	};
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

function formatLocalTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "?";
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Every field is re-sanitized: the file is user-editable and gateway-fed. */
export function formatModelAuditRecord(record: ModelAuditRecord): string {
	return `${formatLocalTime(record.at)} · ${sanitizeAuditText(record.provider)} · sent ${sanitizeAuditText(record.sentModel)} → got ${sanitizeAuditText(record.responseModel)}`;
}

function formatFailures(stats: ModelAuditProcessStats): string {
	const reasons = Object.entries(stats.writeFailuresByReason)
		.map(([reason, count]) => `${reason} ${count}`)
		.join(", ");
	return `write failures ${stats.writeFailures}${reasons ? ` (${reasons})` : ""}, quarantined ${stats.quarantined}, unfinished at shutdown ${stats.shutdownUnfinished}`;
}

function formatEquivalents(load: ModelEquivalentsLoad, agentDir: string): string {
	const path = modelAuditEquivalentsPath(agentDir);
	switch (load.status) {
		case "missing":
			return `Equivalents: none (${path})`;
		case "ok":
			return `Equivalents: ${load.equivalents.groupCount} group(s) (${path})`;
		case "invalid":
			return `Equivalents: INVALID, ignored — ${load.reason} (${path})`;
	}
}

function fileNote(read: ModelAuditRead): string | undefined {
	switch (read.status) {
		case "newer":
			return `History file has version ${read.version}, newer than this plugin: shown read-only, not written.`;
		case "corrupt":
			return "History file is damaged: it will be quarantined and replaced on the next write.";
		case "unreadable":
			return `History file is unreadable (${read.code}).`;
		default:
			return undefined;
	}
}

export interface ModelAuditReport {
	title: string;
	lines: string[];
	records: string[];
}

export function buildModelAuditReport(
	agentDir: string,
	view: AuditView,
	equivalents: ModelEquivalentsLoad,
	stats: ModelAuditProcessStats = modelAuditProcessStats(),
): ModelAuditReport {
	const read = readModelAuditFile(view.historyPath);
	const file = read.status === "ok" ? read.file : undefined;
	const counts = view.rootSessionId
		? modelAuditCounts(file, view.rootSessionId, view.originTurnId)
		: undefined;
	const title = counts
		? `Model audit · this session: All ${counts.all} · Turn ${counts.turn} · unattributed ${counts.unattributed}`
		: `Model audit · ${view.enabled ? "not started in this session" : `off (${MODEL_AUDIT_ENV}=0)`}`;
	const lines = [
		`Directory: ${sanitizeAuditText(view.rootCwd)}`,
		`This process: ${formatFailures(stats)}`,
		`Observed (this process): ${formatModelAuditObservationSummary(stats)}`,
		formatEquivalents(equivalents, agentDir),
	];
	const note = fileNote(read);
	if (note) lines.push(note);
	const records = (file?.records ?? []).map(formatModelAuditRecord);
	return { title, lines, records };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.notify(message, level);
	} catch (error) {
		if (envFlag("LLMGATES_DEBUG")) {
			console.warn(`[pi-llmgates-model-audit] notify failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function show(agentDir: string, runtime: ModelAuditRuntime, ctx: ExtensionContext): Promise<void> {
	const equivalents = runtime.reloadEquivalents();
	const report = buildModelAuditReport(agentDir, currentView(agentDir, runtime, ctx), equivalents);
	const recordLines =
		report.records.length > 0
			? [`Recent mismatches (${report.records.length}, newest first):`, ...report.records]
			: ["No mismatches recorded for this directory."];
	if (ctx.hasUI && ctx.mode === "tui") {
		await ctx.ui.select(report.title, [...report.lines, ...recordLines]);
		return;
	}
	notify(ctx, [report.title, ...report.lines, ...recordLines].join("\n"));
}

async function clear(agentDir: string, runtime: ModelAuditRuntime, ctx: ExtensionContext): Promise<void> {
	// Clearing needs an explicit confirmation; without a UI there is nobody to ask.
	if (!ctx.hasUI) return;
	const view = currentView(agentDir, runtime, ctx);
	const confirmed = await ctx.ui.confirm(
		"Clear model audit history?",
		`Deletes every recorded mismatch for ${sanitizeAuditText(view.rootCwd)} and resets the All / Turn counts of EVERY session in this directory (status-line .xN included). The file itself is kept.`,
	);
	if (!confirmed) return;
	try {
		const result = await clearModelAuditHistory(view.historyPath, view.rootCwd);
		if (result.quarantined) recordModelAuditQuarantine();
		notify(ctx, result.cleared ? "Model audit history cleared." : "No model audit history to clear.");
	} catch (error) {
		notify(
			ctx,
			`Model audit history was NOT cleared; the file was kept: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	}
}

export function registerModelAuditCommand(pi: ExtensionAPI, agentDir: string, runtime: ModelAuditRuntime): void {
	pi.registerCommand(MODEL_AUDIT_COMMAND, {
		description: "Show upstream response-model mismatches for this directory (or `clear` them)",
		handler: async (args, ctx) => {
			let command: ModelAuditCommand;
			try {
				command = parseModelAuditCommand(args);
			} catch (error) {
				notify(ctx, error instanceof Error ? error.message : String(error), "error");
				return;
			}
			try {
				if (command.action === "help") notify(ctx, USAGE);
				else if (command.action === "clear") await clear(agentDir, runtime, ctx);
				else await show(agentDir, runtime, ctx);
			} catch (error) {
				notify(
					ctx,
					`Model audit is temporarily unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
