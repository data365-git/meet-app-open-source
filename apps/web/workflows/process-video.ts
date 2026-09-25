import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { FatalError } from "workflow";
import {
	bankedStartRequestsFullAnalysis,
	hasPendingUploadStartOrder,
} from "@/lib/ai-generation-request";
import { persistableProcessingError } from "@/lib/processing-error";
import { runPromise } from "@/lib/server";
import { optimizeRemoteVideoToMp4, probeRemoteVideo } from "@/lib/video-convert";
import { transcribeVideo } from "@/lib/transcribe";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import { assertVideoNotDeleted } from "@/lib/video-alive";

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
		// Delete the upload row and honour a pending "AI tahlil" press BEFORE
		// optimization runs, not after — transcription never needs result.mp4
		// (workflows/transcribe.ts's resolveVideoSourceUrl falls back to the raw
		// upload key once this row is gone) and the bytes are already verified
		// complete before this workflow starts. Queuing transcription behind the
		// ~45-minute optimize pass is what turned a ~10-minute transcription into
		// the measured 2-hour wait (wave1 SPEC, CHANGE 2) — of the two ways to
		// remove that queueing (reorder here, or teach transcribeVideo's
		// upload-in-progress guard that phase "processing" means bytes landed),
		// this reorder is the smaller change: the guard's multipart branch is
		// deliberately strict (uploaded===total is not proof of completion for
		// multipart — CompleteMultipartUpload assembles AFTER the last progress
		// tick), and loosening it risks reintroducing that exact race.
		//
		// Trade-off accepted: setProcessingError (below) writes to this same
		// videoUploads row, so a failure surfacing from optimizeAndFinalizeVideo
		// AFTER this delete (e.g. a storage-access error, not a plain optimize
		// failure — those are swallowed inside optimizeAndFinalizeVideo itself)
		// can no longer be recorded on it. Acceptable: that path is already the
		// FatalError-only edge case (video row missing / storage misconfigured),
		// not the normal optimize-failure path, which was never surfaced via
		// videoUploads either.
		//
		// Stamp `processingRunAt` BEFORE the row goes away: from the delete
		// until ffmpeg's first progress tick nothing else says this run is
		// alive, and the recover-stale-ai-jobs rowless pass would otherwise read
		// a live run as a dead one and start a second (2026-09-25 review).
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(
					COALESCE(${videos.metadata}, JSON_OBJECT()),
					'$.processingRunAt', ${new Date().toISOString()}
				)`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
		await db()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		// The upload row is gone, so transcribeVideo's in-progress guard passes
		// from here on.
		await startPendingAiRequest(videoId);

		await optimizeAndFinalizeVideo(videoId, rawFileKey);

		// LAST step, after optimizeAndFinalizeVideo's own `finally` cleanup has
		// run, so nothing in this run can remove it again.
		await markProcessingFinished(videoId);

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

	// A delete landing while this step is running must stop it before the
	// (expensive) remux even starts — cancel-on-delete, CHANGE 3.
	await assertVideoNotDeleted(videoId);

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const videoUrl = await bucket
		.getInternalSignedObjectUrl(rawFileKey)
		.pipe(runPromise);

	let durationSec: number | null = null;
	// The only carrier for this stage — videoUploads is already gone (deleted
	// above, wave 1). Cleared in `finally` below so it never survives past
	// this step regardless of how it ends (2026-08-18 wave 2, Change B).
	const progressWriter = createProcessingProgressWriter(videoId);

	try {
		try {
			const result = await optimizeRemoteVideoToMp4(videoUrl, {
				onProgress: (percent) => progressWriter.write("optimizing", percent),
			});
			// FINDING 3: `write("saving", null)` below fires exactly ONCE, and
			// `putObject` of a 1-2 GB result.mp4 can run well past
			// PROCESSING_STAGE_STALE_MS — a heartbeat re-writes on an interval so
			// `processingUpdatedAt` stays fresh while the save is genuinely alive.
			const heartbeat = setInterval(
				() => progressWriter.write("saving", null),
				PROCESSING_PROGRESS_HEARTBEAT_MS,
			);
			try {
				durationSec = result.metadata?.durationSec ?? null;
				progressWriter.write("saving", null);
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
				clearInterval(heartbeat);
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
	} finally {
		// Wait for every in-flight (fire-and-forget) progress write to settle
		// BEFORE clearing — otherwise a write from a moment earlier could
		// resolve AFTER the clear and re-set stale fields nothing will ever
		// clear again.
		await progressWriter.flush();
		await clearProcessingProgress(videoId);
	}
}

const PROCESSING_PROGRESS_THROTTLE_MS = 5000;
/** Well under PROCESSING_STAGE_STALE_MS (5 min, lib/ai-request-pending.ts) —
 * a write goes out at least this often even with no stage/percent change, so
 * a long-running "saving" putObject never crosses the staleness cutoff and
 * reads as dead (FINDING 3).
 *
 * KNOWN LIMIT, stated rather than overclaimed: only the "saving" block runs
 * under the heartbeat interval. During "optimizing" the sole writer is
 * ffmpeg's own onProgress callback, so if ffmpeg emits NOTHING for 5 minutes
 * (a hung remux, a stalled read of the source) no write happens at all, this
 * heartbeat is never consulted, and the overlay clears while the encode is
 * still alive. Deliberately not widened here: the owner scoped tonight's work
 * to the upload percentage plus a failed analysis ending in retry, and
 * touching the ffmpeg progress path is a bigger change than that. */
const PROCESSING_PROGRESS_HEARTBEAT_MS = 60_000;

interface ProcessingProgressWriteState {
	lastWriteAt: number;
	lastStage: "optimizing" | "saving" | null;
	lastPercent: number | null | undefined;
}

/**
 * Pure throttle decision — exported so the RED test can drive it with
 * simulated timestamps instead of real wall-clock sleeps. A write goes out
 * when the STAGE changes (so "saving" is never delayed behind the optimize
 * throttle) OR when the rounded integer percent changed AND at least
 * PROCESSING_PROGRESS_THROTTLE_MS has passed since the last write.
 */
export function shouldWriteProcessingProgress(
	state: ProcessingProgressWriteState,
	next: { now: number; stage: "optimizing" | "saving"; percent: number | null },
): boolean {
	const roundedPercent = next.percent == null ? null : Math.round(next.percent);
	if (next.stage !== state.lastStage) return true;
	if (roundedPercent !== state.lastPercent)
		return next.now - state.lastWriteAt >= PROCESSING_PROGRESS_THROTTLE_MS;
	// Heartbeat: nothing changed, but a write must still go out often enough
	// to keep processingUpdatedAt fresh — see PROCESSING_PROGRESS_HEARTBEAT_MS.
	return next.now - state.lastWriteAt >= PROCESSING_PROGRESS_HEARTBEAT_MS;
}

/**
 * Writes `metadata.processingStage/processingPercent/processingUpdatedAt` via
 * JSON_SET on the existing column — a whole-object overwrite would race the
 * AI counters written by the transcription pipeline (same rule as
 * startPendingAiRequest below). Fire-and-forget: a progress-write failure
 * must never fail the encode it is reporting on.
 */
interface ProcessingProgressWriter {
	write: (stage: "optimizing" | "saving", percent: number | null) => void;
	/** Resolves once every fire-and-forget write started by `write` has
	 * settled — see the `finally` block in optimizeAndFinalizeVideo for why
	 * this must run before the fields are cleared. */
	flush: () => Promise<void>;
}

function createProcessingProgressWriter(
	videoId: string,
): ProcessingProgressWriter {
	const state: ProcessingProgressWriteState = {
		lastWriteAt: -Infinity,
		lastStage: null,
		lastPercent: undefined,
	};
	const pendingWrites: Promise<unknown>[] = [];

	const write = (
		stage: "optimizing" | "saving",
		percent: number | null,
	): void => {
		const now = Date.now();
		if (!shouldWriteProcessingProgress(state, { now, stage, percent })) return;
		const roundedPercent = percent == null ? null : Math.round(percent);
		state.lastWriteAt = now;
		state.lastStage = stage;
		state.lastPercent = roundedPercent;

		pendingWrites.push(
			db()
				.update(videos)
				.set({
					metadata: sql`JSON_SET(
						COALESCE(${videos.metadata}, JSON_OBJECT()),
						'$.processingStage', ${stage},
						'$.processingPercent', ${roundedPercent},
						'$.processingUpdatedAt', ${new Date().toISOString()}
					)`,
				})
				.where(eq(videos.id, videoId as Video.VideoId))
				.catch((error: unknown) => {
					console.error(
						`[process-video] Failed to write processing progress for ${videoId}:`,
						error,
					);
				}),
		);
	};

	const flush = async (): Promise<void> => {
		await Promise.allSettled(pendingWrites);
	};

	return { write, flush };
}

/** Cleared on both the success and the failure path — see the `finally` in
 * optimizeAndFinalizeVideo. Never throws: a clear failure must not turn a
 * finished (or already-failed) step into a workflow error. */
async function clearProcessingProgress(videoId: string): Promise<void> {
	try {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_REMOVE(
					COALESCE(${videos.metadata}, JSON_OBJECT()),
					'$.processingStage',
					'$.processingPercent',
					'$.processingUpdatedAt'
				)`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[process-video] Failed to clear processing progress for ${videoId}:`,
			error,
		);
	}
}

/**
 * Writes the durable `metadata.processedAt` (ISO) success marker. Before it
 * existed, nothing stored separated "processing died right after deleting the
 * upload row" from "processed fine, waiting for the analyse press": the
 * progress fields are cleared in `finally`, `result.mp4` is not proof (the
 * optimize can be skipped and swallowed), and duration/width come from the
 * client (prod incident 2026-09-25, a rowless never-processed upload).
 *
 * Written on every run that FINISHED — including the benign "optimize failed
 * or was skipped, raw upload kept playable" branch, which is a normal return
 * from optimizeAndFinalizeVideo. Deliberately NOT written on the terminal
 * failure path (the catch in processVideoWorkflow): a run that threw must
 * stay distinguishable from a finished one so it remains recoverable.
 *
 * JSON_SET on the existing column, never a whole-object overwrite — the same
 * rule as the progress writer, so it cannot race the AI counters. Not
 * swallowed: a lost marker makes a finished video look unprocessed, so a
 * failure here surfaces like any other step error instead of passing silently.
 */
async function markProcessingFinished(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(
				COALESCE(${videos.metadata}, JSON_OBJECT()),
				'$.processedAt', ${new Date().toISOString()}
			)`,
		})
		.where(eq(videos.id, videoId as Video.VideoId));
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
			// `deletedAt IS NULL` — a video deleted while this workflow was still
			// optimizing must not have transcription started for it (prod incident:
			// deleted at 18:15:55, started processing at 18:24:51 because this
			// query had no such filter).
			.where(
				and(eq(videos.id, videoId as Video.VideoId), isNull(videos.deletedAt)),
			)
			.limit(1);

		if (!video || video.transcriptionStatus !== null) return;
		const metadata = (video.metadata as VideoMetadata) ?? {};
		if (!hasPendingUploadStartOrder(metadata)) return;

		console.log(
			`[process-video] Starting transcription (upload-time press redeemed) for ${videoId}`,
		);
		// The banked MODE is the run's switch (2026-09-10): the two-mode chooser
		// banks `aiStartMode` beside the one-shot order, so this redeemer starts
		// exactly what was pressed - "Only transcript" stays transcript-only
		// (false), "Full AI analysis" chains the summary and tasks in the same
		// run (true) with no second press. The flag travels explicitly instead of
		// relying on the durable-marker OR in shouldStartAiAfterTranscription,
		// which is what made the 2026-09-05 flag flips a no-op.
		const result = await transcribeVideo(
			videoId as Video.VideoId,
			video.ownerId,
			bankedStartRequestsFullAnalysis(metadata),
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
					'$.aiStartPendingUpload',
					'$.aiStartMode'
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
