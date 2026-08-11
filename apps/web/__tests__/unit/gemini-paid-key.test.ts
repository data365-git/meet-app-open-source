/**
 * Round-6 structural fix (judge's verdict after five review rounds): the
 * recurring money defect was the ABSENCE OF A BOUNDARY around the paid
 * Gemini credential — ambiently in scope, every error path's default was the
 * full-price call. This file pins:
 *
 *  1. THE INVARIANT that was missing all along: a cheap transcription job can
 *     never obtain the key for the full-price synchronous route.
 *  2. THE BOUNDARY: no AI-path file reads `.GEMINI_API_KEY` directly — only
 *     lib/gemini-paid-key.ts may. (This is the test that fails the build on
 *     the next reintroduction, which tsc + 1328 tests + next build never did.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: "server-paid-key" }),
}));

import {
	assertCheapNeverUsesFullPriceSync,
	CheapFullPriceViolationError,
	getPaidGeminiKey,
	hasPaidGeminiKey,
} from "@/lib/gemini-paid-key";

describe("INVARIANT: a cheap job never bills the full-price path", () => {
	it("cheap transcription can NOT obtain the key for the synchronous route", () => {
		expect(() =>
			getPaidGeminiKey({
				operation: "transcription",
				mode: "cheap",
				route: "sync",
			}),
		).toThrow(CheapFullPriceViolationError);
	});

	it("the runtime backstop protects owner-key call sites too", () => {
		expect(() => assertCheapNeverUsesFullPriceSync("cheap")).toThrow(
			CheapFullPriceViolationError,
		);
		expect(() => assertCheapNeverUsesFullPriceSync("fast")).not.toThrow();
		expect(() => assertCheapNeverUsesFullPriceSync(undefined)).not.toThrow();
	});

	it("authorized uses receive the key: fast sync, cheap Batch (the discounted route), generation, owner's explicit click", () => {
		expect(
			getPaidGeminiKey({ operation: "transcription", mode: "fast", route: "sync" }),
		).toBe("server-paid-key");
		expect(
			getPaidGeminiKey({
				operation: "transcription",
				mode: "cheap",
				route: "batch",
			}),
		).toBe("server-paid-key");
		expect(getPaidGeminiKey({ operation: "generation", mode: "cheap" })).toBe(
			"server-paid-key",
		);
		expect(getPaidGeminiKey({ operation: "owner-continue-paid" })).toBe(
			"server-paid-key",
		);
		expect(hasPaidGeminiKey()).toBe(true);
	});
});

describe("BOUNDARY: only lib/gemini-paid-key.ts reads the paid env var on the AI path", () => {
	const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
	const SCAN_DIRS = ["lib", "workflows", "app", "actions", "hooks"];
	const GATE_FILE = join("lib", "gemini-paid-key.ts");
	// Property access on the PAID key; `GEMINI_API_KEY_FREE` and message
	// strings ("set GEMINI_API_KEY") do not match this shape.
	const DIRECT_READ = /\.GEMINI_API_KEY(?!_)/;

	function walk(dir: string, out: string[] = []): string[] {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				walk(full, out);
			} else if (/\.(ts|tsx)$/.test(entry)) {
				out.push(full);
			}
		}
		return out;
	}

	it("no direct .GEMINI_API_KEY read exists outside the gate module", () => {
		const offenders: string[] = [];
		for (const dir of SCAN_DIRS) {
			for (const file of walk(join(APP_ROOT, dir))) {
				if (file.endsWith(GATE_FILE)) continue;
				if (DIRECT_READ.test(readFileSync(file, "utf8"))) {
					offenders.push(file.slice(APP_ROOT.length));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
