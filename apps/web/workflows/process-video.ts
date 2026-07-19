import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";
import { optimizeRemoteVideoToMp4, probeRemoteVideo } from "@/lib/video-convert";
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
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
