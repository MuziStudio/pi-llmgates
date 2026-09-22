import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		isolate: true,
		testTimeout: 20_000,
		hookTimeout: 20_000,
		// A pi session exports its /model-audit root marker to every bash command,
		// including a test run started from it. Never let tests inherit it.
		env: { LLMGATES_MODEL_AUDIT_ROOT: "" },
	},
});
