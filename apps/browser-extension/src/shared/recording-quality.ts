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
 * The safety net for the TAB_AUDIO_GAIN lift: a limiter that sits between the
 * mixed audio and the MediaStream the MediaRecorder encodes.
 *
 * Why it exists: the mix sums the mic (already levelled by autoGainControl) with
 * the tab audio multiplied by TAB_AUDIO_GAIN. A remote speaker who is ALREADY
 * loud, or both people talking at once, pushes that sum past full scale — and a
 * Web Audio graph does not clip gracefully: the samples are hard-clipped on the
 * way into the recorder and the crackle is baked into the file forever. Lowering
 * the lift instead would undo the fix the lift exists for (quiet remote voices),
 * so the correct shape is to keep the lift and catch only the peaks.
 *
 * Settings, chosen for transparency rather than loudness:
 *  • threshold -3 dBFS — below this NOTHING is touched, so ordinary conversation
 *    passes through untouched; only material heading for 0 dBFS is caught.
 *  • knee 0 — a hard knee, i.e. a limiter, not a compressor. A soft knee starts
 *    squeezing well under the threshold and audibly flattens speech dynamics.
 *  • ratio 20:1 — the maximum DynamicsCompressor allows; anything above the
 *    threshold is effectively pinned there instead of clipping.
 *  • attack 3 ms — fast enough to catch a consonant transient, slow enough not
 *    to distort low frequencies the way a 0 ms attack does.
 *  • release 250 ms — long enough that the gain does not "pump" between
 *    syllables, short enough to recover before the next sentence.
 *
 * ONE factory, three call sites (recorder page, offscreen document, in-page
 * recorder): three hand-copied node setups would drift on the first tweak — the
 * same twin problem pickMimeType() below was created to end.
 *
 * Applies to the RECORDED mix only. The monitor path (what the user hears live
 * during the call) connects straight to `audioCtx.destination` in every path and
 * deliberately does not pass through here.
 */
export function createMixLimiter(
	audioCtx: AudioContext,
): DynamicsCompressorNode {
	const limiter = audioCtx.createDynamicsCompressor();
	limiter.threshold.value = -3;
	limiter.knee.value = 0;
	limiter.ratio.value = 20;
	limiter.attack.value = 0.003;
	limiter.release.value = 0.25;
	return limiter;
}

// ── Adaptive capture tier, decided from the upload backlog ─────────────────
//
// WHY THIS EXISTS (measured, not guessed). A throttled soak run at 800 kbit/s
// FAILED with upload-never-completed: the capture kept producing ~8 Mbit/s of
// video while the link could only carry ~0.8, so after a 6-minute recording only
// 8 of ~17 parts had reached the server and the user was left waiting after Stop.
// The same harness PASSED at 4 Mbit/s and unthrottled
// (e2e-audio-proof/soak-throttle-{A,B,C}.log). The link is not something we can
// fix; what the capture PRODUCES is. So when the backlog — bytes recorded but not
// yet uploaded — grows, we step the capture down; when the link catches up, we
// step it back up.
//
// This function is deliberately PURE: no chrome.*, no timers, no MediaRecorder.
// The caller measures the backlog and applies the returned tier; everything that
// decides WHEN to move lives here, where the thresholds are asserted by tests
// instead of eyeballed on a live recording.

export type CaptureTierName = "full" | "reduced" | "minimal";

export interface CaptureTier {
	readonly name: CaptureTierName;
	readonly maxWidth: number;
	readonly maxHeight: number;
	readonly frameRate: number;
	readonly videoBitsPerSecond: number;
	readonly audioBitsPerSecond: number;
}

/**
 * The tiers, BEST FIRST. Each step roughly thirds the produced bitrate, so two
 * steps take an 8 Mbit/s capture under the 800 kbit/s link that failed the soak.
 *
 * Audio is never reduced: voice is the part of a meeting recording that must
 * survive, and at 128 kbit/s it is a rounding error next to the video.
 *
 * The lower tiers clamp against VIDEO_BITS_PER_SECOND so a deploy that already
 * overrode the ceiling downwards can never "degrade" INTO a higher bitrate.
 */
export const CAPTURE_TIERS: readonly CaptureTier[] = [
	{
		name: "full",
		maxWidth: CAPTURE_MAX_WIDTH,
		maxHeight: CAPTURE_MAX_HEIGHT,
		frameRate: CAPTURE_MAX_FRAME_RATE,
		videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
		audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
	},
	{
		name: "reduced",
		maxWidth: 1280,
		maxHeight: 720,
		frameRate: 15,
		videoBitsPerSecond: Math.min(VIDEO_BITS_PER_SECOND, 2_500_000),
		audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
	},
	{
		name: "minimal",
		maxWidth: 854,
		maxHeight: 480,
		frameRate: 10,
		videoBitsPerSecond: Math.min(VIDEO_BITS_PER_SECOND, 800_000),
		audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
	},
];

/** The tier settings for a name; unknown names fall back to the best tier. */
export function captureTierFor(name: CaptureTierName | string): CaptureTier {
	return CAPTURE_TIERS.find((tier) => tier.name === name) ?? CAPTURE_TIERS[0];
}

// The backlog is measured in whole S3/R2 parts because that is the unit the
// uploader actually ships (background/upload.ts MIN_PART_SIZE = 5 MB). Kept as a
// literal rather than imported so this module stays free of background/ code.
const PART_BYTES = 5 * 1024 * 1024;

/**
 * HIGH-WATER MARK: above this the capture steps DOWN one tier.
 * Three parts of unshipped video ≈ the link is losing ground, not just jittering
 * behind a single in-flight part.
 */
export const BACKLOG_DEGRADE_ABOVE_BYTES = 3 * PART_BYTES;

/**
 * LOW-WATER MARK: below this the capture steps UP one tier.
 *
 * It is deliberately far below the high-water mark. With a single threshold, a
 * backlog hovering at the line would flip the tier every few seconds — and every
 * flip restarts the MediaRecorder, i.e. the "cure" would itself be a defect. The
 * gap between the two marks is the hysteresis: once degraded, the link must
 * genuinely drain (down to under one part outstanding) before we trust it again.
 */
export const BACKLOG_RESTORE_BELOW_BYTES = 1 * PART_BYTES;

/**
 * Decide the capture tier from the current tier and the current upload backlog.
 *
 * Pure. One step per call, so a backlog spike cannot jump straight to the floor
 * and a recovery cannot jump straight back to full — each move is re-justified by
 * the next measurement.
 *
 * @param current      the tier the capture is running at right now
 * @param backlogBytes bytes recorded but not yet uploaded (>= 0)
 */
export function chooseCaptureTier(
	current: CaptureTierName | string,
	backlogBytes: number,
): CaptureTierName {
	const currentIndex = Math.max(
		0,
		CAPTURE_TIERS.findIndex((tier) => tier.name === current),
	);
	const currentName = CAPTURE_TIERS[currentIndex].name;

	// No usable measurement is not evidence of trouble OR of recovery: hold.
	if (!Number.isFinite(backlogBytes)) return currentName;

	const backlog = Math.max(0, backlogBytes);

	if (backlog > BACKLOG_DEGRADE_ABOVE_BYTES) {
		const next = Math.min(currentIndex + 1, CAPTURE_TIERS.length - 1);
		return CAPTURE_TIERS[next].name;
	}
	if (backlog < BACKLOG_RESTORE_BELOW_BYTES) {
		const next = Math.max(currentIndex - 1, 0);
		return CAPTURE_TIERS[next].name;
	}
	// Inside the hysteresis band: whatever we are doing is keeping up well
	// enough — changing tier here is exactly the flapping this band prevents.
	return currentName;
}

// ── Telling the user, truthfully ───────────────────────────────────────────
//
// A quality drop the user is never told about looks like a bug ("why is my
// recording blurry?"). But the opposite failure is worse: a warning that fires
// on every little hiccup teaches people to ignore the one that matters. So the
// notice is derived from the SAME tier movement the hysteresis above governs —
// no separate trigger, no separate thresholds. A brief backlog that drains
// inside the band never changes the tier, so `captureTierChangeNotice` is never
// even reached with a different from/to, and the user hears nothing.
//
// TRUTHFULNESS RULE for this copy: the only thing measured is that the upload
// backlog grew, i.e. the link is shipping bytes SLOWER THAN THE RECORDING
// PRODUCES THEM. That is what the message says. It must not claim to know why
// (the user's wifi, their ISP, the server, a VPN — the signal cannot tell them
// apart), and it must not promise an outcome it cannot know ("your recording
// will upload in N minutes"). Reducing quality is stated as the action taken
// and its purpose, not as a guarantee.

/** A user-facing notification about a capture-tier move. */
export interface CaptureTierNotice {
	/** Stable id: a later notice REPLACES the previous one rather than stacking. */
	readonly id: string;
	readonly title: string;
	readonly message: string;
	/** True once the capture is back at the best tier — the caller clears any
	 * degraded badge/alert state on this. */
	readonly restored: boolean;
}

export const CAPTURE_TIER_NOTICE_ID = "capture-tier-changed";

/** "up to 720p" — derived from the tier table so the copy cannot drift from
 * what is actually applied. `maxHeight` is a ceiling, hence "up to". */
function tierLabel(tier: CaptureTier): string {
	return `up to ${tier.maxHeight}p at ${tier.frameRate} fps`;
}

/**
 * The message for a tier move, or `null` when there is nothing to say.
 *
 * Pure: no chrome.*, no state. The caller decides how to show it.
 *
 * @param from the tier the capture was running at
 * @param to   the tier it has just been moved to
 */
export function captureTierChangeNotice(
	from: CaptureTierName | string,
	to: CaptureTierName | string,
): CaptureTierNotice | null {
	const fromIndex = CAPTURE_TIERS.findIndex((tier) => tier.name === from);
	const toIndex = CAPTURE_TIERS.findIndex((tier) => tier.name === to);
	// Nothing moved (including the no-op the hysteresis band produces), or a
	// name we do not know: say nothing rather than invent an event.
	if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

	const toTier = CAPTURE_TIERS[toIndex];

	if (toIndex > fromIndex) {
		return {
			id: CAPTURE_TIER_NOTICE_ID,
			title: "Recording quality reduced",
			message:
				`The connection is slower than the recording, so video quality was reduced to ${tierLabel(toTier)} ` +
				"to let the recording finish uploading. Audio is unchanged, and quality goes back up if the connection catches up.",
			restored: false,
		};
	}

	if (toIndex === 0) {
		return {
			id: CAPTURE_TIER_NOTICE_ID,
			title: "Recording quality restored",
			message:
				"The connection caught up with the recording, so video quality is back to full " +
				`(${tierLabel(toTier)}).`,
			restored: true,
		};
	}

	return {
		id: CAPTURE_TIER_NOTICE_ID,
		title: "Recording quality partly restored",
		message:
			"The connection is keeping up better, so video quality was raised to " +
			`${tierLabel(toTier)}. It goes back to full if the connection keeps up.`,
		restored: false,
	};
}

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
