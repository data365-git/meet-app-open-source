import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import {
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import {
	assertAiBudgetAvailable,
	BudgetExceededError,
} from "@/lib/ai-cost-guard";
import type { AiSpeedMode } from "@/lib/ai-speed-mode";
import { isTranscriptionDisabled } from "@/lib/transcription-settings";
import { after } from "next/server";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

type TranscribeResult = {
	success: boolean;
	message: string;
};

const UPLOAD_IN_PROGRESS_PHASES = new Set([
	"uploading",
	"processing",
	"generating_thumbnail",
]);

/**
 * Is this upload genuinely still receiving bytes, so transcription must wait?
 *
 * The guard exists to avoid transcribing before every byte has landed. But a
 * finalize interrupted mid-flight (e.g. a redeploy restarting the container)
 * can leave the row stuck at phase "uploading" forever even though the whole
 * file is already in storage — which then permanently blocks transcription and
 * makes the "AI tahlil" button silently no-op. So treat a byte-complete row as
 * a stuck finalize (not a live upload) — EXCEPT for multipart uploads, which
 * report uploaded===total at their last progress tick BEFORE S3 assembles the
 * parts into a readable object (CompleteMultipartUpload runs later); for those,
 * byte-count is not proof of completion, so keep waiting on the phase itself.
 */
export function isUploadInProgress(
	upload:
		| { phase: string; uploaded: number; total: number; mode?: string | null }
		| undefined
		| null,
): boolean {
	if (!upload) return false;
	if (!UPLOAD_IN_PROGRESS_PHASES.has(upload.phase)) return false;
	const bytesTrulyComplete =
		upload.mode !== "multipart" &&
		upload.total > 0 &&
		upload.uploaded >= upload.total;
	return !bytesTrulyComplete;
}

export async function transcribeVideo(
	videoId: Video.VideoId,
	userId: string,
	aiGenerationEnabled = false,
	_isRetry = false,
	speedModeOverride?: AiSpeedMode,
): Promise<TranscribeResult> {
	if (!userId || !videoId) {
		return {
			success: false,
			message: "userId or videoId not supplied",
		};
	}

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId));

	if (query.length === 0) {
		return { success: false, message: "Video does not exist" };
	}

	const result = query[0];
	if (!result || !result.video) {
		return { success: false, message: "Video information is missing" };
	}

	const { video } = result;

	if (!video) {
		return { success: false, message: "Video information is missing" };
	}

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

	if (isTranscriptionDisabled(video.settings, result.orgSettings)) {
		console.log(
			`[transcribeVideo] Transcription disabled for video ${videoId}`,
		);
		try {
			await db()
				.update(videos)
				.set({ transcriptionStatus: "SKIPPED" })
				.where(eq(videos.id, videoId));
		} catch (err) {
			console.error(`[transcribeVideo] Failed to mark as skipped:`, err);
			return {
				success: false,
				message: "Transcription disabled, but failed to update status",
			};
		}
		return {
			success: true,
			message: "Transcription disabled for video — skipping transcription",
		};
	}

	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "PROCESSING" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		return {
			success: true,
			message: "Transcription already completed or in progress",
		};
	}

	const upload = await db()
		.select({
			phase: videoUploads.phase,
			uploaded: videoUploads.uploaded,
			total: videoUploads.total,
			mode: videoUploads.mode,
		})
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	const uploadRow = upload[0];

	if (isUploadInProgress(uploadRow)) {
		return {
			success: true,
			message: "Video upload is still in progress",
		};
	}

	// An in-progress phase that is NOT "in progress" per isUploadInProgress means
	// the bytes are complete (singlepart) but a finalize was interrupted and never
	// cleared the row. processVideoWorkflow's only job for a single-file MP4 is
	// exactly this delete, so clear the stuck row here — otherwise phase stays
	// "uploading" and blocks every future retry.
	if (
		uploadRow &&
		UPLOAD_IN_PROGRESS_PHASES.has(uploadRow.phase) &&
		!isUploadInProgress(uploadRow)
	) {
		await db()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
	}

	try {
		await assertAiBudgetAvailable({
			orgId: video.orgId,
			userId,
			videoId,
		});

		console.log(
			`[transcribeVideo] Triggering transcription workflow for video ${videoId}`,
		);

		const runTranscribe = () => transcribeVideoWorkflow({
			videoId,
			userId,
			aiGenerationEnabled,
			// Only include the override when explicitly set, so the default-path
			// payload stays exactly {videoId, userId, aiGenerationEnabled}.
			...(speedModeOverride ? { speedModeOverride } : {}),
		}).catch((err) => {
			console.error(
				`[transcribeVideo] Inline workflow failed for video ${videoId}:`,
				err,
			);
		});
		try { after(runTranscribe); } catch { void runTranscribe(); }

		return {
			success: true,
			message: "Transcription started inline",
		};
	} catch (error) {
		if (error instanceof BudgetExceededError) {
			return {
				success: false,
				message: "AI budget exceeded",
			};
		}

		console.error("[transcribeVideo] Failed to trigger workflow:", error);

		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}
