import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, videos } from "@cap/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { downloadFilename } from "@/lib/download-filename";
import { runPromise } from "@/lib/server";
import { normalizeWebVttVoiceText } from "@/lib/transcript-vtt";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import { Effect, Option } from "effect";

export const dynamic = "force-dynamic";

/**
 * Download the transcript of a recording as plain text, independent of AI
 * generation — the owner wants the transcript the moment it's ready, without
 * waiting for a summary. Auth pattern mirrors the neighbouring
 * `audio/route.ts`: signed-in team members only, not anonymous share-link
 * viewers, for consistency with the rest of this directory.
 */

function vttTimeToSeconds(raw: string): number | null {
	const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
	if (!match) return null;
	const hours = match[1] ? Number(match[1]) : 0;
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	return hours * 3600 + minutes * 60 + seconds;
}

function formatMmSs(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/** Standard WEBVTT (cue blocks separated by a blank line) to readable lines:
 * "[mm:ss] Speaker: text" when a speaker tag is present, else "[mm:ss] text". */
function vttToReadableText(vtt: string): string {
	const blocks = vtt.replace(/\r\n/g, "\n").split(/\n\n+/);
	const lines: string[] = [];

	for (const block of blocks) {
		const blockLines = block.split("\n").filter((l) => l.trim() !== "");
		if (blockLines.length === 0) continue;
		if (/^WEBVTT/i.test(blockLines[0] ?? "")) continue;

		// Skip an optional leading cue-identifier line.
		let idx = 0;
		if (blockLines[0] && !blockLines[0].includes("-->")) idx = 1;

		const timingLine = blockLines[idx];
		if (!timingLine || !timingLine.includes("-->")) continue;

		const startRaw = timingLine.split("-->")[0]?.trim() ?? "";
		const startSeconds = vttTimeToSeconds(startRaw);
		const text = blockLines.slice(idx + 1).join(" ").trim();
		if (!text) continue;

		const { speaker, text: spoken } = normalizeWebVttVoiceText(text);
		const timestamp = startSeconds !== null ? `[${formatMmSs(startSeconds)}] ` : "";
		lines.push(speaker ? `${timestamp}${speaker}: ${spoken}` : `${timestamp}${spoken}`);
	}

	return lines.join("\n");
}

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
		const vttContent = await Effect.gen(function* () {
			const [bucket] = yield* getStorageAccessForVideo(video);
			return yield* bucket.getObject(
				`${video.ownerId}/${videoId}/transcription.vtt`,
			);
		}).pipe(runPromise);

		if (Option.isNone(vttContent) || !vttContent.value.trim()) {
			return new Response("No transcript is available for this recording yet", {
				status: 404,
			});
		}

		const readable = vttToReadableText(vttContent.value);
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
