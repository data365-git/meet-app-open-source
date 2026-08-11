import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import {
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import {
	assertAiBudgetAvailable,
	BudgetExceededError,
} from "@/lib/ai-cost-guard";
import { isTranscriptionJobStale } from "@/app/api/cron/recover-stale-ai-jobs/stale-job-helpers";
import { hasPaidGeminiKey } from "@/lib/gemini-paid-key";
import { type AiSpeedMode, resolveAiSpeedMode } from "@/lib/ai-speed-mode";
import { isAiQuotaWaitError } from "@/lib/ai-quota-wait";
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
	// A cron/collector re-kick of a job whose row may still say PROCESSING.
	// The re-kick path must NOT reset the status to NULL first (a page load in
	// that window renders "not started" for a job that is alive), so instead a
	// retry is allowed to pass the PROCESSING guard and re-claim in place.
	isRetry = false,
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

	let hasUsableGeminiKey = hasPaidGeminiKey();
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

	// A retry (cron re-kick / Batch collector / paid flip) may re-claim a
	// PROCESSING row in place — that is the whole point of isRetry (no NULL
	// pass-through). But the caller's say-so is not enough: two recovery paths
	// can race on the same row, and re-claiming a genuinely LIVE workflow means
	// two workflows billing Gemini for the same video. So the re-claim is
	// gated on the row's own EVIDENCE OF LIFE — the aiProgressAt heartbeat
	// (re-stamped on every completed chunk), same clock the recovery cron
	// judges by. A recovery owner clears the markers when taking the job over
	// (absent = row handed to us); a fresh heartbeat means a live workflow —
	// refuse, retry or not, whatever the job's total runtime.
	const guardMetadata = (video.metadata as VideoMetadata) || {};
	const processingLooksLive = !isTranscriptionJobStale(guardMetadata);
	if (
		video.transcriptionStatus === "COMPLETE" ||
		(video.transcriptionStatus === "PROCESSING" &&
			(!isRetry || processingLooksLive)) ||
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

		// Claim the job in the DB BEFORE launching the workflow, not inside it.
		//
		// Owner-reported 2026-08-10: he pressed "AI tahlil", reloaded the page, and
		// the progress panel was gone — leaving him unable to tell whether the job
		// was still running or had been cancelled. The reason is that this row said
		// nothing yet: the workflow only writes PROCESSING after it has fetched the
		// video, the owner and the org settings, which on a long recording is many
		// seconds. A reload inside that window reads `transcriptionStatus = NULL`
		// and the panel correctly renders "not started" — so a running job looks
		// like a cancelled one. `startAiGeneration` already claims its job this way
		// (QUEUED before launch); transcription was the one path that did not.
		//
		// Safe against a stuck row: the guard above turns a duplicate request into
		// "already in progress", and `api/cron/recover-stale-ai-jobs` already scans
		// for `transcriptionStatus = PROCESSING` older than the stale threshold and
		// clears it. `processingStartedAt` is what makes that staleness measurable —
		// and it is the same field the panel's ETA reads.
		// JSON_SET, not a spread of the row we read at the top of this function.
		// Between that read and here we await an owner lookup, a decrypt, an
		// upload-row check and the budget guard — several real round-trips — so a
		// spread would write back a STALE metadata object and silently revert
		// whatever a concurrent writer (retry-ai, the batch-poll cron) had set in
		// the meantime. JSON_SET merges server-side and touches only these keys.
		//
		// `aiMode` is written here for a specific reason, not for completeness:
		// recover-stale-ai-jobs picks its staleness threshold from it and treats a
		// MISSING aiMode as "fast", which is the SHORTER window. Claiming the row
		// with a start time but no mode would let the cron judge a legitimately
		// patient "cheap" job stale far too early, until the workflow's own later
		// write filled the mode in.
		const claimSpeedMode =
			speedModeOverride ??
			resolveAiSpeedMode(
				((video.metadata as VideoMetadata) || {}).aiMode ??
					result.orgSettings?.aiSpeedMode,
			);
		// The owner's per-click choice is authoritative for the WHOLE job.
		// Two starts can race (double-tap / reload+retap a few seconds apart):
		// the second call's metadata was read at the top of this function, BEFORE
		// the first call's claim landed, so its in-process resolution falls back
		// to the org default ("fast") and would silently overwrite the owner's
		// already-claimed "cheap" — the paid path spends money he chose not to.
		// So: an EXPLICIT override always wins (the owner just clicked it); a
		// start WITHOUT an override must defer, server-side, to whatever mode is
		// already claimed in the row and only fall back to the resolved default
		// when the row has none.
		await db()
			.update(videos)
			.set({
				transcriptionStatus: "PROCESSING",
				metadata: speedModeOverride
					? sql`JSON_SET(
						COALESCE(${videos.metadata}, JSON_OBJECT()),
						'$.processingStartedAt', ${new Date().toISOString()},
						'$.aiProgressAt', ${new Date().toISOString()},
						'$.aiMode', ${speedModeOverride}
					)`
					: sql`JSON_SET(
						COALESCE(${videos.metadata}, JSON_OBJECT()),
						'$.processingStartedAt', ${new Date().toISOString()},
						'$.aiProgressAt', ${new Date().toISOString()},
						'$.aiMode', COALESCE(
							JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiMode')),
							${claimSpeedMode}
						)
					)`,
			})
			.where(eq(videos.id, videoId));

		const runTranscribe = () => transcribeVideoWorkflow({
			videoId,
			userId,
			aiGenerationEnabled,
			// Only include the override when explicitly set, so the default-path
			// payload stays exactly {videoId, userId, aiGenerationEnabled}.
			...(speedModeOverride ? { speedModeOverride } : {}),
		}).catch((err) => {
			if (isAiQuotaWaitError(err)) {
				console.warn(
					`[transcribeVideo] Cheap transcription waiting for free quota for video ${videoId}:`,
					err,
				);
			} else {
				console.error(
					`[transcribeVideo] Inline workflow failed for video ${videoId}:`,
					err,
				);
			}
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

		// First-start failure: roll the claim back to "not started" so the owner
		// can click again. A RETRY must never do this — nulling the status here
		// would make a live (cron-managed) job render as "not started" on every
		// page load. The row keeps its previous status (PROCESSING/ERROR); a
		// PROCESSING row left this way has NO liveness markers (its takeover
		// cleared them, and this failure path writes none), and the recovery
		// cron's candidate SQL deliberately treats marker-less rows as
		// infinitely stale (the COALESCE(..., '') arm) — so the cron genuinely
		// re-selects it on its next tick. That SQL arm is what makes this
		// comment true; before it existed, this row was invisible forever.
		if (!isRetry) {
			await db()
				.update(videos)
				.set({ transcriptionStatus: null })
				.where(eq(videos.id, videoId));
		}

		return {
			success: false,
			message: "Failed to start transcription workflow",
		};
	}
}
