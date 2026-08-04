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
