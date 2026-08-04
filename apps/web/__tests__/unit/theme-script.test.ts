import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// public/theme-script.js runs beforeInteractive as a bare IIFE, so it cannot be
// imported. It is executed here against fake window/document objects instead.
//
// What this pins is the exact defect the owner reported: the script used to do
// `classList.add(cookie || "light")`, hard-coding light whenever no theme cookie
// existed — so the share page (and the whole app) never followed a dark device.
// The colours are not testable here; this decision is, and it is the part that
// actually broke.
const SCRIPT_SRC = readFileSync(
	join(__dirname, "../../public/theme-script.js"),
	"utf8",
);

function runThemeScript(opts: {
	cookie?: string;
	prefersDark: boolean;
	pathname: string;
}): string[] {
	const added: string[] = [];
	const documentStub = {
		cookie: opts.cookie ?? "",
		documentElement: { classList: { add: () => {} } },
		body: { classList: { add: (c: string) => added.push(c) } },
	};
	const windowStub = {
		location: { pathname: opts.pathname },
		matchMedia: (q: string) => ({
			matches: q.includes("dark") ? opts.prefersDark : false,
		}),
		addEventListener: () => {},
	};
	// biome-ignore lint/security/noGlobalEval: executing the real shipped file is the point
	new Function("window", "document", SCRIPT_SRC)(windowStub, documentStub);
	return added;
}

// The script is inlined into <head>, so on a COLD load <body> does not exist
// when it runs. This helper reproduces exactly that: no `body` on the document
// at script time, which is the state that produced the owner's bug report
// ("dark mode didn't work until I reloaded").
function runInHeadBeforeBody(opts: {
	cookie?: string;
	prefersDark: boolean;
	pathname: string;
}): { htmlClasses: string[]; deferredToDomReady: boolean } {
	const htmlClasses: string[] = [];
	let deferred = false;
	const documentStub: Record<string, unknown> = {
		cookie: opts.cookie ?? "",
		documentElement: {
			classList: { add: (c: string) => htmlClasses.push(c) },
		},
		body: null, // <body> genuinely absent, as in <head>
	};
	const windowStub = {
		location: { pathname: opts.pathname },
		matchMedia: (q: string) => ({
			matches: q.includes("dark") ? opts.prefersDark : false,
		}),
		addEventListener: () => {
			deferred = true;
		},
	};
	new Function("window", "document", SCRIPT_SRC)(windowStub, documentStub);
	return { htmlClasses, deferredToDomReady: deferred };
}

describe("theme-script runs before <body> exists (the reload bug)", () => {
	it("themes <html> IMMEDIATELY on a cold load, so the first paint is not light", () => {
		const r = runInHeadBeforeBody({
			prefersDark: true,
			pathname: "/s/abc123",
		});
		// This is the whole fix: without it the class could only be applied at
		// DOMContentLoaded, i.e. after the page had already painted light.
		expect(r.htmlClasses).toEqual(["dark"]);
		// and it still defers the <body> class for the code that reads it
		expect(r.deferredToDomReady).toBe(true);
	});

	it("still lets an explicit cookie win at that same early moment", () => {
		expect(
			runInHeadBeforeBody({
				cookie: "theme=light",
				prefersDark: true,
				pathname: "/dashboard/caps",
			}).htmlClasses,
		).toEqual(["light"]);
	});

	it("does not touch <html> on an unthemed path", () => {
		expect(
			runInHeadBeforeBody({ prefersDark: true, pathname: "/" }).htmlClasses,
		).toEqual([]);
	});
});

describe("theme-script fallback", () => {
	it("falls back to the DEVICE preference when there is no cookie", () => {
		// The regression: this used to return ["light"] no matter the device.
		expect(
			runThemeScript({ prefersDark: true, pathname: "/s/abc123" }),
		).toEqual(["dark"]);
	});

	it("stays light when there is no cookie and the device is light", () => {
		expect(
			runThemeScript({ prefersDark: false, pathname: "/s/abc123" }),
		).toEqual(["light"]);
	});

	it("lets an explicit cookie WIN over the device preference", () => {
		// A user who chose a theme must keep it, even against a dark OS.
		expect(
			runThemeScript({
				cookie: "theme=light",
				prefersDark: true,
				pathname: "/s/abc123",
			}),
		).toEqual(["light"]);
		expect(
			runThemeScript({
				cookie: "theme=dark",
				prefersDark: false,
				pathname: "/dashboard/caps",
			}),
		).toEqual(["dark"]);
	});

	it("applies to the share page, not only the dashboard", () => {
		expect(
			runThemeScript({ prefersDark: true, pathname: "/s/xyz" }),
		).toEqual(["dark"]);
		expect(
			runThemeScript({ prefersDark: true, pathname: "/login" }),
		).toEqual(["dark"]);
	});

	it("leaves unthemed paths alone", () => {
		expect(runThemeScript({ prefersDark: true, pathname: "/" })).toEqual([]);
	});
});
