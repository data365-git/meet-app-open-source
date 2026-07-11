import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { aiUsageEvents, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { priceForMicros } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { Option } from "effect";
import { NextResponse } from "next/server";
import { mergeBatchChunkIntoPartial, removeBatchJob } from "@/lib/batch-merge";
import {
	type CollectBatchResult,
	cancelBatch,
	collectBatchResult,
	deleteBatchFile,
} from "@/lib/gemini-batch-transcribe";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { getStorageAccessForVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

// Same model the durable Batch submits with (gemini-batch-transcribe pins it).
const BATCH_USAGE_MODEL = "gemini-3-flash-preview";

/** Deterministic ai_usage_events id per Batch so re-recording is a no-op. */
function batchUsageId(batchName: string): string {
	return createHash("sha256").update(batchName).digest("hex").slice(0, 15);
}

const partialKeyFor = (ownerId: string, videoId: string) =>
	`${ownerId}/${videoId}/transcription-partial.vtt`;

// ─── Cron ───────────────────────────────────────────────────────────────────────

type PollCandidate = {
	video: typeof videos.$inferSelect;
};

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

	const paidKey = serverEnv().GEMINI_API_KEY;
	if (!paidKey) {
		return NextResponse.json(
			{ error: "No paid GEMINI_API_KEY configured" },
			{ status: 500 },
		);
	}

	const candidates: PollCandidate[] = await db()
		.select({ video: videos })
		.from(videos)
		.where(
			and(
				isNull(videos.deletedAt),
				sql`JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.aiBatchJobs')) > 0`,
			),
		);

	let pending = 0;
	let succeeded = 0;
	let failed = 0;
	let retried = 0;
	let cleared = 0;
	let errors = 0;

	for (const { video } of candidates) {
		try {
			const metadata = (video.metadata as VideoMetadata) ?? {};
			const jobs = metadata.aiBatchJobs ?? [];
			if (jobs.length === 0) continue;

			// The video was flipped to paid (4h) or is otherwise no longer cheap —
			// the poll collector does not own it. Cancel any stray Batch and clear
			// the jobs so paid Standard can finish from the checkpoint.
			if (metadata.aiMode !== "cheap") {
				await Promise.allSettled(
					jobs.flatMap((j) => [
						cancelBatch(j.batchName, paidKey),
						deleteBatchFile(j.fileName, paidKey),
					]),
				);
				await patchVideoMetadata(video.id, (m) => ({
					...m,
					aiBatchJobs: undefined,
				}));
				cleared++;
				continue;
			}

			let remaining = jobs;
			let terminal = false;

			for (const job of jobs) {
				const result: CollectBatchResult = await collectBatchResult(
					job.batchName,
					{
						apiKey: paidKey,
						fileName: job.fileName,
						audioDurationSec: job.durationSec,
					},
				);

				if (result.status === "pending") {
					pending++;
					continue;
				}

				if (result.status === "failed") {
					// Terminal failure/expiry: drop the job so the chunk is retried by
					// the cheap re-kick below.
					console.warn(
						`[poll-batch-jobs] Batch ${job.batchName} failed for video=${video.id}: ${result.reason}`,
					);
					remaining = removeBatchJob(remaining, job.batchName);
					terminal = true;
					failed++;
					continue;
				}

				// Succeeded: strictly read the current partial. A MISSING partial is an
				// empty base; ANY OTHER read/storage error keeps the job for next tick
				// so we never overwrite a real partial after an ambiguous read failure.
				let partialVtt: string;
				try {
					const [bucket] =
						await getStorageAccessForVideo(video).pipe(runPromise);
					const content = await bucket
						.getObject(partialKeyFor(video.ownerId, video.id))
						.pipe(runPromise);
					partialVtt = Option.isNone(content) ? "WEBVTT\n\n" : content.value;

					const merged = mergeBatchChunkIntoPartial(
						partialVtt,
						result.transcriptVtt,
						job.startSec,
					);
					await bucket
						.putObject(partialKeyFor(video.ownerId, video.id), merged, {
							contentType: "text/vtt",
						})
						.pipe(runPromise);
				} catch (storageError) {
					console.error(
						`[poll-batch-jobs] Storage read/write error for video=${video.id}; keeping job for next tick:`,
						storageError,
					);
					// Keep this job; do not drop, do not re-kick.
					continue;
				}

				// Record Batch-rate usage best-effort. It is already paid for, so an
				// accounting failure must never block or discard the merged result,
				// and it must never be gated by a pre-spend budget check.
				try {
					const audioInTokens = result.audioInTokens;
					const textInTokens = Math.max(0, result.inputTokens - audioInTokens);
					const costUsdMicros = priceForMicros(BATCH_USAGE_MODEL, {
						textInTokens,
						audioInTokens,
						outputTokens: result.outputTokens,
						batch: true,
					});
					await db()
						.insert(aiUsageEvents)
						.values({
							id: batchUsageId(job.batchName),
							orgId: video.orgId as Organisation.OrganisationId,
							userId: video.ownerId as unknown as User.UserId,
							videoId: video.id as Video.VideoId,
							operation: "transcription",
							model: BATCH_USAGE_MODEL,
							inputTokens: result.inputTokens,
							outputTokens: result.outputTokens,
							costUsdMicros,
							billingMonth: new Date().toISOString().slice(0, 7),
						})
						.onDuplicateKeyUpdate({ set: { id: sql`${aiUsageEvents.id}` } });
				} catch (accountingError) {
					console.error(
						`[poll-batch-jobs] Batch usage accounting failed for video=${video.id} (result kept):`,
						accountingError,
					);
				}

				remaining = removeBatchJob(remaining, job.batchName);
				terminal = true;
				succeeded++;
			}

			// Persist the remaining jobs (read-modify-write; keep unrelated metadata).
			const persisted = await patchVideoMetadata(video.id, (m) => ({
				...m,
				aiBatchJobs: remaining.length > 0 ? remaining : undefined,
			}));

			// All jobs resolved (none pending) → re-kick cheap so the workflow resumes
			// from the fuller checkpoint (collected chunk now covered → skipped).
			if (terminal && remaining.length === 0) {
				await db()
					.update(videos)
					.set({
						transcriptionStatus: null,
						metadata: {
							// Retain aiJobStartedAt (the original job's 4h clock); only reset
							// the stale processing markers and quota-wait flag.
							...persisted,
							processingStartedAt: undefined,
							aiProcessingStartedAt: undefined,
							aiQuotaWaiting: false,
						} as VideoMetadata,
					})
					.where(eq(videos.id, video.id));
				await transcribeVideo(video.id, video.ownerId, true, true, "cheap");
				retried++;
			}
		} catch (error) {
			errors++;
			console.error(
				`[poll-batch-jobs] Failed to process batch jobs for video ${video.id}:`,
				error,
			);
		}
	}

	return NextResponse.json({
		success: true,
		pending,
		succeeded,
		failed,
		retried,
		cleared,
		errors,
	});
}
