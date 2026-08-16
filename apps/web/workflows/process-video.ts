import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import { hasPendingUploadStartOrder } from "@/lib/ai-generation-request";
import { persistableProcessingError } from "@/lib/processing-error";
import { runPromise } from "@/lib/server";
import { optimizeRemoteVideoToMp4, probeRemoteVideo } from "@/lib/video-convert";
import { transcribeVideo } from "@/lib/transcribe";
import { getStorageAccessForVideo } from "@/lib/video-storage";

interface ProcessVideoWorkflowPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, rawFileKey } = payload;

	try {
		await optimizeAndFinalizeVideo(videoId, rawFileKey);

		await db()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		// The upload row is gone, so transcribeVideo's in-progress guard passes
		// from here on. Honour an "AI tahlil" press that arrived while this
		// workflow was still running.
		await startPendingAiRequest(videoId);

		return {
			success: true,
			message: "Video processing complete",
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(videoId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

/**
 * Downloads the just-uploaded raw file, remuxes/re-encodes it into a
 * browser-safe faststart MP4 (lib/video-convert.ts's copy-vs-compress
 * decision — a VP9/Opus input, e.g. from Safari/iOS, always selects
 * "compress", which is also what fixes iPhone playback for meeting
 * recordings), and overwrites `result.mp4`. That key is the one every reader
 * already treats as the canonical processed file: /api/playlist's "mp4"
 * resolution HEAD-checks `result.mp4` FIRST and only falls back to the raw
 * upload when it is missing, and workflows/transcribe.ts's
 * resolveVideoSourceUrl probes it first too — so writing here is exactly what
 * makes a webMP4/extensionWeb recording (which never had a result.mp4 before
 * this workflow ran) start being served as the optimized file, with no other
 * code needing to change.
 *
 * `rawFileKey` is trusted directly as the source (not re-derived from a
 * candidate-key guess): every caller of startVideoProcessingWorkflow already
 * resolved and verified it before starting this workflow — the multipart
 * complete route heads the just-assembled object, and
 * actions/video/trigger-processing.ts calls verifyRawFileUploaded first.
 *
 * Never throws on an optimization failure: the raw upload stays intact and
 * still plays via /api/playlist's existing raw-upload fallback, so a broken
 * ffmpeg run must never brick an otherwise-fine recording. Only a failure to
 * even load the video row is fatal (the caller's try/catch handles that as a
 * real processing error).
 */
async function optimizeAndFinalizeVideo(
	videoId: string,
	rawFileKey: string,
): Promise<void> {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video) {
		throw new FatalError("Video does not exist");
	}

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const videoUrl = await bucket
		.getInternalSignedObjectUrl(rawFileKey)
		.pipe(runPromise);

	let durationSec: number | null = null;

	try {
		const result = await optimizeRemoteVideoToMp4(videoUrl);
		try {
			durationSec = result.metadata?.durationSec ?? null;
			const buffer = await fs.readFile(result.filePath);
			await bucket
				.putObject(`${video.ownerId}/${videoId}/result.mp4`, buffer, {
					contentType: "video/mp4",
				})
				.pipe(runPromise);
			console.log(
				`[process-video] Optimized video for ${videoId}: ${buffer.length} bytes, duration=${durationSec}`,
			);
		} finally {
			await result.cleanup();
		}
	} catch (error) {
		console.error(
			`[process-video] Optimization failed for ${videoId}, keeping the original raw upload playable:`,
			error,
		);
		// Best-effort: even though the encode failed, try to at least learn the
		// duration so the player's seek bar isn't left stuck blank forever.
		try {
			const probe = await probeRemoteVideo(videoUrl);
			durationSec = probe.durationSec;
		} catch (probeError) {
			console.error(
				`[process-video] Fallback duration probe also failed for ${videoId}:`,
				probeError,
			);
		}
	}

	// Only ever write a real, positive duration — never overwrite an existing
	// value with null/0 just because this run couldn't determine one.
	if (durationSec != null && durationSec > 0) {
		await db()
			.update(videos)
			.set({ duration: durationSec })
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}

/**
 * A user can press "AI tahlil" while this workflow is still optimizing the
 * file. The generate route cannot start the pipeline in that window
 * (transcribeVideo refuses an upload that is still in progress), so it records
 * `metadata.aiStartPendingUpload` instead and this step is what redeems it —
 * without it the request is lost silently and the video sits at
 * transcriptionStatus NULL forever (owner incident, 2026-08-16).
 *
 * The marker is a ONE-SHOT order and is removed the moment it is redeemed —
 * but only once the start was not refused for bytes still landing, otherwise
 * this step would consume the request and drop it, which is the very incident
 * above. Removing it after the start cannot cause a duplicate: the claim
 * inside transcribeVideo is a compare-and-swap, so the other redeemer (the
 * recover-stale-ai-jobs cron) loses the claim and launches nothing.
 *
 * Only ever starts for a video whose transcription has NOT started yet: a
 * non-NULL status means some other path (the generate route's own successful
 * kick, a cron re-kick, a completed run) already owns the job, and
 * transcribeVideo's own guards would refuse it anyway.
 *
 * Never throws: a failure here must not turn a perfectly processed recording
 * into a processing ERROR — the recover-stale-ai-jobs cron re-attempts the same
 * pending request every 30 minutes.
 */
async function startPendingAiRequest(videoId: string): Promise<void> {
	"use step";

	try {
		const [video] = await db()
			.select({
				ownerId: videos.ownerId,
				transcriptionStatus: videos.transcriptionStatus,
				metadata: videos.metadata,
			})
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.limit(1);

		if (!video || video.transcriptionStatus !== null) return;
		if (!hasPendingUploadStartOrder((video.metadata as VideoMetadata) ?? {}))
			return;

		console.log(
			`[process-video] Starting AI requested during upload for ${videoId}`,
		);
		const result = await transcribeVideo(
			videoId as Video.VideoId,
			video.ownerId,
			true,
			false,
		);

		// Redeem the one-shot order ONLY when the start actually took. A refusal
		// that launched nothing must LEAVE the marker so the other redeemer (or
		// the 30-minute cron) can try again — `code === "UPLOAD_IN_PROGRESS"` is
		// only ONE of several such refusals: no usable key, "AI budget exceeded"
		// and a failed workflow launch all return with the row still at NULL and
		// carry no code. Consuming the order on those turned a transient budget
		// or key blip into permanent silent loss of the user's press, which is
		// the 2026-08-16 incident all over again (round-21 #2).
		// Removing AFTER a successful start is safe against a duplicate: the
		// claim inside transcribeVideo is a compare-and-swap, so a second
		// redeemer that also sees the marker loses the claim and launches
		// nothing.
		if (!result.success || result.code === "UPLOAD_IN_PROGRESS") return;

		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_REMOVE(
					COALESCE(${videos.metadata}, JSON_OBJECT()),
					'$.aiStartPendingUpload'
				)`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[process-video] Failed to start the pending AI request for ${videoId}:`,
			error,
		);
	}
}

async function setProcessingError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Video processing failed",
			// Allowlist token only — the raw message can carry a presigned
			// URL and this field reaches every share-page viewer (round-18).
			processingError: persistableProcessingError(errorMessage),
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
