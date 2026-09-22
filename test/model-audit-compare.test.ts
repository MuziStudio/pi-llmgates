import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareModels,
	loadModelEquivalents,
	modelAuditEquivalentsPath,
	normalizeModelSeries,
	parseModelEquivalents,
	seriesDiffers,
} from "../extensions/model-audit/compare.js";
import { withTempAgentDir } from "./helpers/temp-agent-dir.js";

describe("normalizeModelSeries", () => {
	it.each([
		["  GPT-4o  ", "gpt-4o"],
		["openai/gpt-4o", "gpt-4o"],
		["vendor/sub/Claude-Sonnet-4-5", "claude-sonnet-4-5"],
		["gpt-4o-2024-08-06", "gpt-4o"],
		["claude-3-5-sonnet-20241022", "claude-3-5-sonnet"],
		["claude-3-5-sonnet-latest", "claude-3-5-sonnet"],
		["claude-sonnet-4-5@20250929", "claude-sonnet-4-5"],
		["gemini-1.5-pro-002", "gemini-1.5-pro"],
		["gpt-4-0613", "gpt-4"],
		["mistral-large-2411", "mistral-large"],
	])("version variant %s -> %s", (input, expected) => {
		expect(normalizeModelSeries(input)).toBe(expected);
	});

	it.each([
		// CLIProxyAPI thinking.ParseSuffix
		["gpt-5(high)", "gpt-5"],
		["claude-sonnet-4-5(8192)", "claude-sonnet-4-5"],
		// NewAPI ParseModelModifiers
		["gpt-5@effort:high", "gpt-5"],
		["claude-sonnet-4-5@thinking:on@temperature:0.2", "claude-sonnet-4-5"],
		// NewAPI Claude / Gemini thinking alias
		["claude-sonnet-4-5-thinking", "claude-sonnet-4-5"],
		["claude-sonnet-4-5-thinking-8192", "claude-sonnet-4-5"],
		["gemini-2.5-pro-nothinking", "gemini-2.5-pro"],
		// NewAPI effort tail
		["o3-high", "o3"],
		["o4-mini-high", "o4-mini"],
		["gpt-5-minimal", "gpt-5"],
		["gemini-2.5-flash-low", "gemini-2.5-flash"],
		// NewAPI DeepSeek V4 switch
		["deepseek-v4-flash-max", "deepseek-v4-flash"],
		// Stacked in either order
		["claude-sonnet-4-5-20250929-thinking", "claude-sonnet-4-5"],
		["openai/gpt-5-2025-08-07(high)", "gpt-5"],
	])("gateway suffix %s -> %s", (input, expected) => {
		expect(normalizeModelSeries(input)).toBe(expected);
	});

	it.each([
		// Real distinct ids that must NOT collapse.
		["gpt-4o-mini", "gpt-4o-mini"],
		["gpt-5.1-codex-max", "gpt-5.1-codex-max"],
		// Families outside the proven effort / thinking rules keep their tail.
		["qwen-max", "qwen-max"],
		["kimi-k2-thinking", "kimi-k2-thinking"],
		["grok-3-mini-high", "grok-3-mini-high"],
		// Never strips a name down to nothing.
		["-latest", "-latest"],
		["(high)", "(high)"],
	])("keeps %s as %s", (input, expected) => {
		expect(normalizeModelSeries(input)).toBe(expected);
	});
});

describe("compareModels", () => {
	it.each([
		["gpt-4o", "gpt-4o-2024-08-06"],
		["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
		["GPT-5", "openai/gpt-5"],
		["gpt-5(high)", "gpt-5-2025-08-07"],
	])("%s vs %s is the same series", (sent, response) => {
		expect(compareModels(sent, response)).toBe("same");
	});

	it.each([
		["gpt-4o", "gpt-4o-mini"],
		["gpt-5", "gpt-4o"],
		["claude-sonnet-4-5", "claude-3-5-haiku-20241022"],
		["gpt-5.1-codex-max", "gpt-5.1-codex"],
		["claude-opus-4-1", "claude-sonnet-4-5"],
	])("%s vs %s is a different series", (sent, response) => {
		expect(compareModels(sent, response)).toBe("different");
	});

	it.each([
		[undefined, "gpt-4o"],
		["gpt-4o", undefined],
		["  ", "gpt-4o"],
		["gpt-4o", ""],
	])("%j vs %j is unknown", (sent, response) => {
		expect(compareModels(sent, response)).toBe("unknown");
	});

	it("seriesDiffers is the observer predicate", () => {
		const differs = seriesDiffers(parseModelEquivalents({ version: 1, equivalents: [] })!);
		expect(differs("gpt-4o", "gpt-4o-2024-08-06")).toBe(false);
		expect(differs("gpt-4o", "gpt-4o-mini")).toBe(true);
	});
});

describe("model equivalents", () => {
	it("treats names in one group as the same series, after normalization", () => {
		const equivalents = parseModelEquivalents({
			version: 1,
			equivalents: [["my-sonnet-alias", "claude-sonnet-4-5"]],
		})!;
		expect(equivalents.groupCount).toBe(1);
		expect(compareModels("my-sonnet-alias", "claude-sonnet-4-5-20250929", equivalents)).toBe("same");
		expect(compareModels("my-sonnet-alias", "claude-opus-4-1", equivalents)).toBe("different");
	});

	it("merges overlapping groups", () => {
		const equivalents = parseModelEquivalents({
			version: 1,
			equivalents: [
				["alias-a", "alias-b"],
				["alias-b", "alias-c"],
			],
		})!;
		expect(compareModels("alias-a", "alias-c", equivalents)).toBe("same");
	});

	it.each([
		null,
		[],
		{ version: 2, equivalents: [] },
		{ version: 1 },
		{ version: 1, equivalents: {} },
		{ version: 1, equivalents: [["a", 1]] },
		{ version: 1, equivalents: [[]] },
		{ version: 1, equivalents: [["a", "  "]] },
		{ version: 1, equivalents: ["a"] },
		{ version: 1, equivalents: [["x".repeat(257)]] },
	])("rejects the whole table for %j", (value) => {
		expect(parseModelEquivalents(value)).toBeNull();
	});

	it("loads missing / valid / malformed files from the agent dir", () => {
		const { agentDir, cleanup } = withTempAgentDir();
		try {
			expect(loadModelEquivalents(agentDir)).toMatchObject({ status: "missing" });

			const path = modelAuditEquivalentsPath(agentDir);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ version: 1, equivalents: [["a", "b"]] }));
			const loaded = loadModelEquivalents(agentDir);
			expect(loaded.status).toBe("ok");
			expect(compareModels("a", "b", loaded.equivalents)).toBe("same");

			writeFileSync(path, "{ not json");
			const broken = loadModelEquivalents(agentDir);
			expect(broken).toMatchObject({ status: "invalid", reason: "not valid JSON" });
			expect(compareModels("a", "b", broken.equivalents)).toBe("different");

			writeFileSync(path, JSON.stringify({ version: 1, equivalents: [["a", 2]] }));
			expect(loadModelEquivalents(agentDir)).toMatchObject({ status: "invalid" });
		} finally {
			cleanup();
		}
	});
});
