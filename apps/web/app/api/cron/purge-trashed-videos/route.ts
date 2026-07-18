import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import { and, asc, isNotNull, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { purgeTrashedVideo } from "./purge-helpers";

export const dynamic = "force-dynamic";

// The other half of the Trash promise: /api/video/delete soft-deletes with
// "kept for 7 days so it can be restored", so this nightly cron makes the
// 7-day expiry real. Each eligible video goes through the REUSED
// Videos.permanentlyDelete (see purge-helpers.ts) — storage first, row last,
// idempotent — so a partial failure simply retries the next night.

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// Heavier per item than reconcile-storage's 200: each purge lists and
// deletes the video's storage objects, then its rows. A backlog larger than
// this drains over successive nights; `remaining` reports what is left.
const MAX_VIDEOS_PER_RUN = 100;

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

	const cutoff = new Date(Date.now() - TRASH_RETENTION_MS);
	const eligible = and(
		isNotNull(videos.deletedAt),
		lt(videos.deletedAt, cutoff),
	);

	const candidates = await db()
		.select({ id: videos.id, ownerId: videos.ownerId })
		.from(videos)
		.where(eligible)
		.orderBy(asc(videos.deletedAt))
		.limit(MAX_VIDEOS_PER_RUN);

	let purged = 0;
	let failed = 0;
	let skippedNoOwner = 0;

	for (const candidate of candidates) {
		try {
			const outcome = await purgeTrashedVideo(candidate.id, candidate.ownerId);
			if (outcome === "purged") {
				purged++;
				console.log(`[purge-trashed-videos] Purged video ${candidate.id}`);
			} else if (outcome === "skipped_no_owner") {
				skippedNoOwner++;
				console.warn(
					`[purge-trashed-videos] Skipped video ${candidate.id}: owner row missing`,
				);
			} else {
				failed++;
				console.error(
					`[purge-trashed-videos] Failed to purge video ${candidate.id} (row kept, retried next run)`,
				);
			}
		} catch (error) {
			failed++;
			console.error(
				`[purge-trashed-videos] Failed to purge video ${candidate.id}:`,
				error,
			);
		}
	}

	// Honest backlog: failures keep their rows, so they re-count here and
	// retry next run. The SAME predicate as the candidate query — cutoff was
	// computed once above, so purged rows deleted just now no longer match.
	const [remainingRow] = await db()
		.select({ count: sql<number>`COUNT(*)` })
		.from(videos)
		.where(eligible);

	return NextResponse.json({
		purged,
		failed,
		skippedNoOwner,
		remaining: Number(remainingRow?.count ?? 0),
		cutoff: cutoff.toISOString(),
	});
}
