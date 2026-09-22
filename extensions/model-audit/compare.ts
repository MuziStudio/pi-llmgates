/**
 * Model-series comparison for `/model-audit` (design §3.6, decision D1).
 *
 * Only a different model SERIES counts. Version variants (dates, `-latest`,
 * numeric revisions) and gateway suffixes that are proven to select the same
 * upstream model with different call parameters normalize away; anything the
 * built-in rules cannot know about is left to the user's equivalence table.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../util.js";

/** User equivalence table, beside the other llmgates runtime files. */
export const MODEL_AUDIT_EQUIVALENTS_FILE = "llmgates/model-audit-equivalents.json";

const MAX_NORMALIZE_PASSES = 8;
const MAX_EQUIVALENT_GROUPS = 1000;
const MAX_EQUIVALENT_NAME_CHARS = 256;

const DATE_SUFFIXES = [/-\d{4}-\d{2}-\d{2}$/, /-\d{8}$/, /@\d{8}$/];
/**
 * Numeric revision tails: `gemini-1.5-pro-002` (CLIProxyAPI's own substitution
 * check tolerates exactly this), `gpt-4-0613`, `mistral-large-2411`.
 */
const REVISION_SUFFIX = /-\d{3,4}$/;

/** CLIProxyAPI `thinking.ParseSuffix`: any provider, stripped before upstream. */
const CPA_PAREN_SUFFIX = /\([^()]*\)$/;
/** NewAPI `ParseModelModifiers`: only these keys are accepted, others are rejected. */
const NEWAPI_MODIFIER_CHAIN = /(?:@(?:thinking|effort|temperature|topp):[^@]*)+$/;
/** NewAPI Claude / Gemini thinking alias (`-thinking-<n>`, `-nothinking`, `-thinking`). */
const NEWAPI_THINKING_SUFFIX =
	/^((?:claude|gemini)-[a-z0-9][a-z0-9._-]*?)-(?:thinking-[+-]?\d+|nothinking|thinking)$/;
/** NewAPI reasoning-effort tail for the gpt / o-series / Claude / Gemini families. */
const NEWAPI_EFFORT_SUFFIX =
	/^((?:gpt-[a-z0-9]|o[1-9]|claude-[a-z0-9]|gemini-[a-z0-9])[a-z0-9._-]*?)-(?:max|xhigh|high|medium|low|minimal|none)$/;
/** Real gpt / o-series ids NewAPI exempts from the effort tail (`EffortTailModelIDs`). */
const NEWAPI_EFFORT_EXEMPT = new Set(["gpt-5.1-codex-max"]);
/** NewAPI DeepSeek V4 `-none` / `-max` thinking switch. */
const NEWAPI_DEEPSEEK_V4_SUFFIX = /^(deepseek-v4-[a-z0-9._-]+?)-(?:none|max)$/;

function stripPattern(name: string, pattern: RegExp): string {
	const stripped = name.replace(pattern, "");
	return stripped || name;
}

function stripCapture(name: string, pattern: RegExp): string {
	const match = pattern.exec(name);
	return match?.[1] || name;
}

/**
 * Gateway suffix rules (design §3.6 step 2). Each one is proven from gateway
 * source to select the SAME upstream model with different call parameters; see
 * the research record in the design document before adding another.
 */
function stripGatewaySuffix(name: string): string {
	let next = stripPattern(name, CPA_PAREN_SUFFIX);
	next = stripPattern(next, NEWAPI_MODIFIER_CHAIN);
	const thinking = stripCapture(next, NEWAPI_THINKING_SUFFIX);
	if (thinking !== next) return thinking;
	if (!NEWAPI_EFFORT_EXEMPT.has(next)) {
		const effort = stripCapture(next, NEWAPI_EFFORT_SUFFIX);
		if (effort !== next) return effort;
	}
	return stripCapture(next, NEWAPI_DEEPSEEK_V4_SUFFIX);
}

function stripVersion(name: string): string {
	let next = stripPattern(name, /-latest$/);
	for (const pattern of DATE_SUFFIXES) next = stripPattern(next, pattern);
	return stripPattern(next, REVISION_SUFFIX);
}

/**
 * Steps 1 and 2 of §3.6, repeated to a fixed point so suffixes stack in either
 * order (`claude-sonnet-4-5-20250929-thinking`). Returns "" only for blank input.
 */
export function normalizeModelSeries(name: string): string {
	let current = name.trim().toLowerCase();
	current = current.slice(current.lastIndexOf("/") + 1) || current;
	for (let pass = 0; pass < MAX_NORMALIZE_PASSES; pass++) {
		const next = stripGatewaySuffix(stripVersion(current));
		if (next === current) break;
		current = next;
	}
	return current;
}

export interface ModelEquivalents {
	/** Number of groups loaded (0 for the empty table). */
	readonly groupCount: number;
	/** Canonical key of `normalized`'s group, or `normalized` itself. */
	canonical(normalized: string): string;
}

export const EMPTY_MODEL_EQUIVALENTS: ModelEquivalents = {
	groupCount: 0,
	canonical: (normalized) => normalized,
};

/**
 * Validate the table as a whole: any malformed part rejects the entire file
 * (returns null), so a typo can never half-apply. Overlapping groups merge.
 */
export function parseModelEquivalents(value: unknown): ModelEquivalents | null {
	if (!isPlainObject(value) || value.version !== 1) return null;
	const groups = value.equivalents;
	if (!Array.isArray(groups) || groups.length > MAX_EQUIVALENT_GROUPS) return null;
	const parent = new Map<string, string>();
	const find = (key: string): string => {
		let root = key;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(key, root);
		return root;
	};
	for (const group of groups) {
		if (!Array.isArray(group) || group.length === 0) return null;
		let groupRoot: string | undefined;
		for (const name of group) {
			if (
				typeof name !== "string" ||
				!name.trim() ||
				name.length > MAX_EQUIVALENT_NAME_CHARS
			) {
				return null;
			}
			const normalized = normalizeModelSeries(name);
			if (!parent.has(normalized)) parent.set(normalized, normalized);
			const root = find(normalized);
			if (groupRoot === undefined) groupRoot = root;
			else if (root !== groupRoot) parent.set(root, groupRoot);
		}
	}
	const groupCount = groups.length;
	return {
		groupCount,
		canonical: (normalized) => (parent.has(normalized) ? find(normalized) : normalized),
	};
}

export type ModelEquivalentsLoad =
	| { status: "missing"; equivalents: ModelEquivalents }
	| { status: "ok"; equivalents: ModelEquivalents }
	| { status: "invalid"; equivalents: ModelEquivalents; reason: string };

export function modelAuditEquivalentsPath(agentDir: string): string {
	return join(agentDir, MODEL_AUDIT_EQUIVALENTS_FILE);
}

/** Missing file = empty table; unreadable or malformed = empty table + reason. */
export function loadModelEquivalents(agentDir: string): ModelEquivalentsLoad {
	let raw: string;
	try {
		raw = readFileSync(modelAuditEquivalentsPath(agentDir), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "missing", equivalents: EMPTY_MODEL_EQUIVALENTS };
		}
		return {
			status: "invalid",
			equivalents: EMPTY_MODEL_EQUIVALENTS,
			reason: `unreadable (${(error as NodeJS.ErrnoException).code ?? "error"})`,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { status: "invalid", equivalents: EMPTY_MODEL_EQUIVALENTS, reason: "not valid JSON" };
	}
	const equivalents = parseModelEquivalents(parsed);
	return equivalents
		? { status: "ok", equivalents }
		: {
				status: "invalid",
				equivalents: EMPTY_MODEL_EQUIVALENTS,
				reason: 'expected {"version":1,"equivalents":[["name", ...], ...]}',
			};
}

export type ModelComparison = "unknown" | "same" | "different";

/** §3.6 verdict table. Either side missing or blank is "unknown", never a mismatch. */
export function compareModels(
	sent: string | undefined,
	response: string | undefined,
	equivalents: ModelEquivalents = EMPTY_MODEL_EQUIVALENTS,
): ModelComparison {
	if (!sent?.trim() || !response?.trim()) return "unknown";
	const a = normalizeModelSeries(sent);
	const b = normalizeModelSeries(response);
	if (a === b) return "same";
	return equivalents.canonical(a) === equivalents.canonical(b) ? "same" : "different";
}

/** `differs` predicate for the stream observer: only a series change counts. */
export function seriesDiffers(
	equivalents: ModelEquivalents,
): (request: string, candidate: string) => boolean {
	return (request, candidate) => compareModels(request, candidate, equivalents) === "different";
}
