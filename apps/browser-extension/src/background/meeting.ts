// One place that decides whether a recording is filed as a MEETING on the
// server, and the auto-open that meeting completions perform.
//
// The server files a recording in Meetings when the extension sends
// extensionContext: "meeting". The only producer of that value is the
// initializeUpload call in sw.ts (RECORDER_STARTED): mode "meeting" (the
// in-page Meet nudge flow) OR meetingRequired === true (the guaranteed
// full-screen "record meeting" popup button, which keeps mode "instruction"
// throughout but must still file as a meeting). Putting the rule in ONE
// exported helper and reusing it at that call site — and everywhere the fact
// is carried forward — means the filing rule and the auto-open rule can never
// drift apart.

export function isMeetingFiling(
	mode: "instruction" | "meeting",
	meetingRequired: boolean | undefined,
): boolean {
	return meetingRequired === true || mode === "meeting";
}

// The last videoId whose auto-open fired (or was suppressed by a pending
// discard). One slot — the last id, not a set. Within one service-worker
// lifetime a duplicate open is not possible anyway: every completion path
// runs inside the serialized enqueueRecorder chain / drain loop, and the
// drain's stillOurs guard means a videoId reaches a "complete" setter only
// once. The marker's real jobs are (a) restart safety — a respawned SW
// draining an old durable "complete" record does not re-open a video whose
// tab a previous SW lifetime already opened — and (b) discard suppression
// (suppressAutoOpen below): the marker written by a pending discard vetoes
// the open for that same videoId.
const LAST_AUTO_OPENED_KEY = "capExtLastAutoOpenedVideoId";

/**
 * Open the video's page (<apiBaseUrl>/s/<videoId>) in a new ACTIVE tab when a
 * MEETING upload finishes, at most once per videoId.
 *
 * Instruction recordings (isMeeting falsy — including a persisted 0.5.9 state
 * that predates the flag, treated as false) never open anything. Every failure
 * path is swallowed: a failure to open a tab (or to read/write the marker)
 * must never change the upload outcome or state — the caller has usually just
 * set kind:"complete" and that must stand.
 */
export async function maybeAutoOpenMeetingVideo(
	videoId: string,
	shareUrl: string,
	isMeeting: boolean | undefined,
): Promise<void> {
	if (!isMeeting) return;

	try {
		const stored = await chrome.storage.local.get(LAST_AUTO_OPENED_KEY);
		if (stored[LAST_AUTO_OPENED_KEY] === videoId) return;

		// Persist BEFORE opening: the marker is what a pending discard
		// (suppressAutoOpen) and a respawned SW check, and it must exist even
		// if this SW dies right after the tab opens. The cost of persisting
		// first is that a tabs.create that throws is never retried —
		// acceptable: a lost pop-up must not degrade the upload (which is
		// guaranteed by the try/catch below).
		await chrome.storage.local.set({ [LAST_AUTO_OPENED_KEY]: videoId });

		await chrome.tabs.create({ url: shareUrl, active: true });
	} catch (err) {
		console.warn(
			`[meeting] could not auto-open the video page for ${videoId}:`,
			err,
		);
	}
}

/**
 * Veto the auto-open for a video the user is discarding. DISCARD_UPLOAD can
 * be answered while a serialized finalize/drain for the same videoId is
 * still running and may set "complete" — and try to open the page — before
 * the discard's own turn arrives (enqueueRecorder puts the discard behind
 * that work). Writing the marker here makes that later
 * maybeAutoOpenMeetingVideo a no-op: no tab for a recording the user chose
 * to destroy. Best-effort by design: errors are swallowed, this must never
 * block or fail the discard itself.
 */
export async function suppressAutoOpen(videoId: string): Promise<void> {
	try {
		await chrome.storage.local.set({ [LAST_AUTO_OPENED_KEY]: videoId });
	} catch (err) {
		console.warn(
			`[meeting] could not suppress auto-open for ${videoId}:`,
			err,
		);
	}
}
