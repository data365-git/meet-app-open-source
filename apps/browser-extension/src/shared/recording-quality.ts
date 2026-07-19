// MediaRecorder bitrate targets, shared by both capture paths (the visible
// full-screen recorder page and the offscreen Meet-tab-only recorder) so a
// future quality change updates both instead of silently drifting one of them
// out of sync with the other (see CLAUDE.md's "twin" blast-radius rule).
export const VIDEO_BITS_PER_SECOND = 1_500_000;
export const AUDIO_BITS_PER_SECOND = 128_000;
