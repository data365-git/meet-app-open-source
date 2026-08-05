import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A Radix-token class name is not proof the token exists. `bg-green-3` looked
// exactly like the `bg-gray-1` next to it and rendered NOTHING, because the
// Tailwind config only ever built gray/gray-a/blue scales — about ten sites
// (success banners, the "ready" pill, the recorder's how-it-works accent) shipped
// unstyled for months and no gate noticed, because the class name is valid text
// and the build is green either way.
//
// This test closes that: every numbered Radix-style colour class used in the app
// must have a matching scale in the config, AND that scale's CSS variables must
// actually be imported. It fails if a scale is removed, and it fails if someone
// writes a class for a colour nobody defined.

const REPO = path.resolve(__dirname, "../../../..");
const WEB_APP = path.join(REPO, "apps/web/app");
const CONFIG = path.join(REPO, "packages/ui/style/tailwind.config.js");
const GLOBALS = path.join(REPO, "apps/web/app/globals.css");

// Only real Radix colour NAMES, so `border-b-2`, `ring-offset-1` and
// `divide-spacing-y-2` cannot masquerade as a colour called "b" / "offset" /
// "spacing-y". Add a name here when the design system genuinely gains a colour.
const RADIX_COLOR_NAMES = [
	"gray",
	"mauve",
	"slate",
	"sage",
	"olive",
	"sand",
	"blue",
	"green",
	"amber",
	"purple",
	"yellow",
	"orange",
	"teal",
	"cyan",
	"indigo",
	"violet",
	"crimson",
	"pink",
	"plum",
] as const;

/** `bg-green-3`, `text-gray-11`, `hover:border-blue-6`, `dark:bg-green-4` … */
const NUMBERED_COLOR_CLASS = new RegExp(
	String.raw`\b(?:bg|text|border|ring|fill|stroke|divide|outline|shadow|from|via|to)-(${RADIX_COLOR_NAMES.join("|")})-(\d{1,2})(?![\w-])`,
	"g",
);

/** Scales in the config that are NOT Radix 1..12 — different, valid systems. */
const NON_RADIX_SCALES = new Set([
	"red", // overridden with a bespoke 50..400 palette
	"white-transparent",
	"blue-transparent",
	"red-transparent",
	"gray-transparent",
]);

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === ".next") continue;
			walk(full, out);
		} else if (/\.(tsx|ts)$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

function configuredScales(): Record<string, unknown> {
	// biome-ignore lint/security/noGlobalEval: reading our own config file
	const factory = require(CONFIG) as (a: unknown, b: unknown) => {
		theme: { extend: { colors: Record<string, unknown> } };
	};
	return factory({}, {}).theme.extend.colors;
}

describe("Radix colour scales referenced by the app actually exist", () => {
	const colors = configuredScales();
	const globals = fs.readFileSync(GLOBALS, "utf8");

	it("every numbered colour class in apps/web/app has a configured scale", () => {
		const missing = new Map<string, string>();

		for (const file of walk(WEB_APP)) {
			const source = fs.readFileSync(file, "utf8");
			for (const match of source.matchAll(NUMBERED_COLOR_CLASS)) {
				const [, name, step] = match;
				if (!name || !step) continue;
				if (NON_RADIX_SCALES.has(name)) continue;
				const scale = colors[name] as Record<string, string> | undefined;
				// Only 1..12 classes are Radix-shaped; a `-50`/`-900` class comes
				// from Tailwind's own default palette, which is always present.
				const n = Number(step);
				if (n < 1 || n > 12) continue;
				if (!scale || scale[step] === undefined) {
					missing.set(
						`${name}-${step}`,
						path.relative(REPO, file).replace(/\\/g, "/"),
					);
				}
			}
		}

		expect(
			Object.fromEntries(missing),
			"these colour classes render as nothing — either add the scale to packages/ui/style/tailwind.config.js or use the default palette (e.g. bg-green-50 with an explicit dark: variant)",
		).toEqual({});
	});

	it("every configured Radix scale has its CSS variables imported", () => {
		for (const [name, scale] of Object.entries(colors)) {
			if (NON_RADIX_SCALES.has(name)) continue;
			const values = scale as Record<string, string>;
			if (typeof values !== "object" || values["1"] === undefined) continue;
			// The scale points at var(--name-1..12); those come from a
			// @radix-ui/colors import. Without the import the scale is transparent,
			// which is a worse failure than the missing scale it replaced.
			const base = name.replace(/-a$/, "");
			expect(
				globals,
				`packages/ui config defines the "${name}" scale, but globals.css never imports @radix-ui/colors/${base}.css`,
			).toContain(`@radix-ui/colors/${base}`);
		}
	});
});
