import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { applyHermesAck, checkHermesQueueToken } from "@/lib/hermes-meeting";
import { patchVideoMetadata } from "@/lib/video-metadata";

export const dynamic = "force-dynamic";

/**
 * Hermes puller ack (ADR 2026-10-08, part A). The Mac-side job POSTs
 * {id, fileName} after writing the .txt — fileName is the name it ACTUALLY
 * used (it may have deduped with " (2)"), which is what the data365-side
 * "Hermesga joylandi ✓" mark shows. Idempotent: re-acking a delivered video
 * succeeds without moving deliveredAt. Unknown ids (or ids never queued for
 * Hermes) are 404 so the puller can drop them.
 */
export async function POST(request: NextRequest) {
	const token = serverEnv().HERMES_QUEUE_TOKEN;
	const gate = checkHermesQueueToken(
		request.headers.get("authorization"),
		token,
	);
	if (!gate.ok) {
		return new Response(
			gate.status === 503 ? "Hermes queue disabled" : "Unauthorized",
			{
				status: gate.status,
			},
		);
	}

	let body: { id?: unknown; fileName?: unknown };
	try {
		body = await request.json();
	} catch {
		return new Response("Invalid JSON body", { status: 400 });
	}

	const id = typeof body.id === "string" ? body.id : "";
	const fileName =
		typeof body.fileName === "string" ? body.fileName.trim() : "";
	if (!id || !fileName || fileName.length > 255) {
		return new Response("Invalid body: {id, fileName} required", {
			status: 400,
		});
	}

	try {
		const [video] = await db()
			.select({ id: videos.id, metadata: videos.metadata })
			.from(videos)
			.where(
				and(
					eq(videos.id, id as typeof videos.$inferSelect.id),
					isNull(videos.deletedAt),
				),
			)
			.limit(1);

		const hermes = (video?.metadata as VideoMetadata | undefined)?.hermes;
		if (
			!video ||
			!hermes ||
			(hermes.status !== "queued" && hermes.status !== "delivered")
		) {
			return new Response("Not found", { status: 404 });
		}

		// Idempotent path: already delivered, and applyHermesAck is a no-op on
		// delivered rows, so deliveredAt/fileName stay as the first ack wrote
		// them.
		await patchVideoMetadata(video.id, (current) =>
			applyHermesAck(current, fileName, new Date().toISOString()),
		);

		return Response.json(
			{ ok: true },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		console.error("[hermes-ack] failed:", error);
		return new Response("Ack failed", { status: 500 });
	}
}
