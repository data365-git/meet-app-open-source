import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	organizationMembers,
	organizations,
	videos,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getEffectiveOrganizationRole } from "@/lib/permissions/roles";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	try {
		const user = await getCurrentUser();
		const url = new URL(request.url);
		const videoId = url.searchParams.get("videoId") as Video.VideoId;

		if (!user) {
			return Response.json({ auth: false }, { status: 401 });
		}

		if (!videoId) {
			return Response.json(
				{ error: true, message: "Video ID not provided" },
				{ status: 400 },
			);
		}

		const result = await db()
			.select()
			.from(videos)
			.where(and(eq(videos.id, videoId), isNull(videos.deletedAt)));
		if (result.length === 0 || !result[0]) {
			return Response.json(
				{ error: true, message: "Video not found" },
				{ status: 404 },
			);
		}

		const video = result[0];
		// Allow the video owner OR an org owner/admin (same gate as the manual
		// "start AI" / translate paths). Without this, an org admin who started
		// generation gets 403 here and their status poll never reaches a terminal
		// state, leaving the share page stuck on the optimistic "processing" view.
		let hasPermission = video.ownerId === user.id;
		if (!hasPermission && video.orgId) {
			const [orgAccess] = await db()
				.select({
					ownerId: organizations.ownerId,
					memberRole: organizationMembers.role,
				})
				.from(organizations)
				.leftJoin(
					organizationMembers,
					and(
						eq(organizationMembers.organizationId, organizations.id),
						eq(organizationMembers.userId, user.id),
					),
				)
				.where(
					and(
						eq(organizations.id, video.orgId),
						isNull(organizations.tombstoneAt),
					),
				)
				.limit(1);
			if (orgAccess) {
				const role = getEffectiveOrganizationRole({
					userId: user.id,
					ownerId: orgAccess.ownerId,
					memberRole: orgAccess.memberRole,
				});
				hasPermission = role === "owner" || role === "admin";
			}
		}
		if (!hasPermission) {
			return Response.json(
				{ error: true, message: "Forbidden" },
				{ status: 403 },
			);
		}

		const metadata: VideoMetadata = (video.metadata as VideoMetadata) || {};

		// Granular status fields (Wave 2.1): fine per-chunk progress written by
		// transcribe.ts (transcriptionChunks*) and generate-ai.ts (aiStageChunks*,
		// reset at each summary/refine stage transition). Included in every branch
		// below so the poll never has to fall back to a full page refresh just to
		// see these move — that's what let ShareVideo.tsx retire its 6s
		// `router.refresh()` workaround.
		const chunkProgress = {
			// Fine sub-phase inside "transcribe" (e.g. audio extraction), written
			// by the workflow at the moment the phase starts — same honesty rule
			// as the chunk counters below.
			aiProcessingSubStep: metadata.aiProcessingSubStep ?? null,
			transcriptionChunksCompleted:
				metadata.transcriptionChunksCompleted ?? null,
			transcriptionChunksTotal: metadata.transcriptionChunksTotal ?? null,
			aiStageChunksCompleted: metadata.aiStageChunksCompleted ?? null,
			aiStageChunksTotal: metadata.aiStageChunksTotal ?? null,
		};

		if (metadata.summary || metadata.chapters) {
			console.log(
				`[AI API] Returning existing AI metadata for video ${videoId}`,
			);
			return Response.json(
				{
					processing: false,
					title: metadata.aiTitle ?? null,
					summary: metadata.summary ?? null,
					chapters: metadata.chapters ?? null,
					aiGenerationStatus: metadata.aiGenerationStatus ?? null,
					aiProcessingStep: metadata.aiProcessingStep ?? null,
					aiMode: metadata.aiMode ?? null,
					aiQuotaWaiting: metadata.aiQuotaWaiting === true,
					...chunkProgress,
				},
				{ status: 200 },
			);
		}

		if (
			metadata.aiGenerationStatus === "PROCESSING" ||
			metadata.aiGenerationStatus === "QUEUED"
		) {
			console.log(
				`[AI API] AI processing already in progress for video ${videoId}`,
			);
			return Response.json(
				{
					processing: true,
					message: "AI metadata generation in progress",
					aiGenerationStatus: metadata.aiGenerationStatus,
					aiProcessingStep: metadata.aiProcessingStep ?? null,
					aiMode: metadata.aiMode ?? null,
					aiQuotaWaiting: metadata.aiQuotaWaiting === true,
					...chunkProgress,
				},
				{ status: 200 },
			);
		}

		// GET is strictly READ-ONLY. AI generation is MANUAL: an admin / video
		// owner starts (or retries) the pipeline only via the explicit POST
		// /api/videos/[videoId]/generate path (see _components/GenerateAiPanel.tsx).
		// This endpoint NEVER starts or restarts generation — doing so on a GET
		// (e.g. for ERROR/SKIPPED status) would silently waste tokens. It only
		// reports the current status so the client can show the right UI.
		return Response.json(
			{
				processing: false,
				aiGenerationStatus: metadata.aiGenerationStatus ?? null,
				aiProcessingStep: metadata.aiProcessingStep ?? null,
				aiMode: metadata.aiMode ?? null,
				aiQuotaWaiting: metadata.aiQuotaWaiting === true,
				...chunkProgress,
			},
			{ status: 200 },
		);
	} catch (error) {
		console.error("[AI API] Unexpected error:", error);
		return Response.json(
			{
				processing: false,
				error: "An unexpected error occurred",
			},
			{ status: 500 },
		);
	}
}
