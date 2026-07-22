import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videoUploads, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import { runPromise } from "@/lib/server";
import { sendOpsAlert } from "@/lib/ops-alert";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

const CHECK_OLDER_THAN_MS = 2 * 60 * 60 * 1000;
const STALE_UPLOAD_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEOS_PER_RUN = 200;

const NON_TERMINAL_UPLOAD_PHASES = [
	"uploading",
	"processing",
	"generating_thumbnail",
] as const;

type ReconcileCandidate = typeof videos.$inferSelect;

// The playback path (/api/playlist) treats a video as present if ANY of its media
// objects exist — the recorded raw upload, the optimized result, or the raw fallbacks
// by convention. reconcile MUST check the SAME set, or it false-flags "storageMissing"
// on a recording whose ffmpeg optimize step failed (result.mp4 never written) even
// though the raw upload plays fine — and, once flagged, it was never re-checked, so the
// share page showed "recording unavailable" on a perfectly playable video. (2026-07-22.)
async function anyObjectExists(video: ReconcileCandidate): Promise<boolean> {
	const [uploadRow] = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, video.id))
		.limit(1);

	const candidateKeys = [
		...(uploadRow?.rawFileKey ? [uploadRow.rawFileKey] : []),
		`${video.ownerId}/${video.id}/result.mp4`,
		`${video.ownerId}/${video.id}/raw-upload.mp4`,
		`${video.ownerId}/${video.id}/raw-upload.webm`,
	];

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	for (const key of candidateKeys) {
		const exists = await bucket.headObject(key).pipe(
			Effect.as(true),
			Effect.catchAll(() => Effect.succeed(false)),
			runPromise,
		);
		if (exists) return true;
	}
	return false;
}

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const olderThan = new Date(Date.now() - CHECK_OLDER_THAN_MS);

	// We intentionally do NOT exclude already-flagged videos: they are re-checked every
	// run so a stale false-positive (see anyObjectExists) self-heals — the flag is
	// cleared below the moment the media turns out to be present.
	const candidates = await db()
		.select()
		.from(videos)
		.where(and(isNull(videos.deletedAt), lt(videos.createdAt, olderThan)))
		.orderBy(desc(videos.createdAt))
		.limit(MAX_VIDEOS_PER_RUN);

	let checked = 0;
	let missing = 0;
	let cleared = 0;
	const missingVideoIds: string[] = [];

	for (const video of candidates) {
		checked++;
		try {
			const exists = await anyObjectExists(video);
			const metadata = (video.metadata as VideoMetadata) ?? {};
			const wasFlagged = metadata.storageMissing === true;
			if (!exists && !wasFlagged) {
				missing++;
				missingVideoIds.push(video.id);
				await db()
					.update(videos)
					.set({ metadata: { ...metadata, storageMissing: true } })
					.where(eq(videos.id, video.id));
			} else if (exists && wasFlagged) {
				// Previously mis-flagged but the media is in fact present — clear the
				// stale flag so the share page stops showing a false "unavailable".
				cleared++;
				const { storageMissing: _drop, ...rest } = metadata;
				await db()
					.update(videos)
					.set({ metadata: rest })
					.where(eq(videos.id, video.id));
			}
		} catch (error) {
			console.error(
				`[reconcile-storage] Failed to check video ${video.id}:`,
				error,
			);
		}
	}

	const staleUploadBefore = new Date(Date.now() - STALE_UPLOAD_THRESHOLD_MS);
	const staleUploadCandidates = await db()
		.select({ videoId: videoUploads.videoId })
		.from(videoUploads)
		.where(
			and(
				inArray(videoUploads.phase, [...NON_TERMINAL_UPLOAD_PHASES]),
				lt(videoUploads.updatedAt, staleUploadBefore),
			),
		);

	const staleUploads = staleUploadCandidates.length;
	if (staleUploads > 0) {
		await db()
			.update(videoUploads)
			.set({ phase: "error" })
			.where(
				inArray(
					videoUploads.videoId,
					staleUploadCandidates.map((row) => row.videoId),
				),
			);
	}

	if (missing > 0) {
		await sendOpsAlert(
			`Storage reconcile: ${missing} video(s) missing S3 object: ${missingVideoIds.join(", ")}`,
		);
	}

	return NextResponse.json({ checked, missing, cleared, staleUploads });
}
