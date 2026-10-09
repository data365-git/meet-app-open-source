import { describe, expect, it, vi } from "vitest";
import { getHeaders } from "@/utils/helpers";

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://app.example.com" },
}));

// S1 regression test (2026-07-21): getHeaders() used to reflect ANY origin
// back with Access-Control-Allow-Credentials: true, letting any site read
// cookie-authenticated responses from /api/thumbnail and
// /api/video/comment/delete. It must now only echo allowlisted origins.
describe("getHeaders", () => {
	it("echoes an allowlisted origin and grants credentials", () => {
		const headers = getHeaders("https://app.example.com");
		expect(headers["Access-Control-Allow-Origin"]).toBe(
			"https://app.example.com",
		);
		expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
	});

	it("echoes localhost dev origins and grants credentials", () => {
		const headers = getHeaders("http://localhost:3000");
		expect(headers["Access-Control-Allow-Origin"]).toBe(
			"http://localhost:3000",
		);
		expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
	});

	it("does NOT echo an untrusted origin and grants no credentials", () => {
		const headers = getHeaders("https://evil.example.com");
		expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
		expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
	});

	it("does NOT echo a null origin and grants no credentials", () => {
		const headers = getHeaders(null);
		expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
		expect(headers["Access-Control-Allow-Credentials"]).toBeUndefined();
	});

	it("never falls back to a wildcard origin", () => {
		const headers = getHeaders("https://evil.example.com");
		expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
	});

	it("always includes the base CORS method/header allowances", () => {
		const allowed = getHeaders("https://app.example.com");
		const blocked = getHeaders("https://evil.example.com");
		expect(allowed["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
		expect(blocked["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
		expect(allowed["Access-Control-Allow-Headers"]).toBe(
			"Content-Type, Authorization",
		);
		expect(blocked["Access-Control-Allow-Headers"]).toBe(
			"Content-Type, Authorization",
		);
	});
});
