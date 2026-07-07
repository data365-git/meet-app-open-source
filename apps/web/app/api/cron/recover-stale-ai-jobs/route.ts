import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { sendOpsAlert } from "@/lib/ops-alert";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

const STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
const MAX_AUTO_RETRY_ATTEMPTS = 2;

/** Pure decision: does this video still get an automatic re-kick, or has it used up its retries? */
export function shouldAutoRetry(attempts: number | undefined): boolean {
	return (attempts ?? 0) < MAX_AUTO_RETRY_ATTEMPTS;
}

/** Metadata after incrementing the auto-recover attempt counter, resetting the stale processing markers. */
export function withIncrementedAutoRecoverAttempts(
	metadata: VideoMetadata,
): VideoMetadata {
	return {
		...metadata,
		autoRecoverAttempts: (metadata.autoRecoverAttempts ?? 0) + 1,
		processingStartedAt: undefined,
		aiProcessingStartedAt: undefined,
	};
}

type StaleTranscriptionCandidate = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	metadata: VideoMetadata | null;
};

type StaleAiCandidate = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	metadata: VideoMetadata | null;
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

	const staleBefore = new Date(Date.now() - STALE_JOB_THRESHOLD_MS);
	const staleBeforeIso = staleBefore.toISOString();

	const transcriptionCandidates: StaleTranscriptionCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				eq(videos.transcriptionStatus, "PROCESSING"),
				isNull(videos.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')) <= ${staleBeforeIso}`,
			),
		);

	const aiGenerationCandidates: StaleAiCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				isNull(videos.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) IN ('PROCESSING', 'QUEUED')`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProcessingStartedAt')) <= ${staleBeforeIso}`,
			),
		);

	let retried = 0;
	let gaveUp = 0;

	for (const candidate of transcriptionCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (shouldAutoRetry(metadata.autoRecoverAttempts)) {
				const nextMetadata = withIncrementedAutoRecoverAttempts(metadata);
				await db()
					.update(videos)
					.set({ transcriptionStatus: null, metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await transcribeVideo(candidate.id, candidate.ownerId, true);
				retried++;
			} else {
				await db()
					.update(videos)
					.set({ transcriptionStatus: "ERROR" })
					.where(eq(videos.id, candidate.id));
				await sendOpsAlert(
					`AI job dead after 2 auto-retries: ${candidate.id} (${candidate.name})`,
				);
				gaveUp++;
			}
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to recover transcription for video ${candidate.id}:`,
				error,
			);
		}
	}

	for (const candidate of aiGenerationCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (shouldAutoRetry(metadata.autoRecoverAttempts)) {
				const nextMetadata: VideoMetadata = {
					...withIncrementedAutoRecoverAttempts(metadata),
					aiGenerationStatus: undefined,
				};
				await db()
					.update(videos)
					.set({ metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await startAiGeneration(candidate.id, candidate.ownerId, {
					force: true,
				});
				retried++;
			} else {
				await db()
					.update(videos)
					.set({
						metadata: sql<VideoMetadata>`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
					})
					.where(eq(videos.id, candidate.id));
				await sendOpsAlert(
					`AI job dead after 2 auto-retries: ${candidate.id} (${candidate.name})`,
				);
				gaveUp++;
			}
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to recover AI generation for video ${candidate.id}:`,
				error,
			);
		}
	}

	return NextResponse.json({
		success: true,
		staleBefore: staleBefore.toISOString(),
		retried,
		gaveUp,
	});
}
