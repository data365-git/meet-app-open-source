import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { users, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { hasPaidGeminiKey } from "@/lib/gemini-paid-key";
import { hasOpenRouterKey } from "@/lib/openrouter-key";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { assertAiBudgetAvailable, BudgetExceededError } from "@/lib/ai-cost-guard";
import { sanitizeAiErrorMessageForUi } from "@/lib/ai-error-message";
import { clearFreeTierVerdict } from "@/lib/free-tier-health";
import { after } from "next/server";
import { generateAiWorkflow } from "@/workflows/generate-ai";

type GenerateAiResult = {
	success: boolean;
	message: string;
};

export async function startAiGeneration(
	videoId: Video.VideoId,
	userId: string,
	opts?: {
		force?: boolean;
		/** A cron/recovery re-kick — must NOT refund the recovery budget. */
		isRetry?: boolean;
	},
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

	// An OpenRouter key is a usable PAID provider for this path too, so it must
	// satisfy the same availability check — otherwise an instance whose paid
	// credential lives entirely at OpenRouter is refused at the gate before the
	// call it would happily serve.
	let hasUsableGeminiKey = hasPaidGeminiKey() || hasOpenRouterKey();
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

		// Job start = a fresh verdict on the free tier, same as transcription's
		// claim.
		clearFreeTierVerdict(videoId);
		await db()
			.update(videos)
			.set({
				metadata: {
					...metadata,
					aiJobStartedAt:
						metadata.aiJobStartedAt ?? new Date().toISOString(),
					aiQuotaWaiting: false,
					aiGenerationStatus: "QUEUED",
					aiProcessingStartedAt: new Date().toISOString(),
					// Fresh liveness baseline (round-13 #1): without this, a
					// transcription-era aiProgressAt from hours ago makes the
					// cron's since-last-progress clock judge this brand-new
					// generation stale immediately and start a SECOND paid run.
					aiProgressAt: new Date().toISOString(),
					// A FRESH (owner-initiated) start gets a fresh recovery budget
					// (round-10 #3, mirroring transcription): without this, two
					// stalls pinned the video at attempts=2 forever and every later
					// generation went straight to ERROR with zero re-kicks. A cron
					// RETRY must NOT refund itself.
					...(opts?.isRetry ? {} : { autoRecoverAttempts: undefined }),
				} as VideoMetadata,
			})
			.where(eq(videos.id, videoId));

		const runGen = () => generateAiWorkflow({
			videoId,
			userId,
			force,
		}).catch(async (err) => {
			console.error(
				`[startAiGeneration] Inline workflow failed for video ${videoId}:`,
				err,
			);
			// Mark ERROR so the UI shows a retryable error instead of a forever
			// spinner. (Since round 10 there are no cheap quota-parks: every
			// failure landing here is a real one.)
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
				// (round-10 #2: the quota-park writer is gone — cheap generation
				// pays inline when its free chain is genuinely exhausted, so an
				// AiQuotaWaitError can no longer reach this catch. Any failure
				// here is a real error and gets the visible, retryable ERROR.)
				await db()
					.update(videos)
					.set({
						metadata: {
							...currentMeta,
							aiGenerationStatus: "ERROR",
							// Client-visible metadata (round-17 #2): the raw message
							// can carry Google's response body — the full detail is
							// already in the console.error above; the DB gets the
							// sanitized reason.
							aiGenerationError: sanitizeAiErrorMessageForUi(
								err instanceof Error ? err.message : String(err),
							),
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
