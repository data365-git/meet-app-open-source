"use server";

import { replaceVideoWithAudio } from "./replace-with-audio";

export type BulkReplaceWithAudioResult = {
	/** Ids that are now audio-only. Their video is gone, permanently. */
	replaced: string[];
	/** Ids that were left exactly as they were, with the reason each one failed. */
	failed: { id: string; reason: string }[];
	/** Ids that were already audio — not an error, nothing was done to them. */
	skipped: string[];
};

/**
 * Replace the video of SEVERAL recordings with their audio, in one action.
 *
 * This DESTROYS each video permanently — that is the feature, and the owner
 * chose it over a recoverable trash (2026-08-05) because the whole point is to
 * reclaim the disk immediately. The confirmation in front of it is therefore
 * the only thing between a selection and permanent loss, and it is required to
 * state the exact count and list the titles.
 *
 * TWO DELIBERATE PROPERTIES, both of which exist because this is irreversible:
 *
 * 1. It calls the SINGLE-VIDEO action once per id rather than reimplementing
 *    the work in a bulk-shaped copy. That action writes the new audio, proves it
 *    reads back at the expected size, and only then deletes anything — the gate
 *    that made the 2026-08-03 total failure of this feature destroy nothing. A
 *    bulk twin would be a second place for that gate to rot.
 *
 * 2. It runs SEQUENTIALLY, and one failure never stops the others. Each video
 *    is decoded fully into memory by ffmpeg; ten in parallel is ten videos of
 *    RAM at once on a small VPS. Slower is the right trade for an operation the
 *    user runs once on a batch of old recordings.
 */
export async function replaceVideosWithAudio(
	videoIds: string[],
): Promise<BulkReplaceWithAudioResult> {
	const replaced: string[] = [];
	const failed: { id: string; reason: string }[] = [];
	const skipped: string[] = [];

	for (const videoId of videoIds) {
		try {
			const result = await replaceVideoWithAudio(videoId);
			if (result.ok) {
				replaced.push(videoId);
			} else if (result.reason === "already_audio") {
				skipped.push(videoId);
			} else {
				failed.push({ id: videoId, reason: result.reason });
			}
		} catch (err) {
			// An unexpected throw must not abort the rest of the batch: the videos
			// after this one are untouched and still deserve their turn.
			console.error("[replaceVideosWithAudio] item threw", {
				videoId,
				err: err instanceof Error ? err.message : String(err),
			});
			failed.push({ id: videoId, reason: "unexpected_error" });
		}
	}

	return { replaced, failed, skipped };
}
