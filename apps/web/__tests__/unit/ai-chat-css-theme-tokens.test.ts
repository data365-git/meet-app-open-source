import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Owner complaint, verbatim: "umumiy dark bo'lsa dark, light bo'lsa light
// bo'lishi kerak, alohida alohida qilish ahmoqlik" — when the app is dark the
// chat popup must be dark too, and a SEPARATE per-component theme mechanism
// is itself the bug. ai-chat.css used to carry 42 hardcoded hex/rgb colours
// plus its own `.ai-popup[data-theme="dark"]` palette, painted by JS reading
// document.body classes / a cookie / prefers-color-scheme — a second theme
// system independent of the app's actual `.dark` class. It was deleted; every
// colour in the file must now come from the app's shared tokens
// (var(--gray-*), var(--blue-*), var(--green-9), var(--text-secondary) —
// defined once in app/globals.css) so the popup follows the app theme with
// zero component-level theme logic.
//
// This test is the guard against that regression coming back one "quick
// hardcoded colour" at a time. It fails on any hex (#fff, #1a1d24) or
// rgb()/rgba() colour literal in the stylesheet.

const CSS_PATH = path.resolve(
	__dirname,
	"../../app/s/[videoId]/_components/ai-chat.css",
);

// Matches #fff, #ffffff, #ffffffaa, and rgb(...)/rgba(...) function calls.
// Does NOT match CSS custom property names like --gray-a12 (no leading `#`
// or `rgb`), keyword colours (`transparent`, `currentColor`), or var(...).
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g;

// Exceptions are lines that are not theme colours at all (e.g. a scrollbar
// track literally named "transparent", or the mm:ss regex fixtures a comment
// might quote). Empty on purpose — every real colour in this file is now a
// token, so nothing needs an exception.
const ALLOWED_LINES: RegExp[] = [];

function findViolations(css: string): { line: number; text: string }[] {
	const violations: { line: number; text: string }[] = [];
	css.split("\n").forEach((lineText, idx) => {
		if (ALLOWED_LINES.some((re) => re.test(lineText))) return;
		const matches = lineText.match(COLOR_LITERAL);
		if (matches) {
			violations.push({ line: idx + 1, text: lineText.trim() });
		}
	});
	return violations;
}

describe("ai-chat.css uses only the app's shared theme tokens", () => {
	it("has no raw hex or rgb()/rgba() colour literal", () => {
		const css = fs.readFileSync(CSS_PATH, "utf8");
		const violations = findViolations(css);
		if (violations.length > 0) {
			const report = violations
				.map((v) => `  line ${v.line}: ${v.text}`)
				.join("\n");
			throw new Error(
				`ai-chat.css must take its colours from the app's shared theme ` +
					`(var(--gray-*), var(--blue-*), var(--text-secondary), ...), not a ` +
					`hardcoded value. Found ${violations.length} raw colour literal(s):\n${report}`,
			);
		}
	});

	it("still references the app's shared Radix gray/blue tokens (sanity check)", () => {
		// Guards against the test above passing for the wrong reason (e.g. the
		// whole file being emptied). If this ever fails while the test above
		// passes, the file lost its theming, not just its hardcoded colours.
		const css = fs.readFileSync(CSS_PATH, "utf8");
		expect(css).toMatch(/var\(--gray-\d{1,2}\)/);
		expect(css).toMatch(/var\(--blue-\d{1,2}\)/);
	});
});
