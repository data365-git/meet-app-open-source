/**
 * The OpenRouter credential gets the SAME boundary the paid Gemini credential
 * got after five review rounds of money defects (see
 * __tests__/unit/gemini-paid-key.test.ts). Two properties, both of which have
 * already failed once in this codebase on the other credential:
 *
 *  1. THE INVARIANT: a job cannot obtain the paid credential while free quota
 *     is still available.
 *  2. THE BOUNDARY: no file outside lib/openrouter-key.ts reads
 *     `OPENROUTER_API_KEY` — this is what fails the build on the next
 *     reintroduction, which tsc and a full green suite never did.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ OPENROUTER_API_KEY: "server-openrouter-key" }),
}));

import {
	authorizeOpenRouterUse,
	getOpenRouterKey,
	hasOpenRouterKey,
	OpenRouterWhileFreeAvailableError,
} from "@/lib/openrouter-key";

describe("INVARIANT: a job never pays OpenRouter while free quota is still available", () => {
	it("a job-bound sync call with freeAttempted:false is refused", () => {
		expect(() =>
			getOpenRouterKey({
				operation: "transcription",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(OpenRouterWhileFreeAvailableError);
		expect(() =>
			getOpenRouterKey({
				operation: "generation",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(OpenRouterWhileFreeAvailableError);
	});

	it("a job-bound sync call AFTER the free chain had its chance receives the key", () => {
		expect(
			getOpenRouterKey({
				operation: "transcription",
				route: "sync",
				freeAttempted: true,
			}),
		).toBe("server-openrouter-key");
		expect(
			getOpenRouterKey({
				operation: "generation",
				route: "sync",
				freeAttempted: true,
			}),
		).toBe("server-openrouter-key");
	});

	it("the standalone authorization exists so other call sites pass the identical check", () => {
		expect(() =>
			authorizeOpenRouterUse({
				operation: "transcription",
				route: "sync",
				freeAttempted: false,
			}),
		).toThrow(OpenRouterWhileFreeAvailableError);
		expect(() =>
			authorizeOpenRouterUse({
				operation: "transcription",
				route: "sync",
				freeAttempted: true,
			}),
		).not.toThrow();
	});

	it("job-less uses have NO freeAttempted field to falsify", () => {
		expect(getOpenRouterKey({ operation: "translation", route: "sync" })).toBe(
			"server-openrouter-key",
		);
		expect(getOpenRouterKey({ operation: "chat", route: "sync" })).toBe(
			"server-openrouter-key",
		);
		expect(getOpenRouterKey({ operation: "ops-script", route: "sync" })).toBe(
			"server-openrouter-key",
		);
		const src = readFileSync(
			fileURLToPath(new URL("../../lib/openrouter-key.ts", import.meta.url)),
			"utf8",
		);
		// The job-less arm of the union must not accept the declaration at all.
		expect(src).toMatch(/"translation"[\s\S]{0,600}route: "sync";\s*\}/);
		expect(hasOpenRouterKey()).toBe(true);
	});
});

describe("BOUNDARY: only lib/openrouter-key.ts reads OPENROUTER_API_KEY", () => {
	const APP_ROOT = fileURLToPath(new URL("../..", import.meta.url));
	const SCAN_DIRS = ["lib", "workflows", "app", "actions", "hooks", "scripts"];
	const GATE_FILE = join("lib", "openrouter-key.ts");
	const DIRECT_READ_PATTERNS: RegExp[] = [
		/\.OPENROUTER_API_KEY\b/, // env.OPENROUTER_API_KEY / process.env.…
		/\[\s*["'`]OPENROUTER_API_KEY["'`]\s*\]/, // process.env["OPENROUTER_API_KEY"]
		/\{[^{}]*\bOPENROUTER_API_KEY\b[^{}]*\}\s*=/, // const { OPENROUTER_API_KEY } = …
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

	it("no direct OPENROUTER_API_KEY read exists outside the gate module — scripts/ included", () => {
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

	it("no literal OpenRouter key value is committed anywhere on the AI path", () => {
		const offenders: string[] = [];
		for (const dir of SCAN_DIRS) {
			for (const file of walk(join(APP_ROOT, dir))) {
				// Match a real key value, not the redaction regex that names the
				// prefix followed by a character CLASS.
				if (/sk-or-v1-[A-Za-z0-9_-]{20,}/.test(readFileSync(file, "utf8"))) {
					offenders.push(file.slice(APP_ROOT.length));
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
