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
	authorizePaidGeminiUse,
	getPaidGeminiKey,
	hasPaidGeminiKey,
	PaidWhileFreeAvailableError,
} from "@/lib/gemini-paid-key";

describe("INVARIANT (owner's rule, single behaviour): a job never pays while free quota is still available", () => {
	it("a job-bound sync call with freeAttempted:false is refused", () => {
		expect(() =>
			getPaidGeminiKey({
				operation: "transcription",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(PaidWhileFreeAvailableError);
		expect(() =>
			getPaidGeminiKey({
				operation: "generation",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(PaidWhileFreeAvailableError);
	});

	it("a job-bound sync call AFTER the free chain had its chance receives the key — paying then is the REQUESTED behaviour", () => {
		expect(
			getPaidGeminiKey({
				operation: "transcription",
				route: "sync",
				freeAttempted: true,
			}),
		).toBe("server-paid-key");
		expect(
			getPaidGeminiKey({
				operation: "generation",
				route: "sync",
				freeAttempted: true,
			}),
		).toBe("server-paid-key");
	});

	it("the standalone authorization exists so OWNER-KEY call sites pass the identical check", () => {
		expect(() =>
			authorizePaidGeminiUse({
				operation: "transcription",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(PaidWhileFreeAvailableError);
		expect(() =>
			authorizePaidGeminiUse({
				operation: "transcription",
				route: "sync",
				freeAttempted: true,
			}),
		).not.toThrow();
	});

	it("job-less uses have NO freeAttempted field to falsify", () => {
		expect(getPaidGeminiKey({ operation: "ops-script", route: "sync" })).toBe(
			"server-paid-key",
		);
		expect(getPaidGeminiKey({ operation: "translation", route: "sync" })).toBe(
			"server-paid-key",
		);
		expect(
			getPaidGeminiKey({ operation: "legacy-batch-admin", route: "batch" }),
		).toBe("server-paid-key");
		const src = readFileSync(
			fileURLToPath(new URL("../../lib/gemini-paid-key.ts", import.meta.url)),
			"utf8",
		);
		// The job-less arm of the union must not accept the declaration at all.
		expect(src).toMatch(/"translation"[\s\S]{0,600}route: "sync" \| "batch";\s*\}/);
		expect(hasPaidGeminiKey()).toBe(true);
	});
});

describe("BOUNDARY: only lib/gemini-paid-key.ts reads the paid env var on the AI path", () => {
	const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
	const SCAN_DIRS = ["lib", "workflows", "app", "actions", "hooks", "scripts"];
	const GATE_FILE = join("lib", "gemini-paid-key.ts");
	// Every READ shape (round-7 #5) — property access, bracket access, and
	// destructuring off serverEnv()/process.env. `GEMINI_API_KEY_FREE` and
	// message strings ("set GEMINI_API_KEY") do not match these shapes.
	const DIRECT_READ_PATTERNS: RegExp[] = [
		/\.GEMINI_API_KEY(?!_)/, // env.GEMINI_API_KEY / process.env.GEMINI_API_KEY
		/\[\s*["'`]GEMINI_API_KEY["'`]\s*\]/, // process.env["GEMINI_API_KEY"]
		/\{[^{}]*\bGEMINI_API_KEY\b(?!_)[^{}]*\}\s*=/, // const { GEMINI_API_KEY } = ...
	];

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

	it("no direct GEMINI_API_KEY read (dot, bracket, or destructuring) exists outside the gate module — scripts/ included", () => {
		const offenders: string[] = [];
		for (const dir of SCAN_DIRS) {
			for (const file of walk(join(APP_ROOT, dir))) {
				if (file.endsWith(GATE_FILE)) continue;
				const source = readFileSync(file, "utf8");
				if (DIRECT_READ_PATTERNS.some((pattern) => pattern.test(source))) {
					offenders.push(file.slice(APP_ROOT.length));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
