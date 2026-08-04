// Capture quality, shared by both paths (the visible full-screen recorder page
// and the offscreen Meet-tab-only recorder) so a future change updates both
// instead of silently drifting one out of sync (see CLAUDE.md's "twin" rule).
//
// Owner feedback on the first successful real meeting recording, 2026-07-19:
// "video sifati ham past". The cause was NOT only the bitrate — the capture was
// also being downscaled to 720p, which is what makes slide text and code look
// mushy on a 1080p screen. Both were raised together; raising bitrate alone
// would have spent bytes on a blurry source.
export const CAPTURE_MAX_WIDTH = 1920;
export const CAPTURE_MAX_HEIGHT = 1080;
export const CAPTURE_MAX_FRAME_RATE = 24; // screen content: sharpness > motion

// Build/runtime env, read through the same shape as shared/config.ts: a plain
// `process` does not exist inside an extension page, so this stays optional and
// silently falls back when nothing was injected at build time.
const extensionEnv = (
	globalThis as {
		process?: {
			env?: Record<string, string | undefined>;
		};
	}
).process?.env;

/** Positive-integer env override, ignoring blank/garbage/non-positive values. */
function envBitsPerSecond(key: string, fallback: number): number {
	const raw = extensionEnv?.[key]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return parsed;
}

// 8 Mbit/s at 1080p24. The capture bitrate is the CEILING of the whole pipeline:
// no server-side setting can recover detail the encoder never wrote, and screen
// text/code at 1080p is exactly the content that starves at a lower rate (the
// previous value was a third of this and left slide text mushy).
// Cost: ~60 MB/min raw, which is what the server-side re-encode pass in the
// finalize pipeline exists to bring back down (~3 MB/min at CRF 21).
// Override for a constrained deploy with EXTENSION_VIDEO_BITS_PER_SECOND.
const VIDEO_BITRATE_ENV_KEY = "EXTENSION_VIDEO_BITS_PER_SECOND";
const DEFAULT_VIDEO_BITS_PER_SECOND = 8_000_000;
export const VIDEO_BITS_PER_SECOND = envBitsPerSecond(
	VIDEO_BITRATE_ENV_KEY,
	DEFAULT_VIDEO_BITS_PER_SECOND,
);
export const AUDIO_BITS_PER_SECOND = 128_000;

// ── Microphone capture constraints ─────────────────────────────────────────
//
// The three recorder paths used to ask for the mic with a bare `{ audio: true }`
// (or a deviceId and nothing else). That leaves every processing decision to the
// browser default, which on Chrome varies by device and by how the stream is
// obtained — so the owner's own voice arrived with room echo and hiss on some
// runs and clean on others. Zoom-grade local audio is not a codec choice, it is
// these three DSP flags being ON deliberately.
//
//  • echoCancellation  — kills the loop where the remote voice comes out of the
//    speakers and back into the mic (the "hearing yourself twice" artefact).
//  • noiseSuppression  — removes fan/keyboard/room hiss under the voice.
//  • autoGainControl   — levels a quiet or far-away speaker up to a usable
//    loudness so the mic leg matches the tab leg.
//  • sampleRate 48000  — matches the AudioContext the mix is built in, so the
//    mic is never resampled 44.1k→48k inside the graph.
//  • channelCount 1    — a mic is mono anyway; asking for 2 duplicates the same
//    signal and only costs bitrate.
//
// These are REQUESTS, not guarantees: getUserMedia silently ignores what a
// device cannot do rather than failing, which is why they are plain values and
// not `exact` — an `exact` sampleRate would make the whole call throw on
// hardware locked to 44.1 kHz and lose the mic entirely.
export const MIC_AUDIO_CONSTRAINTS = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	sampleRate: 48000,
	channelCount: 1,
} as const satisfies MediaTrackConstraints;

/**
 * Mic constraints for getUserMedia, optionally pinned to a chosen input device.
 *
 * Every recorder path goes through here so the fallback request (the one used
 * when the chosen device is gone) keeps the SAME processing flags as the pinned
 * one — the old code fell back to a bare `{ audio: true }`, which quietly
 * downgraded the audio exactly when something had already gone wrong.
 */
export function micAudioConstraints(
	deviceId?: string | null,
): MediaTrackConstraints {
	return deviceId
		? { ...MIC_AUDIO_CONSTRAINTS, deviceId: { exact: deviceId } }
		: { ...MIC_AUDIO_CONSTRAINTS };
}

// ── Tab / display (system) audio capture constraints ───────────────────────
//
// This is the LOAD-BEARING guarantee for the other participant's voice.
//
// The mic flags above are deliberately ON; on a tab or display stream the SAME
// three flags must be deliberately OFF, and the difference is not cosmetic:
//
//  • echoCancellation on a tab stream is actively destructive. The AEC treats
//    the local speaker output as "far end" — and the remote participant's voice
//    IS the local speaker output — so it gates/ducks exactly the person we are
//    recording, as if they were echo. Users hear the other side chopped or
//    missing while their own mic is fine.
//  • noiseSuppression is tuned for a single near voice over a mic; on already-
//    encoded conference audio it eats music, screen-shared video sound, and the
//    quieter of two overlapping speakers.
//  • autoGainControl fights the deliberate TAB_AUDIO_GAIN boost below — it
//    pumps the level back down between phrases, which is what "breathing"
//    meeting audio sounds like.
//
// A tab stream is a clean digital copy; there is nothing to clean up. Chrome's
// default for a tabCapture source is usually already off, but "usually" is not
// a guarantee: it has varied by Chrome version and by how the stream is
// obtained (getDisplayMedia audio in particular goes through the normal
// audio-processing path). Stating all three explicitly removes the variance.
export const TAB_AUDIO_CONSTRAINTS = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
} as const satisfies MediaTrackConstraints;

/**
 * Audio constraints for consuming a `chrome.tabCapture` streamId through
 * getUserMedia (the recorder page's meeting leg and the offscreen document).
 *
 * Chrome parses a constraints object containing `mandatory` with its LEGACY
 * parser, which ignores sibling modern keys — so spreading TAB_AUDIO_CONSTRAINTS
 * next to `mandatory` would silently do nothing. The flags therefore go INSIDE
 * `mandatory`, in both the modern and the goog-prefixed spelling that the legacy
 * parser actually reads, and are derived from TAB_AUDIO_CONSTRAINTS so the one
 * declaration above stays the single source of truth.
 */
export function tabAudioConstraints(streamId: string): MediaTrackConstraints {
	return {
		mandatory: {
			chromeMediaSource: "tab",
			chromeMediaSourceId: streamId,
			echoCancellation: TAB_AUDIO_CONSTRAINTS.echoCancellation,
			noiseSuppression: TAB_AUDIO_CONSTRAINTS.noiseSuppression,
			autoGainControl: TAB_AUDIO_CONSTRAINTS.autoGainControl,
			googEchoCancellation: TAB_AUDIO_CONSTRAINTS.echoCancellation,
			googNoiseSuppression: TAB_AUDIO_CONSTRAINTS.noiseSuppression,
			googAutoGainControl: TAB_AUDIO_CONSTRAINTS.autoGainControl,
		},
	} as unknown as MediaTrackConstraints;
}

// The remote participants arrive quieter than the local mic. Applied to the
// RECORDED copy of the tab audio only — never to the monitor path, so what the
// user hears during the call is unchanged.
export const TAB_AUDIO_GAIN = 1.8;

/**
 * The container/codec the MediaRecorder should use, most preferred first.
 *
 * ONE home for what used to be three verbatim copies (recorder page, offscreen
 * document, in-page recorder). Their lists were identical only by luck; the
 * repo's twin rule says the next edit is where they drift.
 */
export function pickMimeType(): string {
	const candidates = [
		"video/mp4;codecs=h264",
		"video/mp4",
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
	];
	for (const mime of candidates) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return "video/webm";
}
