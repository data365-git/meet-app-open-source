import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Measured on production 2026-08-10: the og:image every social scraper fetches
// answered `302 Location: https://0.0.0.0:3000/api/video/og?...`. Behind the
// Coolify/Traefik proxy `request.url` is the container's own origin, so building
// the fallback with `new URL(path, request.url)` produced an address nothing
// outside the container can reach — every shared recording showed a blank
// preview card in Telegram, WhatsApp and Slack.
//
// The fix is to stop building an absolute URL at all: a relative Location is
// resolved by the client against the URL it actually requested, so it is right
// on any host and cannot be broken by a misconfigured base-URL env.
const SRC = readFileSync(
	fileURLToPath(
		new URL("../../app/api/video/preview/route.ts", import.meta.url),
	),
	"utf8",
);

function bodyOf(name: string): string {
	const start = SRC.indexOf(`function ${name}`);
	expect(start, `${name} not found`).toBeGreaterThan(-1);
	const next = SRC.indexOf("\nexport ", start + 1);
	return SRC.slice(start, next === -1 ? undefined : next);
}

/**
 * Comments are stripped before asserting: the fix's own comment quotes the
 * broken pattern it replaced, and without this the test would fail on the
 * explanation rather than on the code.
 */
function codeOf(name: string): string {
	return bodyOf(name)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("video preview og fallback", () => {
	const body = bodyOf("getFallbackResponse");

	it("redirects to a relative path", () => {
		expect(body).toMatch(/Location:\s*`\/api\/video\/og\?/);
	});

	it("never derives the redirect from the incoming request's own origin", () => {
		// `request.url` inside the container is https://0.0.0.0:3000 — the exact
		// value that broke this in production.
		const code = codeOf("getFallbackResponse");
		expect(code).not.toMatch(/new URL\([^)]*request\.url/);
		expect(code).not.toMatch(/NextResponse\.redirect/);
	});

	it("still 404s when the caller did not ask for the og fallback", () => {
		expect(body).toMatch(/fallback.*!==\s*"og"/s);
		expect(body).toMatch(/status:\s*404/);
	});
});
