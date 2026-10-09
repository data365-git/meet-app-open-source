import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, videos } from "@cap/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { extractAudioForDownload } from "@/lib/audio-extract";
import { downloadFilename } from "@/lib/download-filename";
import { runPromise } from "@/lib/server";
import { getStorageAccessForVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

/**
 * Download JUST THE AUDIO of a recording, as an mp3, while the video stays
 * exactly where it is.
 *
 * READ-ONLY BY CONSTRUCTION, and that is the point. Its neighbour
 * `replaceVideoWithAudio` does something that only sounds similar: it destroys
 * the video permanently. This route never deletes and never overwrites the
 * recording — the only thing it writes is its own cache object, under its own
 * key (`download-audio.mp3`), which is deliberately NOT `result.mp4`. Nothing
 * here can turn a download into a replacement.
 */

// Tried in order; the first that exists is the extraction source. Same list the
// replace-with-audio path uses, so both agree on what "the recording" means.
const SOURCE_CANDIDATE_NAMES = [
	"result.mp4",
	"raw-upload.mp4",
	"raw-upload.webm",
] as const;

/** The cache object's name. Distinct from every key replace-with-audio touches. */
const DOWNLOAD_AUDIO_NAME = "download-audio.mp3";

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ videoId: string }> },
) {
	const { videoId } = await params;

	const user = await getCurrentUser();
	if (!user?.id) {
		return new Response("Unauthorized", { status: 401 });
	}

	// Same membership rule as the other video actions: the owner, or a member of
	// the organization that owns the recording. A signed-in stranger must not be
	// able to pull the audio of a meeting by guessing an id.
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

	// Deliberately the same answer for "does not exist" and "not yours", so this
	// cannot be used to probe which video ids are real.
	if (!video) return new Response("Not found", { status: 404 });

	const filename = downloadFilename(video.name, "mp3");
	const headers = {
		"Content-Type": "audio/mpeg",
		"Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
		"Cache-Control": "private, max-age=0, must-revalidate",
	};

	try {
		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
		const cacheKey = `${video.ownerId}/${videoId}/${DOWNLOAD_AUDIO_NAME}`;

		// Already extracted once — serve the stored copy rather than running
		// ffmpeg over an hour of video again. Extraction is the expensive part;
		// a second download should be immediate.
		try {
			await bucket.headObject(cacheKey).pipe(runPromise);
			const cachedUrl = await bucket
				.getInternalSignedObjectUrl(cacheKey)
				.pipe(runPromise);
			const cached = await fetch(cachedUrl);
			if (cached.ok && cached.body) {
				return new Response(cached.body, { headers });
			}
			// Fall through and re-extract: a cache we cannot read is not a cache.
		} catch {
			// Not cached yet — extract below.
		}

		let sourceKey: string | null = null;
		for (const name of SOURCE_CANDIDATE_NAMES) {
			const key = `${video.ownerId}/${videoId}/${name}`;
			try {
				await bucket.headObject(key).pipe(runPromise);
				sourceKey = key;
				break;
			} catch {
				// candidate missing — try the next
			}
		}
		if (!sourceKey) {
			return new Response("This recording has no downloadable source file", {
				status: 409,
			});
		}

		const sourceUrl = await bucket
			.getInternalSignedObjectUrl(sourceKey)
			.pipe(runPromise);

		const audio = await extractAudioForDownload(sourceUrl);
		if (audio.length === 0) {
			return new Response("This recording has no audio track", { status: 409 });
		}

		// Cache for next time. Best-effort ON PURPOSE: if the write fails the user
		// still gets their download — a caching failure must never become a
		// download failure.
		try {
			await bucket
				.putObject(cacheKey, audio, {
					contentType: "audio/mpeg",
					contentLength: audio.length,
				})
				.pipe(runPromise);
		} catch (err) {
			console.error("[video-audio-download] cache write failed", {
				videoId,
				err: err instanceof Error ? err.message : String(err),
			});
		}

		return new Response(new Uint8Array(audio), { headers });
	} catch (err) {
		console.error("[video-audio-download] failed", {
			videoId,
			err: err instanceof Error ? err.message : String(err),
		});
		return new Response("Could not prepare the audio", { status: 500 });
	}
}
