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
