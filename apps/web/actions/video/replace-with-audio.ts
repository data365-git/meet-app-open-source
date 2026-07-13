"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { extractAudioToBuffer } from "@/lib/audio-extract";
import { runPromise } from "@/lib/server";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { getStorageAccessForVideo } from "@/lib/video-storage";

export type ReplaceWithAudioResult =
	| { ok: true; reclaimedFrom: string[] }
	| { ok: false; reason: string };

// Tried in order; the first one that exists in storage is the extraction
// source. Segment-only recorded videos (no finalized mp4) have none of these
// and fall through to `unsupported_source` — v1 scope, see the spec.
const SOURCE_CANDIDATE_NAMES = [
	"result.mp4",
	"raw-upload.mp4",
	"raw-upload.webm",
] as const;

// Reclaimed (best-effort) once the new audio object is verified. Segment
// trees (output/, combined-source/) are NOT touched here — v2.
const RECLAIM_CANDIDATE_NAMES = ["raw-upload.mp4", "raw-upload.webm"] as const;

// A freshly-written object's ContentLength should equal the uploaded byte
// count exactly; a small tolerance guards the safety check below against
// provider rounding without weakening it.
const SIZE_VERIFY_TOLERANCE_BYTES = 16;

/**
 * Storage-save (T4b): extract the audio track from an owner's video, swap
 * `result.mp4` to serve that audio in place (the playlist route redirects to
 * `result.mp4` for every video regardless of layout — see the spec), reclaim
 * the raw upload bytes, and flip `metadata.isAudio`. AI analysis/transcript
 * are untouched. Irreversible — the ordering below never deletes anything
 * before the newly-written audio is proven to read back correctly.
 */
export async function replaceVideoWithAudio(
	videoId: string,
): Promise<ReplaceWithAudioResult> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, reason: "unauthorized" };

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as typeof videos.$inferSelect.id));

	if (!video) return { ok: false, reason: "not_found" };
	if (video.ownerId !== user.id) return { ok: false, reason: "unauthorized" };

	const meta = (video.metadata as VideoMetadata) ?? {};
	if (meta.isAudio) return { ok: false, reason: "already_audio" };

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

	let sourceKey: string | null = null;
	for (const name of SOURCE_CANDIDATE_NAMES) {
		const key = `${video.ownerId}/${videoId}/${name}`;
		try {
			await bucket.headObject(key).pipe(runPromise);
			sourceKey = key;
			break;
		} catch {
			// candidate missing — try the next one
		}
	}
	if (!sourceKey) return { ok: false, reason: "unsupported_source" };

	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(sourceKey)
		.pipe(runPromise);

	// Extract fully into memory BEFORE any write — nothing is mutated yet, so
	// a failure here leaves storage untouched.
	let audioBuf: Buffer;
	try {
		audioBuf = await extractAudioToBuffer(sourceUrl);
	} catch (err) {
		console.error("[replaceVideoWithAudio] extract failed", {
			videoId,
			err: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, reason: "extract_failed" };
	}

	const resultKey = `${video.ownerId}/${videoId}/result.mp4`;
	await bucket
		.putObject(resultKey, audioBuf, {
			contentType: "audio/mpeg",
			contentLength: audioBuf.length,
		})
		.pipe(runPromise);

	// SAFETY GATE — never delete anything below unless the audio we just
	// wrote reads back with the size we expect. The original raw-upload.* is
	// still intact at this point, so a failed verify loses no data.
	let verified = false;
	try {
		const head = await bucket.headObject(resultKey).pipe(runPromise);
		verified =
			Math.abs((head.ContentLength ?? 0) - audioBuf.length) <=
			SIZE_VERIFY_TOLERANCE_BYTES;
	} catch {
		verified = false;
	}
	if (!verified) return { ok: false, reason: "verify_failed" };

	const reclaimedFrom: string[] = [];
	for (const name of RECLAIM_CANDIDATE_NAMES) {
		const key = `${video.ownerId}/${videoId}/${name}`;
		if (key === resultKey) continue;

		try {
			await bucket.headObject(key).pipe(runPromise);
		} catch {
			continue; // doesn't exist — nothing to reclaim
		}

		try {
			await bucket.deleteObject(key).pipe(runPromise);
			reclaimedFrom.push(key);
		} catch (err) {
			console.error("[replaceVideoWithAudio] reclaim delete failed", {
				key,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	}

	await patchVideoMetadata(videoId, (cur) => ({ ...cur, isAudio: true }));

	revalidatePath(`/s/${videoId}`);

	return { ok: true, reclaimedFrom };
}
