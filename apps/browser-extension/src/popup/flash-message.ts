import type { ExtensionState } from "../background/state";

// ── The popup's honest one-line status/error, as RENDERED STATE ──────────────
//
// popup.ts rebuilds the whole popup (root.innerHTML = "") several times a second
// while a recording runs. Wave 1 showed the Pause/Resume failure and the discard
// result by creating a node and appending it to the live root AFTER awaiting the
// service worker's reply — but by the time that reply landed a re-render had
// already detached that root, so the message was appended to a dead tree and the
// user never saw it (a silent no-op, the exact lie this work exists to remove).
//
// The fix keeps the message in module state that render() draws on EVERY rebuild.
// This module holds the PURE part of that state — what message is live, which
// app-state it belongs to, and when a later state makes it stale — with no DOM or
// chrome dependency, so it is unit-testable in this package's node test env
// (importing popup.ts itself runs init() and cannot be).

export interface FlashMessage {
	readonly text: string;
	readonly isError: boolean;
}

export interface FlashState {
	readonly message: FlashMessage | null;
	/** Signature of the app-state the live message was attached to. */
	readonly boundTo: string | null;
}

export const NO_FLASH: FlashState = { message: null, boundTo: null };

/**
 * The facet of the app-state a message is tied to. A message must SURVIVE the
 * cosmetic re-renders of the same logical state (the timer tick and upload
 * progress broadcasts) but CLEAR the instant that state actually moves on, so a
 * stale line can never linger and lie. Pause/Resume flips `paused` without
 * changing `kind`, so a recording distinguishes the two.
 */
export function flashBinding(state: ExtensionState): string {
	return state.kind === "recording"
		? `recording:${state.paused ? "paused" : "live"}`
		: state.kind;
}

/** Attach a message to the state it describes. */
export function attachFlash(
	state: ExtensionState,
	message: FlashMessage,
): FlashState {
	return { message, boundTo: flashBinding(state) };
}

/**
 * Given the current flash and an incoming state, keep the message while the state
 * it belongs to is unchanged and drop it once that state has transitioned. A
 * successful Pause/Resume (which flips `paused`) is such a transition, so the
 * failure message from the previous attempt clears itself.
 */
export function reconcileFlash(
	prev: FlashState,
	next: ExtensionState,
): FlashState {
	if (prev.message === null) return prev;
	return prev.boundTo === flashBinding(next) ? prev : NO_FLASH;
}
