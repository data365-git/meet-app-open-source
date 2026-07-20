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

// ~3 Mbps at 1080p24 for screen content (mostly static, compresses well).
// Cost of the raise: a 42-min meeting goes from roughly 500 MB to ~1 GB, which
// is why the server-side compress pass in the finalize pipeline matters.
export const VIDEO_BITS_PER_SECOND = 3_000_000;
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
