import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// These suites exercise the REAL retry/backoff waits (several land at 2.8-4.5s), so
		// vitest's 5s default sat right on the cliff: under load a healthy test timed out
		// ~1 run in 8. Raising the ceiling does not weaken any assertion - a broken feature
		// still fails - it only stops a slow-but-correct test from being reported as broken.
		// (A genuine hang still fails, at 20s.) Measured 2026-07-18 over 8 consecutive runs.
		testTimeout: 20000,
		include: ["src/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
	},
});
