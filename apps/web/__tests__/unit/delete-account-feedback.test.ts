import { describe, expect, it } from "vitest";
import {
	DELETE_CONFIRMATION_PHRASE,
	NOT_AUTHENTICATED_ERROR,
	POST_DELETE_CALLBACK_URL,
	resolveDeleteOutcome,
	shouldDisableConfirm,
} from "../../app/(org)/dashboard/settings/account/delete-account-outcome";

// This file targets the account-deletion FEEDBACK path (not the erasure
// logic itself, covered by account-erasure.test.ts). Production defect: a
// successful deleteAccount() only did a soft router.push("/"), which never
// clears the NextAuth session cookie — the user stayed visually logged in
// with no confirmation, pressed delete a second time, and got the raw
// English "Not authenticated" string once the user row was already gone.
//
// Three promises pinned here:
//   1. success triggers signOut() with the /login?deleted=1 callback URL,
//      never a bare router.push("/") (that IS the defect).
//   2. once a delete has succeeded, the confirm control can never fire a
//      second deleteAccount call.
//   3. a { ok:false, error:"Not authenticated" } result is mapped to the
//      localized session-ended message, never surfaced raw.

describe("resolveDeleteOutcome", () => {
	it("maps a successful delete to a real signOut, not a soft navigation", () => {
		const outcome = resolveDeleteOutcome({ ok: true });
		expect(outcome.kind).toBe("signOut");
		if (outcome.kind !== "signOut") throw new Error("unreachable");
		// The regression: the old code called router.push("/") here instead of
		// signOut(), so the session cookie was never cleared. Pinning the exact
		// callback URL proves a real signOut()-driven navigation is used.
		expect(outcome.callbackUrl).toBe("/login?deleted=1");
		expect(outcome.callbackUrl).toBe(POST_DELETE_CALLBACK_URL);
		expect(outcome.toastKey).toBeNull();
	});

	it("maps a raw 'Not authenticated' error to the localized session-ended message, and still signs out", () => {
		const outcome = resolveDeleteOutcome({
			ok: false,
			error: NOT_AUTHENTICATED_ERROR,
		});
		expect(outcome.kind).toBe("signOut");
		if (outcome.kind !== "signOut") throw new Error("unreachable");
		expect(outcome.callbackUrl).toBe("/login?deleted=1");
		// Must be a translation KEY to localize, never the raw server literal.
		expect(outcome.toastKey).toBe("deleteAccountSessionEnded");
		expect(outcome.toastKey).not.toBe(NOT_AUTHENTICATED_ERROR);
	});

	it("passes through other server-side rejections unchanged (already user-facing)", () => {
		const outcome = resolveDeleteOutcome({
			ok: false,
			error: 'Type "delete my all data" exactly to confirm deletion.',
		});
		expect(outcome.kind).toBe("error");
		if (outcome.kind !== "error") throw new Error("unreachable");
		expect(outcome.message).toBe(
			'Type "delete my all data" exactly to confirm deletion.',
		);
	});
});

describe("shouldDisableConfirm", () => {
	const base = {
		confirmPhrase: DELETE_CONFIRMATION_PHRASE,
		isPending: false,
		deleteSucceeded: false,
	};

	it("is enabled once the exact phrase is typed and nothing is in flight", () => {
		expect(shouldDisableConfirm(base)).toBe(false);
	});

	it("stays disabled while the mutation is pending", () => {
		expect(shouldDisableConfirm({ ...base, isPending: true })).toBe(true);
	});

	it("is disabled when the phrase does not match", () => {
		expect(shouldDisableConfirm({ ...base, confirmPhrase: "wrong" })).toBe(
			true,
		);
	});

	it("stays permanently disabled after a delete has already succeeded, even with a valid phrase and no pending request — preventing a second deleteAccount call", () => {
		expect(
			shouldDisableConfirm({ ...base, deleteSucceeded: true }),
		).toBe(true);
	});
});
