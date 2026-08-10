import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	cancelBatch,
	deleteBatchFile,
} from "@/lib/gemini-batch-transcribe";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

/**
 * Best-effort abandon of any pending durable Batch jobs on a paid takeover (the
 * four-hour flip and the manual "continue on paid" button). Cancels each Batch
 * and deletes its uploaded Files API object with the SERVER paid key. Never
 * throws — a cleanup failure must not block the fast continuation, and already
 * collected partial cues are kept (only the pending jobs are dropped by the
 * caller via `aiBatchJobs: undefined`).
 */
export async function abandonPendingBatchJobs(
	metadata: VideoMetadata,
): Promise<void> {
	const jobs = metadata.aiBatchJobs;
	if (!Array.isArray(jobs) || jobs.length === 0) return;
	const paidKey = serverEnv().GEMINI_API_KEY;
	if (!paidKey) return;
	await Promise.allSettled(
		jobs.flatMap((job) => [
			cancelBatch(job.batchName, paidKey),
			deleteBatchFile(job.fileName, paidKey),
		]),
	);
}

export type AiJobPhase = "transcription" | "generation";

type ContinueOnPaidResult = {
	success: boolean;
	message: string;
};

export async function continueAiJobOnPaid({
	videoId,
	ownerId,
	phase,
}: {
	videoId: Video.VideoId;
	ownerId: string;
	phase: AiJobPhase;
}): Promise<ContinueOnPaidResult> {
	const [row] = await db()
		.select({
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!row) {
		return { success: false, message: "Video does not exist" };
	}

	const metadata = (row.metadata as VideoMetadata) || {};

	// Abandon any pending durable Batch jobs before switching to paid — cancel the
	// remote Batch + delete its Files API input so it does not keep running while
	// paid Standard repeats the chunk (spec §5 C5, risk #7). Best-effort: never
	// blocks the continuation. Already collected partial cues are retained.
	await abandonPendingBatchJobs(metadata);

	const nextMetadata: VideoMetadata = {
		...metadata,
		aiMode: "fast",
		aiQuotaWaiting: undefined,
		aiBatchJobs: undefined,
		processingStartedAt: undefined,
		aiProcessingStartedAt: undefined,
	};

	if (phase === "transcription") {
		// No transcriptionStatus reset: the status must never pass through NULL
		// on a re-kick — this flip fires unattended at hour 4, exactly when the
		// owner is watching, and a reload during transcribeVideo's multi-second
		// pre-claim work (owner lookup, decrypt, upload check, budget guard)
		// would render "start AI analysis?" for a job that is being continued.
		// Clearing processingStartedAt above is what hands the row to the retry
		// re-claim (transcribeVideo refuses to re-claim a row whose claim marker
		// is still fresh). The "fast" forcing is deliberate and stays.
		await db()
			.update(videos)
			.set({ metadata: nextMetadata })
			.where(eq(videos.id, videoId));
		return transcribeVideo(videoId, ownerId, true, true, "fast");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...nextMetadata,
				aiGenerationStatus: undefined,
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId));
	return startAiGeneration(videoId, ownerId, {
		force: true,
		speedModeOverride: "fast",
	});
}
