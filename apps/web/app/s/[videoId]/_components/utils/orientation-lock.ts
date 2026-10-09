/**
 * Screen-orientation helpers for the mobile fullscreen video experience.
 *
 * `screen.orientation.lock()` returns a promise that rejects when the browser
 * refuses the request (not in fullscreen, unsupported, user setting, etc.).
 * We swallow those rejections — a failed lock is never fatal to playback.
 *
 * Platform note: iOS Safari does NOT implement `screen.orientation.lock()`, so
 * these are no-ops there. Its native fullscreen still auto-rotates when the user
 * turns the device (same as YouTube on iOS), which the owner accepts and will
 * confirm via device testing.
 */

type LockableOrientation = ScreenOrientation & {
	lock?: (orientation: "landscape") => Promise<void>;
	unlock?: () => void;
};

function getOrientation(): LockableOrientation | undefined {
	if (typeof screen === "undefined") return undefined;
	return screen.orientation as LockableOrientation | undefined;
}

/** Best-effort request to lock the screen to landscape. No-op if unsupported. */
export function lockLandscape(): void {
	const orientation = getOrientation();
	if (typeof orientation?.lock !== "function") return;
	try {
		orientation.lock("landscape").catch(() => {});
	} catch {
		// Some engines throw synchronously instead of rejecting — ignore.
	}
}

/** Best-effort release of any orientation lock. No-op if unsupported. */
export function unlockOrientation(): void {
	const orientation = getOrientation();
	if (typeof orientation?.unlock !== "function") return;
	try {
		orientation.unlock();
	} catch {
		// Ignore — releasing a lock is never critical.
	}
}
