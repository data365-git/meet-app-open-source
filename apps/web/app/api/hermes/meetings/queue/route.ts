import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import {
	buildHermesMeetingFileName,
	checkHermesQueueToken,
	selectHermesQueueItems,
} from "@/lib/hermes-meeting";
import { fetchVideoTranscriptText } from "@/lib/transcript-text";

export const dynamic = "force-dynamic";

/**
 * Hermes meeting pull queue (ADR 2026-10-08, part A). The Mac-side launchd
 * job polls this every 5 min with `Authorization: Bearer <HERMES_QUEUE_TOKEN>`,
 * writes each transcript into ~/.hermes/crm-agent/data/meetings/ and acks.
 *
 * The response carries ONLY {id, fileName, text} per item — no other video
 * fields, no user data. Items must be queued for Hermes AND transcription
 * COMPLETE; up to 20 per poll, oldest queuedAt first, so the Mac catches up
 * in order after sleep/offline.
 */
export async function GET(request: NextRequest) {
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

	try {
		// Full row: fetchVideoTranscriptText/storage access needs the storage
		// fields — but nothing beyond {id, fileName, text} ever leaves this
		// handler.
		const rows = await db()
			.select()
			.from(videos)
			.where(
				and(
					isNull(videos.deletedAt),
					eq(videos.transcriptionStatus, "COMPLETE"),
					sql`JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.hermes.status')) = 'queued'`,
				),
			)
			.orderBy(
				sql`JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.hermes.queuedAt'))`,
			)
			.limit(20);

		const items: Array<{ id: string; fileName: string; text: string }> = [];
		for (const row of selectHermesQueueItems(rows, 20)) {
			const metadata = (row.metadata as VideoMetadata) || {};
			const hermes = metadata.hermes;
			if (!hermes || hermes.status !== "queued") continue;

			const text = await fetchVideoTranscriptText(row);
			if (text === null) continue;

			items.push({
				id: row.id,
				fileName: buildHermesMeetingFileName({
					clientName: hermes.clientName ?? "",
					company: hermes.company ?? "",
					recordedAt: metadata.customCreatedAt ?? row.createdAt,
				}),
				text,
			});
		}

		return Response.json(items, {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("[hermes-queue] failed:", error);
		return new Response("Queue unavailable", { status: 500 });
	}
}
