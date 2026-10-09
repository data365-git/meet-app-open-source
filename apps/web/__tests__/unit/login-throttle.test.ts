import { describe, expect, it } from "vitest";
import {
	checkLoginAllowed,
	clearLoginFailures,
	isLoginAllowed,
	LOGIN_MAX_FAILURES,
	LOGIN_WINDOW_MS,
	recordLoginFailure,
} from "@cap/database/auth/login-throttle";

describe("isLoginAllowed (pure)", () => {
	const NOW = 1_000_000_000;

	it("allows with no prior failures", () => {
		expect(isLoginAllowed([], NOW)).toBe(true);
	});

	it("allows up to the limit and blocks at it", () => {
		const nine = Array.from({ length: LOGIN_MAX_FAILURES - 1 }, () => NOW - 1);
		expect(isLoginAllowed(nine, NOW)).toBe(true);
		const ten = Array.from({ length: LOGIN_MAX_FAILURES }, () => NOW - 1);
		expect(isLoginAllowed(ten, NOW)).toBe(false);
	});

	it("failures outside the window do not count", () => {
		const old = Array.from(
			{ length: LOGIN_MAX_FAILURES },
			() => NOW - LOGIN_WINDOW_MS - 1,
		);
		expect(isLoginAllowed(old, NOW)).toBe(true);
	});
});

describe("stateful throttle", () => {
	it("blocks after max failures, unblocks after the window slides", () => {
		const email = "throttle-test@example.com";
		clearLoginFailures(email);
		const t0 = Date.now();
		for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
			expect(checkLoginAllowed(email, t0 + i)).toBe(true);
			recordLoginFailure(email, t0 + i);
		}
		expect(checkLoginAllowed(email, t0 + LOGIN_MAX_FAILURES)).toBe(false);
		// After the window slides past the failures, attempts are allowed again.
		expect(checkLoginAllowed(email, t0 + LOGIN_WINDOW_MS + 100)).toBe(true);
		clearLoginFailures(email);
	});

	it("clearLoginFailures resets immediately (successful login path)", () => {
		const email = "throttle-clear@example.com";
		const t0 = Date.now();
		for (let i = 0; i < LOGIN_MAX_FAILURES; i++) recordLoginFailure(email, t0);
		expect(checkLoginAllowed(email, t0 + 1)).toBe(false);
		clearLoginFailures(email);
		expect(checkLoginAllowed(email, t0 + 2)).toBe(true);
	});
});
