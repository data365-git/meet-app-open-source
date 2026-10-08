import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, videos } from "@cap/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { downloadFilename } from "@/lib/download-filename";
import { fetchVideoTranscriptText } from "@/lib/transcript-text";

export const dynamic = "force-dynamic";

/**
 * Download the transcript of a recording as plain text, independent of AI
 * generation — the owner wants the transcript the moment it's ready, without
 * waiting for a summary. Auth pattern mirrors the neighbouring
 * `audio/route.ts`: signed-in team members only, not anonymous share-link
 * viewers, for consistency with the rest of this directory.
 *
 * 2026-10-08: the VTT -> text extraction moved to lib/transcript-text.ts so
 * the Hermes meeting queue can serve the byte-identical text. Behaviour here
 * is unchanged.
 */

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ videoId: string }> },
) {
	const { videoId } = await params;

	const user = await getCurrentUser();
	if (!user?.id) {
		return new Response("Unauthorized", { status: 401 });
	}

	// Same membership rule as audio/route.ts: the owner, or a member of the
	// organization that owns the recording.
	const memberships = await db()
		.select({ organizationId: organizationMembers.organizationId })
		.from(organizationMembers)
		.where(eq(organizationMembers.userId, user.id));
	const memberOrgIds = memberships.map((m) => m.organizationId);

	const [video] = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, videoId as typeof videos.$inferSelect.id),
				isNull(videos.deletedAt),
				memberOrgIds.length > 0
					? or(
							eq(videos.ownerId, user.id),
							inArray(videos.orgId, memberOrgIds),
						)
					: eq(videos.ownerId, user.id),
			),
		);

	if (!video) return new Response("Not found", { status: 404 });

	if (video.transcriptionStatus !== "COMPLETE") {
		return new Response("No transcript is available for this recording yet", {
			status: 404,
		});
	}

	try {
		const readable = await fetchVideoTranscriptText(video);
		if (readable === null) {
			return new Response("No transcript is available for this recording yet", {
				status: 404,
			});
		}

		const filename = downloadFilename(video.name, "txt");

		return new Response(readable, {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
				"Cache-Control": "private, max-age=0, must-revalidate",
			},
		});
	} catch (err) {
		console.error("[video-transcript-download] failed", {
			videoId,
			err: err instanceof Error ? err.message : String(err),
		});
		return new Response("Could not prepare the transcript", { status: 500 });
	}
}
