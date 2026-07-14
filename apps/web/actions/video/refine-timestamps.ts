"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
	assertAiBudgetAvailable,
	BudgetExceededError,
} from "@/lib/ai-cost-guard";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { refineVideoTimestampsWorkflow } from "@/workflows/transcribe";

export type RefineTimestampsResult =
	| { ok: true }
	| {
			ok: false;
			reason:
				| "unauthorized"
				| "not_found"
				| "missing_key"
				| "missing_transcript"
				| "already_processing"
				| "budget_exceeded"
				| "failed";
	  };

export async function refineVideoTimestamps(
	videoId: string,
): Promise<RefineTimestampsResult> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, reason: "unauthorized" };

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as typeof videos.$inferSelect.id));
	if (!video) return { ok: false, reason: "not_found" };
	if (video.ownerId !== user.id) return { ok: false, reason: "unauthorized" };
	if (!serverEnv().ELEVENLABS_API_KEY) {
		return { ok: false, reason: "missing_key" };
	}
	if (video.transcriptionStatus !== "COMPLETE") {
		return { ok: false, reason: "missing_transcript" };
	}

	try {
		await assertAiBudgetAvailable({
			orgId: video.orgId,
			userId: user.id,
			videoId,
		});

		await patchVideoMetadata(videoId, (current) => {
			if (current.timestampRefinement?.status === "PROCESSING") {
				throw new Error("already_processing");
			}
			return {
				...current,
				timestampRefinement: {
					status: "PROCESSING",
					requestedAt: new Date().toISOString(),
				} satisfies NonNullable<VideoMetadata["timestampRefinement"]>,
			};
		});
	} catch (error) {
		if (error instanceof BudgetExceededError) {
			return { ok: false, reason: "budget_exceeded" };
		}
		if (error instanceof Error && error.message === "already_processing") {
			return { ok: false, reason: "already_processing" };
		}
		return { ok: false, reason: "failed" };
	}

	const runRefinement = () =>
		refineVideoTimestampsWorkflow({ videoId, userId: user.id });
	try {
		after(runRefinement);
	} catch {
		void runRefinement();
	}

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/meetings");
	revalidatePath(`/s/${videoId}`);
	return { ok: true };
}
