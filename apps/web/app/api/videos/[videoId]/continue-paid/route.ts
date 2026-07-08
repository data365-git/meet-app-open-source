import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, organizations, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { continueAiJobOnPaid, type AiJobPhase } from "@/lib/ai-job-control";
import { AI_ACCESS_DENIED_CODE, canUseAI } from "@/lib/permissions/ai-access";
import { getEffectiveOrganizationRole } from "@/lib/permissions/roles";

export const dynamic = "force-dynamic";

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ videoId: string }> },
) {
	try {
		const { videoId: rawVideoId } = await params;
		const videoId = rawVideoId as Video.VideoId;

		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (!canUseAI(user)) {
			return Response.json({ error: AI_ACCESS_DENIED_CODE }, { status: 403 });
		}

		const [video] = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				orgId: videos.orgId,
				transcriptionStatus: videos.transcriptionStatus,
				metadata: videos.metadata,
			})
			.from(videos)
			.where(and(eq(videos.id, videoId), isNull(videos.deletedAt)))
			.limit(1);

		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		let hasPermission = user.id === video.ownerId;
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
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		const metadata = (video.metadata as VideoMetadata) || {};
		const aiGenerationStatus = metadata.aiGenerationStatus;
		const phase: AiJobPhase | null =
			video.transcriptionStatus === "PROCESSING"
				? "transcription"
				: aiGenerationStatus === "PROCESSING" || aiGenerationStatus === "QUEUED"
					? "generation"
					: null;

		if (metadata.aiMode !== "cheap" || !phase) {
			return Response.json(
				{ error: "No running cheap AI job" },
				{ status: 409 },
			);
		}

		const result = await continueAiJobOnPaid({
			videoId,
			ownerId: video.ownerId,
			phase,
		});

		if (!result.success) {
			return Response.json({ error: result.message }, { status: 500 });
		}

		return Response.json({ success: true });
	} catch (error) {
		console.error("[continue-paid/route] Unexpected error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
