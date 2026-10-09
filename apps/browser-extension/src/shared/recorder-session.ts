// (F2) One identity per RECORDING SESSION, shared by all three recorder paths
// (in-page content script, offscreen document, recorder page).
//
// WHY THIS EXISTS. RECORDER_CHUNK / RECORDER_STOPPED / RECORDER_ERROR used to
// carry no recording identity at all — only a per-recorder `index` that restarts
// at 0 — so the service worker appended whatever arrived to whatever upload was
// live. A MediaRecorder still running from an EARLIER session therefore wrote its
// fragments straight into the next recording: the owner's 2026-07-23 recording
// came back as TWO fMP4 streams interleaved in one result.mp4 (sequences 19..31
// woven with 1..13, the single ftyp+moov sitting 532 KB in), which no browser can
// parse. Full evidence: docs/HANDOFF_2026-07-23_broken-recording.md.
//
// Every sender mints one of these at start, sends it with RECORDER_STARTED, and
// echoes it on every later message. The SW stores it on the recording and drops
// anything that does not match — including UNSTAMPED messages, deliberately (see
// isForeignRecorderSession in background/upload.ts for why strictness is safer).
//
// It lives in ONE place on purpose: three copy-pasted id generators would be the
// same twin-divergence trap that produced the meeting-id regex bug.

/** A fresh recorder-session id. `crypto.randomUUID` is available in all three
 * recorder contexts (content script, offscreen document, extension page) on the
 * Chrome versions this extension supports; the fallback keeps a hostile or
 * unusually old context from throwing at the moment a recording starts, which
 * would be a far worse failure than a slightly weaker id. */
export function newSessionId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `rs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
