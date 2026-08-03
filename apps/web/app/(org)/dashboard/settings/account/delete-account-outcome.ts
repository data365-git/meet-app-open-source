// Pure feedback-path decisions for account deletion, split out of
// Settings.tsx so they can be unit-tested without importing the client
// component (which transitively pulls in the "use server" deleteAccount
// action and its server-only DB imports — those cannot be imported from a
// test or from a Client Component module).

export const DELETE_CONFIRMATION_PHRASE = "delete my all data";

// The server returns this exact literal when the session's user row is
// already gone (e.g. a second press after the first already erased the
// account). It must never surface raw to the user — map it to the
// localized message instead.
export const NOT_AUTHENTICATED_ERROR = "Not authenticated";

export const POST_DELETE_CALLBACK_URL = "/login?deleted=1";

export type DeleteAccountResult = { ok: true } | { ok: false; error: string };

export type DeleteOutcome =
	// Successful erasure: sign out for real (clears the session cookie +
	// full-page navigation) so the login page can show a confirmation banner.
	| { kind: "signOut"; callbackUrl: string; toastKey: null }
	// The server no longer recognizes the session (e.g. a second press after
	// the first already erased the account). Never show the raw English
	// "Not authenticated" string — sign out with the same localized banner.
	| {
			kind: "signOut";
			callbackUrl: string;
			toastKey: "deleteAccountSessionEnded";
	  }
	// Any other rejection (wrong phrase, org still has members, ...) is
	// already a localized/user-facing string from the server — show it as-is.
	| { kind: "error"; message: string };

/**
 * Pure decision function for what the DangerZone delete mutation should do
 * with a deleteAccount() result.
 */
export function resolveDeleteOutcome(
	result: DeleteAccountResult,
): DeleteOutcome {
	if (result.ok) {
		return {
			kind: "signOut",
			callbackUrl: POST_DELETE_CALLBACK_URL,
			toastKey: null,
		};
	}
	if (result.error === NOT_AUTHENTICATED_ERROR) {
		return {
			kind: "signOut",
			callbackUrl: POST_DELETE_CALLBACK_URL,
			toastKey: "deleteAccountSessionEnded",
		};
	}
	return { kind: "error", message: result.error };
}

/**
 * Pure decision for whether the confirm button may fire — once a delete has
 * succeeded it must stay disabled so a second deleteAccount call can never
 * fire while the signOut() navigation is in flight.
 */
export function shouldDisableConfirm(state: {
	confirmPhrase: string;
	isPending: boolean;
	deleteSucceeded: boolean;
}): boolean {
	return (
		state.confirmPhrase !== DELETE_CONFIRMATION_PHRASE ||
		state.isPending ||
		state.deleteSucceeded
	);
}
