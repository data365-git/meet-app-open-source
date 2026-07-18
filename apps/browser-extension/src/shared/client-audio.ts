// ── Client-audio liveness: the ONE decision, shared by both meeting paths ────
//
// "Client audio" = the OTHER participants' voices, captured from the Meet tab
// via tabCapture. Both recording paths must refuse to start a meeting recording
// when it isn't actually flowing:
//   • recorder/recorder-page.ts  — the visible full-screen path (asks the user)
//   • offscreen/recorder.ts      — the "Record Meet tab only" path (refuses)
//
// The rule lives HERE rather than being written out at both call sites because
// the two copies already drifted once: one of them guarded merely on "is there
// an audio track at all", which PASSES for a tab the user has muted from
// Chrome's tab strip. Such a tab yields a track that exists but is `muted`, so
// the meeting recorded with no client audio — and because no `mute` transition
// ever fired, the mid-recording watchdog stayed silent too.
//
// Note we deliberately do NOT consult `track.enabled`: nothing in this codebase
// sets it, so testing it would only invent a failure mode we never produce.

export type TabAudioStatus = "live" | "missing" | "ended" | "muted";

/** Why this tab's audio can't be recorded, in the user's terms. Keyed by the
 * non-live statuses so a new status can't be added without giving it copy. */
export const TAB_AUDIO_PROBLEM: Record<Exclude<TabAudioStatus, "live">, string> =
	{
		missing: "the tab isn't exposing any audio",
		ended: "the tab's audio stopped",
		muted: "the tab is muted in Chrome (right-click the tab → Unmute site)",
	};

export function tabAudioStatus(
	track: MediaStreamTrack | null | undefined,
): TabAudioStatus {
	if (!track) return "missing";
	// `readyState` only proves the media object is still open, and `muted` only
	// proves the SOURCE is not delivering — neither alone is sufficient, which is
	// exactly the gap the tab-strip-muted case fell through.
	if (track.readyState !== "live") return "ended";
	if (track.muted) return "muted";
	return "live";
}

/** True only when the track exists, is still live, AND is not muted. */
export function isTabAudioLive(
	track: MediaStreamTrack | null | undefined,
): boolean {
	return tabAudioStatus(track) === "live";
}
