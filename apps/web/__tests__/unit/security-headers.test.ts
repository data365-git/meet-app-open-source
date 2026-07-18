import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface HeaderRule {
	source: string;
	headers: { key: string; value: string }[];
}

// Both of these are untyped JS (`allowJs` is false), so they are resolved at
// runtime rather than imported — a static import would fail the tsc gate.
const { pathToRegexp } = createRequire(import.meta.url)(
	"next/dist/compiled/path-to-regexp",
) as { pathToRegexp: (source: string) => RegExp };

const nextConfig = (
	(await import(new URL("../../next.config.mjs", import.meta.url).href)) as {
		default: { headers: () => Promise<HeaderRule[]> };
	}
).default;

// Resolves the headers a given request path actually receives, by replaying
// Next's own `source` matching over every rule in next.config.mjs. Asserting on
// behaviour per-path (rather than on the shape of the config) is what keeps the
// embed carve-outs honest.
async function headersFor(path: string): Promise<Record<string, string>> {
	const rules = await nextConfig.headers();
	const resolved: Record<string, string> = {};
	for (const rule of rules) {
		if (!pathToRegexp(rule.source).test(path)) continue;
		for (const { key, value } of rule.headers) resolved[key.toLowerCase()] = value;
	}
	return resolved;
}

const GLOBAL_PATHS = ["/", "/login", "/dashboard/caps", "/embed/abc", "/s/abc"];

describe("global security headers", () => {
	it.each(GLOBAL_PATHS)("sends HSTS on %s", async (path) => {
		const h = await headersFor(path);
		expect(h["strict-transport-security"]).toMatch(/^max-age=\d+/);
	});

	it.each(GLOBAL_PATHS)("sends nosniff on %s", async (path) => {
		const h = await headersFor(path);
		expect(h["x-content-type-options"]).toBe("nosniff");
	});

	it.each(GLOBAL_PATHS)("sends a strict Referrer-Policy on %s", async (path) => {
		const h = await headersFor(path);
		expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
	});

	it.each(GLOBAL_PATHS)("sends a Permissions-Policy on %s", async (path) => {
		const h = await headersFor(path);
		expect(h["permissions-policy"]).toBeDefined();
	});
});

describe("HSTS stays conservative for the current duckdns/railway host", () => {
	it("never preloads and never claims subdomains", async () => {
		const hsts = (await headersFor("/"))["strict-transport-security"] ?? "";
		// `preload` is effectively irreversible; `includeSubDomains` buys nothing
		// on a single-host deployment but locks future sub-subdomains to HTTPS.
		expect(hsts).not.toMatch(/preload/i);
		expect(hsts).not.toMatch(/includeSubDomains/i);
	});

	it("keeps max-age short enough to recover from a lapsed certificate", async () => {
		const hsts = (await headersFor("/"))["strict-transport-security"] ?? "";
		const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? "0");
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge).toBeLessThanOrEqual(604800);
	});
});

// The web recorder (dashboard) calls getUserMedia/getDisplayMedia. Denying these
// features in Permissions-Policy breaks recording silently — no console error
// that points here. Omitting a feature keeps its default allowlist of `self`,
// which is what we want.
describe("Permissions-Policy does not break the web recorder", () => {
	it.each(["camera", "microphone", "display-capture"])(
		"leaves %s at its default self allowlist",
		async (feature) => {
			const pp = (await headersFor("/dashboard/caps"))["permissions-policy"] ?? "";
			expect(pp).not.toMatch(new RegExp(`\\b${feature}=\\(\\s*\\)`));
		},
	);

	it.each(["autoplay", "fullscreen"])(
		"leaves %s alone so the video player keeps working",
		async (feature) => {
			const pp = (await headersFor("/embed/abc"))["permissions-policy"] ?? "";
			expect(pp).not.toMatch(new RegExp(`\\b${feature}=\\(\\s*\\)`));
		},
	);
});

// /embed/[videoId] is a real third-party embed target (Twitter player card,
// customer iframes) and /s/ + /c/ are shared publicly. Any frame denial on these
// paths breaks the product for viewers with no error surfaced to the owner.
describe("framing", () => {
	it.each(["/embed/abc", "/s/abc", "/c/abc"])(
		"never denies framing on %s",
		async (path) => {
			const h = await headersFor(path);
			expect(h["x-frame-options"]).toBeUndefined();
			expect(h["content-security-policy"] ?? "").not.toMatch(/frame-ancestors/);
		},
	);

	it.each(["/dashboard/caps", "/signup", "/onboarding", "/"])(
		"denies cross-origin framing on %s",
		async (path) => {
			const h = await headersFor(path);
			expect(h["x-frame-options"]).toBe("SAMEORIGIN");
			expect(h["content-security-policy"]).toMatch(/frame-ancestors 'self'/);
		},
	);

	// proxy.ts already owns /login's frame policy (frame-ancestors https://cap.so).
	// Browsers INTERSECT multiple CSP headers, so adding `frame-ancestors 'self'`
	// here would silently make /login unframable and change existing behaviour.
	it("leaves /login to proxy.ts", async () => {
		const h = await headersFor("/login");
		expect(h["x-frame-options"]).toBeUndefined();
		expect(h["content-security-policy"]).toBeUndefined();
	});
});

// Explicitly out of scope this pass: a nonce/script-src CSP on Next.js is a
// large, breakage-prone change. This guards against it being slipped in.
describe("scope guard", () => {
	it("adds no script-src or default-src directive", async () => {
		for (const path of GLOBAL_PATHS.concat("/embed/abc")) {
			const csp = (await headersFor(path))["content-security-policy"] ?? "";
			expect(csp).not.toMatch(/script-src|default-src/);
		}
	});
});
