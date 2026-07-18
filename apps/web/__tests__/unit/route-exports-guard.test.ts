import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Next.js App Router permits only a fixed set of exports from a route file.
// Anything else fails typecheck — but ONLY against the generated .next/types,
// which exist solely after a build. So `tsc --noEmit` on a clean checkout is
// blind to it, and this repo shipped a violation
// (recover-stale-ai-jobs/route.ts exporting six helpers) that every local
// "tsc 0" reported as clean. It surfaced only when an external QA run happened
// to build the app. A 15-minute production build is too slow to gate every
// commit, so this cheap deterministic check stands in for it: it runs in the
// normal unit suite, and therefore in CI, with no extra wiring.
//
// Route helpers belong in a sibling module (the convention here is e.g.
// multipart-utils.ts, s3Config.ts, stale-job-helpers.ts) which the route
// imports back.

const ALLOWED_EXPORTS = new Set([
	// HTTP method handlers
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"HEAD",
	"OPTIONS",
	// Route segment config
	"dynamic",
	"dynamicParams",
	"revalidate",
	"fetchCache",
	"runtime",
	"preferredRegion",
	"maxDuration",
	"config",
	"generateStaticParams",
]);

const API_ROOT = join(__dirname, "..", "..", "app");

function findRouteFiles(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "node_modules" || entry === ".next") continue;
			findRouteFiles(full, found);
		} else if (entry === "route.ts" || entry === "route.tsx") {
			found.push(full);
		}
	}
	return found;
}

/** Top-level `export const|function|async function|class NAME` and
 * `export { a, b }`. Deliberately simple: it must not need a TS parser to run
 * in the unit suite, and every real violation so far has been a plain
 * top-level export. */
function exportedNames(source: string): string[] {
	const names: string[] = [];
	for (const m of source.matchAll(
		/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm,
	)) {
		if (m[1]) names.push(m[1]);
	}
	for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
		for (const part of (m[1] ?? "").split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim();
			if (name) names.push(name);
		}
	}
	return names;
}

describe("Next.js route files export only sanctioned names", () => {
	const routeFiles = findRouteFiles(API_ROOT);

	it("finds route files to check (guards against a broken glob silently passing)", () => {
		expect(routeFiles.length).toBeGreaterThan(10);
	});

	it.each(routeFiles.map((f) => [f.slice(API_ROOT.length + 1), f]))(
		"%s",
		(_label, file) => {
			const offending = exportedNames(readFileSync(file, "utf8")).filter(
				(n) => !ALLOWED_EXPORTS.has(n),
			);
			expect(
				offending,
				`${file} exports ${offending.join(", ")}, which Next.js does not permit from a route file. Move the helper(s) into a sibling module and import them back.`,
			).toEqual([]);
		},
	);
});
