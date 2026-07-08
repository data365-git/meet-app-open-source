import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { assertAiBudgetAvailable, BudgetExceededError } from "@/lib/ai-cost-guard";
import { type AiSpeedMode, resolveAiSpeedMode } from "@/lib/ai-speed-mode";
import { isAiQuotaWaitError } from "@/lib/ai-quota-wait";
import { after } from "next/server";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
	opts?: { force?: boolean; speedModeOverride?: AiSpeedMode },
): Promise<GenerateAiResult> {
	const force = opts?.force ?? false;
	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({ video: videos })
		.from(videos)
		.where(eq(videos.id, videoId));

	if (query.length === 0 || !query[0]?.video) {
		return { success: false, message: "Video does not exist" };
	}

	const { video } = query[0];

	// Resolve a usable Gemini key: prefer the video owner's saved key (encrypted),
	// fall back to the server env key. Fail only if NEITHER exists, so users who
	// rely solely on their own saved key are not rejected at the gate.
	const [owner] = await db()
		.select({ geminiApiKey: users.geminiApiKey })
		.from(users)
		.where(eq(users.id, video.ownerId))
		.limit(1);

	let hasUsableGeminiKey = Boolean(serverEnv().GEMINI_API_KEY);
	if (!hasUsableGeminiKey && owner?.geminiApiKey) {
		try {
			hasUsableGeminiKey = Boolean(await decrypt(owner.geminiApiKey));
		} catch {
			hasUsableGeminiKey = false;
		}
	}

	if (!hasUsableGeminiKey) {
		return {
			success: false,
			message:
				"No Gemini API key configured. Set one in Settings → Account → Transcription API Keys, or ask your admin to set GEMINI_API_KEY.",
		};
	}

	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			success: false,
			message: "Transcription not complete",
		};
	}

	const metadata = (video.metadata as VideoMetadata) || {};
	const aiSpeedMode =
		opts?.speedModeOverride ?? resolveAiSpeedMode(metadata.aiMode);

	if (
		metadata.aiGenerationStatus === "PROCESSING" ||
		metadata.aiGenerationStatus === "QUEUED"
	) {
		return {
			success: true,
			message: "AI generation already in progress",
		};
	}

	if (
		!force &&
		metadata.aiGenerationStatus === "COMPLETE" &&
		metadata.summary &&
		metadata.chapters
	) {
		return {
			success: true,
			message: "AI metadata already generated",
		};
	}

	try {
		await assertAiBudgetAvailable({
			orgId: video.orgId,
			userId,
			videoId,
		});

		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiMode: aiSpeedMode,
					aiJobStartedAt:
						metadata.aiJobStartedAt ?? new Date().toISOString(),
					aiQuotaWaiting: false,
					aiGenerationStatus: "QUEUED",
					aiProcessingStartedAt: new Date().toISOString(),
				} as VideoMetadata,
			})
			.where(eq(videos.id, videoId));

		const runGen = () => generateAiWorkflow({
			videoId,
			userId,
			force,
			speedModeOverride: aiSpeedMode,
		}).catch(async (err) => {
			if (isAiQuotaWaitError(err)) {
				console.warn(
					`[startAiGeneration] Cheap AI generation waiting for free quota for video ${videoId}:`,
					err,
				);
			} else {
				console.error(
					`[startAiGeneration] Inline workflow failed for video ${videoId}:`,
					err,
				);
			}
			// Mark ERROR for real failures so the UI shows a retryable error instead
			// of a forever spinner. Cheap quota waits intentionally stay PROCESSING.
			try {
				const [current] = await db()
					.select({ metadata: videos.metadata })
					.from(videos)
					.where(eq(videos.id, videoId))
					.limit(1);
				const currentMeta = (current?.metadata as VideoMetadata) ?? {};
				// Don't clobber a concurrent success: if another run already
				// finished, leave COMPLETE in place instead of overwriting ERROR.
				if (currentMeta.aiGenerationStatus === "COMPLETE") {
					return;
				}
				if (
					isAiQuotaWaitError(err) &&
					currentMeta.aiMode === "cheap"
				) {
					await db()
						.update(videos)
						.set({
							metadata: {
								...currentMeta,
								aiQuotaWaiting: true,
							} as VideoMetadata,
						})
						.where(eq(videos.id, videoId));
					return;
				}
				await db()
					.update(videos)
					.set({
						metadata: {
							...currentMeta,
							aiGenerationStatus: "ERROR",
							aiGenerationError:
								err instanceof Error
									? err.message
									: String(err),
						} as VideoMetadata,
					})
					.where(eq(videos.id, videoId));
			} catch (markErr) {
				console.error(
					`[startAiGeneration] Failed to mark aiGenerationStatus=ERROR for ${videoId}:`,
					markErr,
				);
			}
		});
		try { after(runGen); } catch { void runGen(); }

		return {
			success: true,
			message: "AI generation started inline",
		};
	} catch (error) {
		if (error instanceof BudgetExceededError) {
			return {
				success: false,
				message: "AI budget exceeded",
			};
		}

		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiGenerationStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start AI generation workflow",
		};
	}
}
