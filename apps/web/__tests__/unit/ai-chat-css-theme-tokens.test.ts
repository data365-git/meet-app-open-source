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

// ---------------------------------------------------------------------------
// The tests above only ban raw colour LITERALS. They do nothing to prove a
// var(--token) actually resolves to anything — a typo like var(--gray-13)
// (Radix scales stop at 12) renders fully transparent, and tsc / the full
// test suite / `next build` all stay green, because CSS custom properties
// are not type-checked. This section closes that gap: every var(--token)
// used in ai-chat.css must be defined somewhere real — inside the file
// itself, in app/globals.css, or in one of the Radix colour stylesheets
// globals.css imports.
// ---------------------------------------------------------------------------

const GLOBALS_PATH = path.resolve(__dirname, "../../app/globals.css");

/** Strip /* ... *\/ comments so a stray "--gray-13:" inside a comment can't
 *  accidentally widen the allowed set. */
function stripComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** All `--name` custom properties DECLARED (not referenced) in a CSS string. */
function declaredCustomProps(css: string): Set<string> {
	const out = new Set<string>();
	const re = /(^|[{;\s])--([\w-]+)\s*:/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
	while ((m = re.exec(css)) !== null) {
		out.add(m[2] ?? "");
	}
	return out;
}

/** All `var(--name...)` REFERENCES in a CSS string (fallback args ignored). */
function referencedCustomProps(css: string): string[] {
	const out: string[] = [];
	const re = /var\(\s*--([\w-]+)/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
	while ((m = re.exec(css)) !== null) {
		out.push(m[1] ?? "");
	}
	return out;
}

/** Radix colour scale names globals.css actually imports, e.g. "gray",
 *  "gray-dark", "gray-alpha", "blue", "blue-dark", ... — only THESE files'
 *  variables are real; a scale nobody imported renders transparent even if
 *  the class name / var name looks plausible (see
 *  radix-color-scales-exist.test.ts for the Tailwind-class version of the
 *  same defect class). */
function importedRadixScaleNames(globalsCss: string): string[] {
	const re = /@import\s+["']@radix-ui\/colors\/([\w-]+)\.css["'];/g;
	const names: string[] = [];
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
	while ((m = re.exec(globalsCss)) !== null) {
		names.push(m[1] ?? "");
	}
	return names;
}

/** Every custom property this app makes available to ai-chat.css: its own
 *  local declarations, globals.css's own declarations, and every variable
 *  actually defined inside the Radix stylesheets globals.css imports. */
function buildDefinedTokenSet(aiChatCss: string): Set<string> {
	const globalsCss = fs.readFileSync(GLOBALS_PATH, "utf8");
	const defined = new Set<string>([
		...declaredCustomProps(stripComments(aiChatCss)),
		...declaredCustomProps(stripComments(globalsCss)),
	]);
	for (const scale of importedRadixScaleNames(globalsCss)) {
		const cssPath = require.resolve(`@radix-ui/colors/${scale}.css`, {
			paths: [path.dirname(GLOBALS_PATH)],
		});
		const scaleCss = fs.readFileSync(cssPath, "utf8");
		for (const name of declaredCustomProps(stripComments(scaleCss))) {
			defined.add(name);
		}
	}
	return defined;
}

function findUndefinedTokens(aiChatCss: string): string[] {
	const defined = buildDefinedTokenSet(aiChatCss);
	const used = new Set(referencedCustomProps(stripComments(aiChatCss)));
	return [...used].filter((name) => !defined.has(name)).sort();
}

describe("ai-chat.css only references CSS custom properties that actually exist", () => {
	it("has no var(--token) pointing at an undefined custom property", () => {
		const css = fs.readFileSync(CSS_PATH, "utf8");
		const undefinedTokens = findUndefinedTokens(css);
		if (undefinedTokens.length > 0) {
			throw new Error(
				`ai-chat.css references var(--token) for a custom property that is ` +
					`not defined anywhere (not locally, not in globals.css, not in an ` +
					`imported Radix scale) — it will render as fully transparent even ` +
					`though tsc/tests/build all stay green. Undefined: ` +
					`${undefinedTokens.map((t) => `--${t}`).join(", ")}`,
			);
		}
	});

	it("the checker itself actually flags a bogus token (self-test)", () => {
		// Proves findUndefinedTokens() is a real guard, not a vacuously-passing
		// no-op: a scale only goes to 12, so --gray-13 can never be defined.
		const fixture = `.x { color: var(--gray-13); }`;
		expect(findUndefinedTokens(fixture)).toEqual(["gray-13"]);
	});
});
