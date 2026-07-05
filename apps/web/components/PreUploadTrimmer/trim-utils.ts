// Small tolerance (seconds) for treating a selection as "the whole video":
// the in/out handles are set from the <video> duration, which can differ from
// the true end by a few milliseconds, so an exact equality check would miss a
// genuinely-untrimmed selection.
const TRIM_EPSILON_SEC = 0.05;

/** Did the user leave the selection at the FULL video (i.e. not actually trim)? */
export function isFullSelection(
	inSec: number,
	outSec: number,
	duration: number,
): boolean {
	if (!(duration > 0)) return false;
	return inSec <= TRIM_EPSILON_SEC && outSec >= duration - TRIM_EPSILON_SEC;
}

/** Is the source already an MP4 (safe to upload as-is under a .mp4 key)? */
export function isMp4Source(fileType: string, fileName: string): boolean {
	return fileType === "video/mp4" || /\.mp4$/i.test(fileName);
}

/**
 * When the user hasn't narrowed the range AND the source is already MP4, skip
 * the in-browser ffmpeg pass and upload the file as-is. ffmpeg-wasm loads the
 * ENTIRE file into wasm memory, so on a large file (or a memory-constrained
 * mobile browser) the untrimmed pass is slow and can crash the tab — leaving a
 * created video row with no bytes ever reaching storage. Uploading the original
 * directly restores the fast "pick → upload" path for the common no-trim case.
 */
export function shouldUploadOriginal(args: {
	inSec: number;
	outSec: number;
	duration: number;
	fileType: string;
	fileName: string;
}): boolean {
	return (
		isFullSelection(args.inSec, args.outSec, args.duration) &&
		isMp4Source(args.fileType, args.fileName)
	);
}
