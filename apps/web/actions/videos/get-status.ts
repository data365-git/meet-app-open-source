"use server";

import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { PipelineProgress, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { provideOptionalAuth, VideosPolicy } from "@cap/web-backend";
import { Policy, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import {
	isRetryableDesktopSegmentsFinalizationError,
	queueDesktopSegmentsFinalization,
} from "@/lib/desktop-segments-finalization";
import * as EffectRuntime from "@/lib/server";

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO"
	| "CANCELLED";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

export interface VideoStatusResult {
	transcriptionStatus: TranscriptionStatus | null;
	aiGenerationStatus: AiGenerationStatus | null;
	name: string | null;
	aiTitle: string | null;
	summary: string | null;
	chapters: { title: string; start: number }[] | null;
	transcriptionProgress: number | null;
	pipelineProgress?: PipelineProgress;
	transcriptionError?: string;
	error?: string;
}

export async function getVideoStatus(
	videoId: Video.VideoId,
): Promise<VideoStatusResult | { success: false }> {
	if (!videoId) throw new Error("Video ID not provided");

	const exit = await Effect.gen(function* () {
		const videosPolicy = yield* VideosPolicy;

		return yield* Effect.promise(() =>
			db().select().from(videos).where(eq(videos.id, videoId)),
		).pipe(Policy.withPublicPolicy(videosPolicy.canView(videoId)));
	}).pipe(provideOptionalAuth, EffectRuntime.runPromiseExit);

	if (Exit.isFailure(exit)) return { success: false };

	const video = exit.value[0];
	if (!video) throw new Error("Video not found");

	const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

	if (!video.transcriptionStatus && serverEnv().GEMINI_API_KEY) {
		const activeUpload = await db()
			.select({
				videoId: videoUploads.videoId,
				phase: videoUploads.phase,
				processingError: videoUploads.processingError,
			})
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId))
			.limit(1);

		if (activeUpload.length > 0) {
			const upload = activeUpload[0];
			if (
				video.source?.type === "desktopSegments" &&
				upload?.phase === "error" &&
				isRetryableDesktopSegmentsFinalizationError(upload.processingError)
			) {
				queueDesktopSegmentsFinalization({
					videoId,
					userId: video.ownerId,
				}).catch((error) => {
					console.error(
						`[Get Status] Error queueing segment finalization for video ${videoId}:`,
						error,
					);
				});
			}

			return {
				transcriptionStatus: null,
				aiGenerationStatus:
					(metadata.aiGenerationStatus as AiGenerationStatus) || null,
				name: video.name,
				aiTitle: metadata.aiTitle || null,
				summary: metadata.summary || null,
				chapters: metadata.chapters || null,
				transcriptionProgress: metadata.transcriptionProgress ?? null,
				pipelineProgress: metadata.pipelineProgress,
				transcriptionError: metadata.transcriptionError,
			};
		}

		// Manual mode: transcription/AI are only started when the owner clicks
		// "Generate" (POST /api/videos/[id]/generate). Do not auto-start here —
		// just report the current (not-started) status via the return below.
	}

	if (video.transcriptionStatus === "ERROR") {
		return {
			transcriptionStatus: "ERROR",
			aiGenerationStatus:
				(metadata.aiGenerationStatus as AiGenerationStatus) || null,
			name: video.name,
			aiTitle: metadata.aiTitle || null,
			summary: metadata.summary || null,
			chapters: metadata.chapters || null,
			transcriptionProgress: metadata.transcriptionProgress ?? null,
			pipelineProgress: metadata.pipelineProgress,
			transcriptionError: metadata.transcriptionError,
			error: "Transcription failed",
		};
	}

	// Manual mode: AI generation is only started via the manual "Generate" flow
	// (which passes aiGenerationEnabled=true to transcribeVideo, chaining into AI).
	// Do not auto-start it here — just report status.

	return {
		transcriptionStatus:
			(video.transcriptionStatus as TranscriptionStatus) || null,
		aiGenerationStatus:
			(metadata.aiGenerationStatus as AiGenerationStatus) || null,
		name: video.name,
		aiTitle: metadata.aiTitle || null,
		summary: metadata.summary || null,
		chapters: metadata.chapters || null,
		transcriptionProgress: metadata.transcriptionProgress ?? null,
		pipelineProgress: metadata.pipelineProgress,
		transcriptionError: metadata.transcriptionError,
	};
}
