import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";

/**
 * Throws a FatalError — the type `workflows/` already treats as terminal —
 * when the video has been soft-deleted (or no longer exists at all).
 *
 * Callers MUST invoke this from inside a loop body directly, never from
 * inside a try/catch that treats a throw as "this one item failed, keep
 * going" — a per-chunk fault-tolerance catch is exactly that shape, and an
 * abort placed inside it would be silently swallowed instead of stopping the
 * job (see workflows/transcribe.ts's chunk loop for the concrete case this
 * fixed).
 */
export async function assertVideoNotDeleted(videoId: string): Promise<void> {
	const [video] = await db()
		.select({ deletedAt: videos.deletedAt })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video || video.deletedAt != null) {
		throw new FatalError(`Video ${videoId} was deleted`);
	}
}
