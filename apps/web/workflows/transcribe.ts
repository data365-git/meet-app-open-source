import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import {
	aiUsageEvents,
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { withCostGuard } from "@/lib/ai-cost-guard";
import {
	authorizePaidGeminiUse,
	getPaidGeminiKey,
	hasPaidGeminiKey,
} from "@/lib/gemini-paid-key";
import { shouldStartAiAfterTranscription } from "@/lib/ai-generation-request";
import {
	isQuotaLikeAiError,
	isTranscriptionQuotaFailureError,
	TranscriptionQuotaFailureError,
} from "@/lib/ai-quota-wait";
import { AI_CHUNK_CONCURRENCY, mapWithConcurrency } from "@/lib/concurrency";
import { isDeadlineError, withDeadline } from "@/lib/deadline";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import {
	checkHasAudioTrack,
	extractAudioChunksFromUrl,
	extractAudioFromUrl,
	extractAudioSpanFromUrl,
} from "@/lib/audio-extract";
import {
	extractSpeakerLabels,
	mergeChunkedWebVtt,
	rescaleChunkVtt,
	setRescaleAnchorProbe,
	transcribeWithGemini,
} from "@/lib/gemini-transcribe";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { fetchScribeWordTimes } from "@/lib/eleven-scribe";
import { startAiGeneration } from "@/lib/generate-ai";
import { restoreRussianScript } from "@/lib/restore-russian-script";
import { runPromise } from "@/lib/server";
import { isTranscriptionDisabled } from "@/lib/transcription-settings";
import { sendOpsAlert } from "@/lib/ops-alert";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import {
	copyCueTimingsByIndex,
	transferVttTimingWithStats,
} from "@/lib/vtt-timing-transfer";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	isOwnerPro: boolean;
	ownerEncryptedGeminiKey: string | null;
	orgId: string;
}

export interface ExtractedAudioChunk {
	key: string;
	url: string;
	startSec: number;
	/** Absolute time where this chunk's last speech ends (silence-anchored cuts
	 * only). The cue-rescale anchor — see rescaleChunkVtt. */
	speechEndSec?: number;
	durationSec: number | null;
}

export interface ExtractedAudio {
	chunks: ExtractedAudioChunk[];
	totalDurationSec: number | null;
}

// Free-tier transcription model, used only when GEMINI_API_KEY_FREE is set.
// gemini-3.5-flash is free-of-charge on a billing-off project and higher quality
// than the paid default; on any failure the paid path takes over.
const FREE_TRANSCRIBE_MODEL = "gemini-3.5-flash";
// (2026-07-29) The free key's per-MODEL daily quotas are separate — verified
// live: gemini-3.5-flash answered 429 (quota spent by the morning's meetings)
// while gemini-3-flash-preview on the SAME free key answered 200. Chaining a
// second free model before the paid fallback roughly doubles the free headroom;
// transcribeWithGemini's own model loop advances past a 429 (transient, not
// permanent), so the chain needs no new plumbing. Order matters: 3.5 first —
// it is the model the free tier is sized around.
const FREE_TRANSCRIBE_MODELS = [
	FREE_TRANSCRIBE_MODEL,
	"gemini-3-flash-preview",
] as const;

// Free-probe deadline for one transcription chunk (Files API upload +
// activation + generation). Every job makes exactly ONE free attempt (no
// retry backoff) under this deadline; on a quota answer or the deadline it
// continues on the paid path immediately — free first, but never waiting.
const FREE_TRANSCRIBE_PROBE_MS = 30_000;

// Chunk length is the ceiling on transcript↔audio drift: Gemini estimates (does
// not force-align) timestamps, so cues run progressively ahead within a chunk and
// only re-anchor at the next chunk's absolute start offset. Shorter chunks reset
// that drift more often. 6 min keeps enough context for speaker/term accuracy
// while capping worst-case drift far below the old 15-min value. Total audio sent
// to Gemini is unchanged (chunks don't overlap), so cost is ~flat — only the
// per-call prompt repeats. Threshold sits just above the chunk size so mid-length
// audios (which were previously one un-reset chunk) also get split.
// 2026-07-29: 6min → 3min (ladder step ① of the owner's "Gemini-only maximum
// accuracy" directive). Measured baseline on real meetings with 6-min chunks:
// median |drift| 5.7s/8.7s, max 11.7s/29.6s (48-min / 25-min). Halving the span
// halves the room the curvature has to accumulate. REVERT to 6*60 if the same
// rig shows no real improvement (rig noise ±5s — a <2×SE change is not a result).
const LONG_AUDIO_CHUNK_DURATION_SEC = 3 * 60;
const LONG_AUDIO_CHUNK_THRESHOLD_SEC = 4 * 60;
const ELEVEN_SCRIBE_COST_USD_MICROS_PER_HOUR = 220_000;

// Liveness heartbeat interval. Liveness means THE PROCESS IS STILL RUNNING,
// not "the code reached a checkpoint": extractAudioChunksFromUrl runs a full
// remote download + silencedetect decode + every per-chunk transcode inside
// ONE uninterrupted await with no progress callback, so any
// stamp-at-boundary scheme keeps a blind window as long as the slowest await
// (rounds 3-5 of the 2026-08-10 review each found one). A timer ticks
// independently of every await and covers phases not yet written. 5 min vs
// the 60-min stale threshold and 30-min cron cadence: a live job is never
// more than 5 min stale (12x margin), and a false-stale would need 11+
// consecutive stamp writes to fail — at which point the DB is down and
// recovery semantics are moot. Cost: 12 tiny row-locked writes per hour per
// ACTIVE job. The timer dies with the process, so a killed container stops
// stamping automatically — exactly the signal the recovery cron needs.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

function startTranscriptionHeartbeat(videoId: string): () => void {
	const stamp = () => {
		void patchVideoMetadata(videoId, (current) => ({
			...current,
			aiProgressAt: new Date().toISOString(),
		})).catch(() => {});
	};
	const timer = setInterval(stamp, HEARTBEAT_INTERVAL_MS);
	// Never keep the process alive just for the heartbeat.
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	const videoData = await validateVideo(videoId);

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	// Started AFTER the claim (validateVideo stamps the baseline), cleared in
	// the finally below whether the job completes, parks, or crashes — a
	// parked/dead job must stop looking alive so its recovery owner can act.
	const stopHeartbeat = startTranscriptionHeartbeat(videoId);

	let tempAudioKeys: string[] = [];

	try {
		const audio = await extractAudio(videoId, userId, videoData.video);

		if (!audio) {
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		tempAudioKeys = audio.chunks.map((chunk) => chunk.key);

		// Retry resume: reuse whatever a previous interrupted run already saved so
		// chunks that succeeded before are not re-transcribed (no wasted tokens).
		const existingPartialVtt = await loadPartialTranscription(
			videoId,
			videoData.video,
		);

		const transcription = await transcribeAudioChunks(
			audio,
			videoData.ownerEncryptedGeminiKey,
			{ userId, orgId: videoData.orgId, videoId },
			undefined,
			async (p) => {
				await savePartialTranscription(
					videoId, videoData.video, p.transcribedChunks, p.completed, p.total,
				);
			},
			existingPartialVtt,
		);

		// Merge-level gap-fill: close any hole the per-chunk retries left behind.
		const gapFill = await fillTranscriptGaps({
			videoId,
			userId,
			video: videoData.video,
			ownerEncryptedGeminiKey: videoData.ownerEncryptedGeminiKey,
			context: { userId, orgId: videoData.orgId, videoId },
			mergedVtt: transcription,
			totalDurationSec: audio.totalDurationSec,
		});

		// Ladder step ④ (probe-anchored warp) was built, deployed and MEASURED
		// on 2026-07-30 — and DISCARDED: on the 25-min meeting it accepted 8/8
		// anchors and shifted cues 5.4s, but drift got WORSE (median 6.2s→8.1s)
		// and gained a ~-4s systematic bias — the probe localization is
		// self-consistent, not ground-truth (the exact circularity the reviewer
		// warned about). Per the pre-declared "keep only if gain > 2×SE" rule it
		// is NOT wired in. The pure module (lib/vtt-probe-warp.ts) + its tests
		// stay as the documented negative result — DO NOT re-wire without a
		// human-anchored eval that beats 6.2s median / 11.0s max.
		await saveTranscription(
			videoId,
			userId,
			videoData.video,
			gapFill.transcription,
			gapFill.remainingGaps,
			audio.totalDurationSec == null,
		);
	} catch (error) {
		// No quota-parking anymore (round-8): cheap no longer throws a
		// quota-wait — each chunk falls back to paid when free is out, so any
		// error landing here is a real failure. QUOTA only when the failure was
		// TAGGED as such at its source (both free AND paid exhausted — the
		// credits-depleted case the ERROR/QUOTA backoff loop recovers). No
		// loose message sniffing: this catch also sees fs/storage errors
		// (e.g. "EDQUOT: disk quota exceeded") that would match a text regex
		// and get auto-retried forever.
		await markError(videoId, {
			code: isTranscriptionQuotaFailureError(error) ? "QUOTA" : "FAILED",
			message: error instanceof Error ? error.message : String(error),
		});
		await cleanupTempAudioKeys(tempAudioKeys, videoData.video);
		throw error;
	} finally {
		stopHeartbeat();
	}

	await cleanupTempAudioKeys(tempAudioKeys, videoData.video);

	if (await shouldQueueAiGeneration(videoId, aiGenerationEnabled)) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

export type ScribeTimingTransferResult =
	| {
			applied: true;
			vtt: string;
			stats: ReturnType<typeof transferVttTimingWithStats>["stats"];
	  }
	| {
			applied: false;
			vtt: string;
			reason: "missing_key" | "low_confidence" | "failed";
	  };

export async function applyScribeTimingTransfer(
	audio: ExtractedAudio,
	transcription: string,
	videoId: string,
	context?: { userId: string; orgId: string },
	refreshTranscription?: () => Promise<string>,
): Promise<ScribeTimingTransferResult> {
	"use step";

	if (audio.chunks.length === 0 || !serverEnv().ELEVENLABS_API_KEY) {
		return { applied: false, vtt: transcription, reason: "missing_key" };
	}

	try {
		const words = await fetchScribeWordTimes(audio.chunks);
		await recordScribeTimingUsage(audio, videoId, context).catch((error) => {
			console.log("[transcribe] scribe-transfer usage record failed", error);
		});
		const latestTranscription = refreshTranscription
			? await refreshTranscription()
			: transcription;
		const result = transferVttTimingWithStats(latestTranscription, words);
		if (result.stats.identity) {
			console.log(
				`[transcribe] scribe-transfer low confidence for ${videoId}; keeping Gemini-timed VTT`,
			);
			return {
				applied: false,
				vtt: latestTranscription,
				reason: "low_confidence",
			};
		}
		console.log(
			`[transcribe] scribe-transfer: ${result.stats.shiftedCueCount} cues shifted, mean ${result.stats.meanShiftSec.toFixed(1)}s, ${result.stats.denseMatches} dense matches`,
		);
		return { applied: true, vtt: result.vtt, stats: result.stats };
	} catch (error) {
		console.log(
			`[transcribe] scribe-transfer failed for ${videoId}; keeping Gemini-timed VTT`,
			error,
		);
		return { applied: false, vtt: transcription, reason: "failed" };
	}
}

export async function refineVideoTimestampsWorkflow(payload: {
	videoId: string;
	userId: string;
}): Promise<{ success: boolean; reason?: string }> {
	const { videoId, userId } = payload;
	let video: typeof videos.$inferSelect | undefined;
	let audio: ExtractedAudio | null = null;

	try {
		[video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));
		if (!video || video.ownerId !== userId) throw new Error("missing_transcript");
		if (!serverEnv().ELEVENLABS_API_KEY) throw new Error("missing_key");

		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
		const transcriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;
		const initialTranscript = await bucket.getObject(transcriptKey).pipe(runPromise);
		if (Option.isNone(initialTranscript)) throw new Error("missing_transcript");

		audio = await extractAudio(videoId, userId, video);
		if (!audio) throw new Error("no_audio");

		const transfer = await applyScribeTimingTransfer(
			audio,
			initialTranscript.value,
			videoId,
			{ userId, orgId: video.orgId },
			async () => {
				// Re-read after the external call so edits made while Scribe was running
				// are preserved. Only timing lines from this latest VTT are rewritten.
				const latest = await bucket.getObject(transcriptKey).pipe(runPromise);
				if (Option.isNone(latest)) throw new Error("missing_transcript");
				return latest.value;
			},
		);
		if (!transfer.applied) throw new Error(transfer.reason);

		await bucket
			.putObject(transcriptKey, transfer.vtt, { contentType: "text/vtt" })
			.pipe(runPromise);

		await syncTranslatedTranscriptTimings(video, transfer.vtt).catch((error) => {
			console.log(
				`[transcribe] translated timing sync failed for ${videoId}`,
				error,
			);
		});

		await patchVideoMetadata(videoId, (current) => ({
			...current,
			timestampRefinement: {
				status: "COMPLETE",
				requestedAt:
					current.timestampRefinement?.requestedAt ?? new Date().toISOString(),
				completedAt: new Date().toISOString(),
				model: "elevenlabs-scribe-v2",
				shiftedCueCount: transfer.stats.shiftedCueCount,
				meanShiftSec: transfer.stats.meanShiftSec,
			},
		}));

		return { success: true };
	} catch (error) {
		const rawReason = error instanceof Error ? error.message : "failed";
		const reason = isTimestampRefinementError(rawReason) ? rawReason : "failed";
		await patchVideoMetadata(videoId, (current) => ({
			...current,
			timestampRefinement: {
				status: "ERROR",
				requestedAt:
					current.timestampRefinement?.requestedAt ?? new Date().toISOString(),
				completedAt: new Date().toISOString(),
				error: reason,
			},
		})).catch(() => {});
		return { success: false, reason };
	} finally {
		if (audio && video) {
			await cleanupTempAudioKeys(
				audio.chunks.map((chunk) => chunk.key),
				video,
			);
		}
	}
}

async function syncTranslatedTranscriptTimings(
	video: typeof videos.$inferSelect,
	correctedBaseVtt: string,
): Promise<void> {
	const metadata = (video.metadata as VideoMetadata) ?? {};
	const languages = Object.keys(metadata.aiSummaryByLanguage ?? {});
	if (languages.length === 0) return;

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	for (const language of languages) {
		const key = `${video.ownerId}/${video.id}/transcription.${language}.vtt`;
		const translated = await bucket.getObject(key).pipe(runPromise);
		if (Option.isNone(translated)) continue;
		const synced = copyCueTimingsByIndex(correctedBaseVtt, translated.value);
		if (!synced) continue;
		await bucket
			.putObject(key, synced, { contentType: "text/vtt" })
			.pipe(runPromise);
	}
}

function isTimestampRefinementError(
	value: string,
): value is Exclude<
	NonNullable<VideoMetadata["timestampRefinement"]>["error"],
	undefined
> {
	return [
		"missing_key",
		"missing_transcript",
		"no_audio",
		"low_confidence",
		"failed",
	].includes(value);
}

async function recordScribeTimingUsage(
	audio: ExtractedAudio,
	videoId: string,
	context?: { userId: string; orgId: string },
): Promise<void> {
	if (!context) return;
	const durationSec = scribeBillableDurationSec(audio);
	if (durationSec == null || durationSec <= 0) return;

	await db()
		.insert(aiUsageEvents)
		.values({
			id: nanoId(),
			orgId: context.orgId as Organisation.OrganisationId,
			userId: context.userId as User.UserId,
			videoId: videoId as Video.VideoId,
			operation: "transcription",
			model: "elevenlabs-scribe-v2",
			inputTokens: 0,
			outputTokens: 0,
			costUsdMicros: Math.round(
				(durationSec / 3600) * ELEVEN_SCRIBE_COST_USD_MICROS_PER_HOUR,
			),
			billingMonth: currentBillingMonth(),
		});
}

function scribeBillableDurationSec(audio: ExtractedAudio): number | null {
	if (audio.totalDurationSec != null) return audio.totalDurationSec;
	let total = 0;
	for (const chunk of audio.chunks) {
		if (chunk.durationSec == null) return null;
		total += chunk.durationSec;
	}
	return total;
}

function currentBillingMonth(): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

async function validateVideo(videoId: string): Promise<VideoData> {
	"use step";

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
			owner: users,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled = isTranscriptionDisabled(
		result.video.settings,
		result.orgSettings,
	);

	const isOwnerPro = userIsPro(result.owner);

	console.log(
		`[transcribe] Owner check: stripeSubscriptionStatus=${result.owner.stripeSubscriptionStatus}, thirdPartyStripeSubscriptionId=${result.owner.thirdPartyStripeSubscriptionId}, isOwnerPro=${isOwnerPro}`,
	);

	// Server-side merge, NOT a spread of the metadata read at step start: a
	// duplicate/racing workflow reaching this write after another run stored
	// aiBatchJobs would revert the handle — the Batch was submitted with the
	// SERVER PAID key and the collector finds it via JSON_LENGTH($.aiBatchJobs),
	// so a reverted handle = paid work that is never collected and never
	// cancelled. JSON_REMOVE drops the keys a fresh attempt must not inherit
	// (previous run's error reason + sub-phase marker); JSON_SET writes only
	// this attempt's own claims and touches nothing else.
	const nowIso = new Date().toISOString();
	await db()
		.update(videos)
		.set({
			transcriptionStatus: "PROCESSING",
			metadata: sql`JSON_SET(
				JSON_REMOVE(
					COALESCE(${videos.metadata}, JSON_OBJECT()),
					'$.transcriptionError',
					'$.aiProcessingSubStep'
				),
				'$.aiJobStartedAt', COALESCE(
					JSON_UNQUOTE(JSON_EXTRACT(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiJobStartedAt')),
					${nowIso}
				),
				'$.aiQuotaWaiting', CAST('false' AS JSON),
				'$.processingStartedAt', ${nowIso},
				'$.aiProgressAt', ${nowIso},
				'$.aiProcessingStep', 'transcribe'
			)`,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		transcriptionDisabled,
		isOwnerPro,
		ownerEncryptedGeminiKey: result.owner.geminiApiKey ?? null,
		orgId: result.video.orgId,
	};
}

async function markSkipped(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markNoAudio(videoId: string): Promise<void> {
	"use step";

	// The no-audio verdict comes from INSIDE extractAudio, before its own
	// marker clear runs — drop the sub-phase marker so this terminal state
	// never keeps claiming "extracting audio".
	await patchVideoMetadata(videoId, (current) => ({
		...current,
		aiProcessingSubStep: undefined,
	})).catch(() => {});

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markError(
	videoId: string,
	reason: { code: "QUOTA" | "FAILED"; message: string },
): Promise<void> {
	"use step";

	// patchVideoMetadata locks the row (SELECT ... FOR UPDATE): poll-batch-jobs
	// patches the same metadata concurrently in cheap mode, and an unlocked
	// read-modify-write here would clobber it.
	await patchVideoMetadata(videoId, (current) => ({
		...current,
		// A terminal error must not keep a live-progress claim around.
		aiProcessingSubStep: undefined,
		transcriptionError: {
			code: reason.code,
			message: reason.message.slice(0, 500),
			at: new Date().toISOString(),
		},
	}));

	await db()
		.update(videos)
		.set({ transcriptionStatus: "ERROR" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<ExtractedAudio | null> {
	"use step";

	// Honest live-progress marker: the share panel may only show "extracting
	// audio" while this step is REALLY running, so the marker is written here at
	// the step's start (never guessed in the UI) and cleared once per-chunk
	// transcription progress takes over in savePartialTranscription.
	await patchVideoMetadata(videoId, (current) => ({
		...current,
		aiProcessingSubStep: "extract_audio",
	})).catch(() => {});

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

	const videoUrl = await resolveVideoSourceUrl(videoId, userId, video);

	// Media server removed — single-file MP4, no server-side processing
	const probe = await checkHasAudioTrack(videoUrl);
	console.log(
		`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${probe.hasAudio}, durationSec=${probe.durationSec}`,
	);

	if (probe.durationSec != null) {
		await db()
			.update(videos)
			.set({ duration: probe.durationSec })
			.where(eq(videos.id, videoId as Video.VideoId));
	}

	if (!probe.hasAudio) {
		return null;
	}

	const totalDurationSec = probe.durationSec ?? video.duration ?? null;

	if (
		totalDurationSec != null &&
		totalDurationSec > LONG_AUDIO_CHUNK_THRESHOLD_SEC
	) {
		const result = await extractAudioChunksFromUrl(videoUrl, {
			chunkDurationSec: LONG_AUDIO_CHUNK_DURATION_SEC,
			totalDurationSec,
		});
		const chunks: ExtractedAudioChunk[] = [];

		try {
			for (const [index, chunk] of result.chunks.entries()) {
				const audioBuffer = await fs.readFile(chunk.filePath);
				const audioKey = `${userId}/${videoId}/audio-temp-${String(index).padStart(3, "0")}.mp3`;

				await bucket
					.putObject(audioKey, audioBuffer, {
						contentType: result.mimeType,
					})
					.pipe(runPromise);

				const audioSignedUrl = await bucket
					.getInternalSignedObjectUrl(audioKey)
					.pipe(runPromise);

				chunks.push({
					key: audioKey,
					url: audioSignedUrl,
					startSec: chunk.startSec,
					speechEndSec: chunk.speechEndSec,
					durationSec: chunk.durationSec,
				});
			}

			console.log(
				`[transcribe] Extracted ${chunks.length} audio chunks for ${videoId}`,
			);

			// Extraction is over — clear the sub-phase marker HERE, not in the
			// progress callbacks (the single-chunk transcription path never fires
			// them, so a marker left set would show "extracting audio" for the
			// whole Gemini call — a lying progress line). Seeding the real chunk
			// counters in the same write hands the live line straight to honest
			// "0/N sent" data.
			await patchVideoMetadata(videoId, (current) => ({
				...current,
				aiProcessingSubStep: undefined,
				transcriptionChunksCompleted: 0,
				transcriptionChunksTotal: chunks.length,
			})).catch(() => {});

			return { chunks, totalDurationSec };
		} catch (error) {
			for (const chunk of chunks) {
				await bucket.deleteObject(chunk.key).pipe(runPromise).catch(() => {});
			}
			throw error;
		} finally {
			await result.cleanup();
		}
	}

	const result = await extractAudioFromUrl(videoUrl);

	let audioBuffer: Buffer;
	try {
		audioBuffer = await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	try {
		await bucket
			.putObject(audioKey, audioBuffer, {
				contentType: "audio/mpeg",
			})
			.pipe(runPromise);

		const audioSignedUrl = await bucket
			.getInternalSignedObjectUrl(audioKey)
			.pipe(runPromise);

		// Same honesty rule as the chunked branch above: extraction is done, so
		// the marker must go now — this single-chunk path never reaches the
		// progress callbacks that would otherwise clear it.
		await patchVideoMetadata(videoId, (current) => ({
			...current,
			aiProcessingSubStep: undefined,
			transcriptionChunksCompleted: 0,
			transcriptionChunksTotal: 1,
		})).catch(() => {});

		return {
			chunks: [
				{
					key: audioKey,
					url: audioSignedUrl,
					startSec: 0,
					durationSec: totalDurationSec,
				},
			],
			totalDurationSec,
		};
	} catch (error) {
		await bucket.deleteObject(audioKey).pipe(runPromise).catch(() => {});
		throw error;
	}
}

async function resolveVideoSourceUrl(
	videoId: string,
	_userId: string,
	video: typeof videos.$inferSelect,
): Promise<string> {
	const [resolvedBucket] =
		await getStorageAccessForVideo(video).pipe(runPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		`${video.ownerId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
		// `processVideoWorkflow` deletes the videoUploads row (rawFileKey), and
		// imported / in-app / extension uploads never produce result.mp4 — the
		// real file lives at raw-upload.{mp4,webm}. Fall back to those well-known
		// keys (same as /api/playlist) so transcription doesn't fail with
		// "Video file not accessible" once the upload row is gone.
		`${video.ownerId}/${videoId}/raw-upload.mp4`,
		`${video.ownerId}/${videoId}/raw-upload.webm`,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		const url = await resolvedBucket
			.getInternalSignedObjectUrl(key)
			.pipe(runPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

export async function transcribeAudio(
	audioUrl: string,
	audioDurationSec: number | null,
	ownerEncryptedGeminiKey: string | null,
	context: {
		userId: string;
		orgId: string;
		videoId: string;
	},
	knownSpeakers: string[] = [],
): Promise<string> {
	"use step";

	let ownerApiKey: string | undefined;

	if (ownerEncryptedGeminiKey) {
		try {
			ownerApiKey = await decrypt(ownerEncryptedGeminiKey);
		} catch {
			console.error(
				"[transcribe] Failed to decrypt user Gemini key, falling back to server key",
			);
		}
	}

	if (!ownerApiKey && !hasPaidGeminiKey()) {
		throw new FatalError(
			"No Gemini API key configured. Set one in Settings → Account → Transcription API Keys, or ask your admin to set GEMINI_API_KEY.",
		);
	}

	// ONE synchronous path (owner, 2026-08-13 — the fast/cheap chooser is
	// deleted): a bounded free probe first, then the paid call immediately on
	// genuine quota exhaustion or the probe deadline. The next chunk tries
	// free again, so the job returns to free the moment quota comes back. No
	// parking, no Batch, no collector, no waiting.
	const runPaidSync = async (syncKey: string): Promise<string> => {
		const result = await withCostGuard({
			orgId: context.orgId,
			userId: context.userId,
			videoId: context.videoId,
			operation: "transcription",
			model: "gemini-3-flash-preview",
			fn: async () => {
				const res = await transcribeWithGemini(audioUrl, {
					apiKey: syncKey,
					audioDurationSec: audioDurationSec ?? undefined,
					knownSpeakers,
				});
				return {
					transcriptVtt: res.transcriptVtt,
					inputTokens: res.inputTokens,
					outputTokens: res.outputTokens,
					audioInTokens: res.audioInTokens,
					// transcribeWithGemini can fall back past the requested primary
					// model on overload (GEMINI_TRANSCRIBE_MODELS chain) — pass through
					// which one actually ran so withCostGuard prices/records THAT model,
					// not the "gemini-3-flash-preview" literal above.
					modelUsed: res.modelUsed,
				};
			},
		});
		return result.transcriptVtt;
	};

	const runSync = async (): Promise<string> => {
		const freeKey = serverEnv().GEMINI_API_KEY_FREE;
		if (freeKey) {
			try {
				const freeResult = await withCostGuard({
					orgId: context.orgId,
					userId: context.userId,
					videoId: context.videoId,
					operation: "transcription",
					model: FREE_TRANSCRIBE_MODEL,
					free: true,
					fn: async () => {
						// Exactly one free attempt, no backoff, under a real deadline
						// that aborts the in-flight fetches — free first, never waiting.
						const runFree = (signal?: AbortSignal) =>
							transcribeWithGemini(audioUrl, {
								apiKey: freeKey,
								audioDurationSec: audioDurationSec ?? undefined,
								knownSpeakers,
								models: FREE_TRANSCRIBE_MODELS,
								maxAttempts: 1,
								signal,
							});
						const res = await withDeadline(FREE_TRANSCRIBE_PROBE_MS, runFree);
						return {
							transcriptVtt: res.transcriptVtt,
							inputTokens: res.inputTokens,
							outputTokens: res.outputTokens,
							audioInTokens: res.audioInTokens,
							modelUsed: res.modelUsed,
						};
					},
				});
				return freeResult.transcriptVtt;
			} catch (error) {
				if (!isQuotaLikeAiError(error) && !isDeadlineError(error)) {
					// A NON-quota, non-deadline free failure (revoked key, safety
					// block, malformed response) is a real ERROR: rethrow so the
					// chunk retry machinery handles it — free quota is intact and
					// must not be silently billed on the paid path.
					throw error;
				}
				// Quota answer or probe deadline: continue on paid, no waiting.
				console.warn(
					`[transcribe] free-tier (${FREE_TRANSCRIBE_MODEL}) attempt failed for video=${context.videoId}, falling back to paid: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Synchronous paid call, reached only when the free chain was given its
		// chance: quota-exhausted, probe deadline, or no free key at all. The
		// authorization is checked BEFORE resolving any key — the owner's
		// personal key passes the exact same gate.
		const paidUse = {
			operation: "transcription" as const,
			route: "sync" as const,
			// FACT: no free key, a genuine quota signal, or the probe deadline —
			// every other free failure rethrew above and never reaches here.
			freeAttempted: true,
		};
		authorizePaidGeminiUse(paidUse);
		const resolvedApiKey = ownerApiKey ?? getPaidGeminiKey(paidUse);
		if (!resolvedApiKey) {
			throw new FatalError(
				"No Gemini API key configured. Set one in Settings → Account → Transcription API Keys, or ask your admin to set GEMINI_API_KEY.",
			);
		}
		return runPaidSync(resolvedApiKey);
	};

	return runSync();
}


export async function transcribeAudioChunks(
	audio: ExtractedAudio,
	ownerEncryptedGeminiKey: string | null,
	context: { userId: string; orgId: string; videoId: string },
	transcribeChunk: typeof transcribeAudioChunkWithRetry = transcribeAudioChunkWithRetry,
	onProgress?: (p: { transcribedChunks: Array<{ vtt: string; offsetSec: number }>; completed: number; total: number }) => Promise<void>,
	existingPartialVtt?: string,
): Promise<string> {
	// Partial checkpoint present + non-empty (a prior run or a collected Batch
	// chunk). Shared by the single-chunk and multi-chunk paths.
	const hasUsablePartial =
		typeof existingPartialVtt === "string" &&
		existingPartialVtt.trim().length > 0 &&
		!/^WEBVTT\s*$/.test(existingPartialVtt.trim());

	if (audio.chunks.length === 1) {
		const chunk = audio.chunks[0];
		if (!chunk) return "WEBVTT\n\n";
		const chunkDurationSec = chunk.durationSec ?? audio.totalDurationSec ?? 0;
		// After a Batch collection re-kick the single chunk is already covered by
		// the saved partial — reuse it instead of re-transcribing (spec §5 C2).
		if (
			hasUsablePartial &&
			isChunkCoveredByPartial(
				existingPartialVtt as string,
				chunk.startSec,
				chunkDurationSec,
			)
		) {
			return restoreRussianScript(existingPartialVtt as string);
		}
		try {
			return restoreRussianScript(
				await transcribeAudio(
					chunk.url,
					chunk.durationSec ?? audio.totalDurationSec,
					ownerEncryptedGeminiKey,
					context,
				),
			);
		} catch (error) {
			// Fast mode, single chunk: this path never reaches the per-chunk catch
			// or the all-failed throw below, so it must tag the quota case itself —
			// otherwise short videos (the common case) lose their reason.
			if (isQuotaLikeAiError(error)) {
				throw new TranscriptionQuotaFailureError(
					`Transcription quota/credits exhausted for ${context.videoId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			throw error;
		}
	}

	let failedChunkCount = 0;
	// Subset of failedChunkCount whose cause was quota/credits. When it equals
	// failedChunkCount on a total failure, the job died for money, not content.
	let quotaFailedChunkCount = 0;
	let completedCount = 0;
	let reusedChunkCount = 0;
	const completedResults = new Array<{ vtt: string; offsetSec: number } | undefined>(
		audio.chunks.length,
	);

	// Retry resume: an earlier interrupted run (or a collected Batch chunk) may
	// have saved a partial merged transcript. Seed the result with it (offsetSec
	// 0 = already absolute, the same pattern fillTranscriptGaps uses) so every
	// chunk it already covers is skipped below — a retry never re-bills Gemini.
	const hasPartial = hasUsablePartial;
	const seedParts: Array<{ vtt: string; offsetSec: number }> = hasPartial
		? [{ vtt: existingPartialVtt as string, offsetSec: 0 }]
		: [];

	const fireProgress = async (): Promise<void> => {
		if (!onProgress) return;
		try {
			await onProgress({
				transcribedChunks: [
					...seedParts,
					...completedResults.filter(
						(r): r is { vtt: string; offsetSec: number } => r !== undefined,
					),
				],
				completed: completedCount,
				total: audio.chunks.length,
			});
		} catch (e) {
			console.error("[transcribe] partial-save progress callback failed (non-fatal):", e);
		}
	};

	// Worker shared by the serial first chunk and the concurrent rest — keeps
	// the fault-tolerance, progress-callback and result-indexing behavior
	// identical for every chunk.
	const processChunk = async (
		chunk: ExtractedAudioChunk,
		i: number,
		knownSpeakers: string[],
	): Promise<{ vtt: string; offsetSec: number }> => {
		// Already transcribed by a previous run — reuse from the seed, no API call.
		if (
			hasPartial &&
			isChunkCoveredByPartial(
				existingPartialVtt as string,
				chunk.startSec,
				chunk.durationSec ?? 0,
			)
		) {
			reusedChunkCount++;
			completedResults[i] = undefined; // its cues come from seedParts
			completedCount++;
			await fireProgress();
			return { vtt: "WEBVTT\n\n", offsetSec: chunk.startSec };
		}
		let result: { vtt: string; offsetSec: number };
		try {
			const vtt = await transcribeChunk({
				chunk,
				ownerEncryptedGeminiKey,
				context,
				knownSpeakers,
			});
			// DRIFT FIX (measured 2026-07-19 on a real 42-min recording): Gemini's
			// within-chunk clock runs at a near-constant fraction of real time
			// (~0.64 there) and re-anchors only at the next chunk, so cues run
			// further and further AHEAD of the audio — up to 120s inside a single
			// 6-min chunk. The error is linear, so one linear stretch removes it
			// (see rescaleChunkVtt for the measurement table). Anchor on where
			// speech actually ends: boundaries sit on speech ONSETS, so a chunk
			// normally ends in silence and stretching to the nominal duration would
			// push cues late; fall back to the duration only on a fallback cut.
			const speechSpanSec =
				chunk.speechEndSec != null
					? chunk.speechEndSec - chunk.startSec
					: (chunk.durationSec ?? 0);
			// Diagnostic: record what a distribution-based anchor would have seen
			// for THIS chunk (see the probe comment in rescaleChunkVtt). Scoped to
			// the call so concurrent chunks cannot mix their numbers up.
			setRescaleAnchorProbe((stats) => {
				console.log(
					`[transcribe] chunk@${chunk.startSec}s anchor-probe cues=${stats.cueCount} last=${stats.lastEnd.toFixed(1)} 2nd=${stats.secondLast.toFixed(1)} p90=${stats.p90.toFixed(1)} span=${stats.speechSpanSec.toFixed(1)} gapBeforeLast=${stats.gapBeforeLast.toFixed(1)}`,
				);
			});
			const rescaled = rescaleChunkVtt(vtt, speechSpanSec);
			setRescaleAnchorProbe(undefined);
			if (rescaled.applied) {
				console.log(
					`[transcribe] chunk@${chunk.startSec}s cue-rescale x${rescaled.factor.toFixed(3)} (speech span ${speechSpanSec.toFixed(0)}s)`,
				);
			} else {
				// Log the SKIP too. Silence here cost a real investigation on
				// 2026-07-20: a drift re-measure showed two bad samples, and the only
				// way to find out that their chunk had been skipped was to count the
				// "applied" lines (7) against the extracted chunks (9) and infer the
				// gap. A skipped chunk keeps the full drift, so it is exactly the
				// thing worth seeing.
				console.log(
					`[transcribe] chunk@${chunk.startSec}s cue-rescale SKIPPED reason=${rescaled.reason} factor=${rescaled.factor.toFixed(3)} (speech span ${speechSpanSec.toFixed(0)}s)`,
				);
			}
			result = { vtt: rescaled.vtt, offsetSec: chunk.startSec };
		} catch (error) {
			// FAULT TOLERANCE (long-video fix): a single bad chunk must NOT discard the
			// whole transcript. Previously one failed chunk threw -> the outer catch marked
			// the ENTIRE video ERROR and dropped every successful chunk (root cause of
			// long-video AI failures). Now: log, keep a gap at this offset, and continue.
			failedChunkCount++;
			if (isQuotaLikeAiError(error)) quotaFailedChunkCount++;
			console.error(
				`[transcribe] Chunk at ${chunk.startSec}s FAILED for ${context.videoId} after retries; continuing with a gap:`,
				error,
			);
			result = { vtt: "WEBVTT\n\n", offsetSec: chunk.startSec };
		}
		completedResults[i] = result;
		completedCount++;
		await fireProgress();
		return result;
	};

	// SPEAKER ROSTER CARRY: transcribe the FIRST chunk alone and harvest any
	// real speaker names it identified; every later chunk gets that roster so
	// labels stay consistent across independently-transcribed chunks.
	const firstChunk = audio.chunks[0];
	let knownSpeakers: string[] = [];
	if (firstChunk) {
		const firstResult = await processChunk(firstChunk, 0, []);
		knownSpeakers = extractSpeakerLabels(firstResult.vtt);
		// If the first chunk was reused from the partial (empty freshly-transcribed
		// vtt), harvest the speaker roster from the partial itself instead.
		if (knownSpeakers.length === 0 && hasPartial) {
			knownSpeakers = extractSpeakerLabels(existingPartialVtt as string);
		}
		if (knownSpeakers.length > 0) {
			console.log(
				`[transcribe] speaker roster for ${context.videoId}: ${knownSpeakers.join(", ")}`,
			);
		}
	}

	// Cheap mode transcribes one chunk at a time: serial chunks maximize FREE
	// usage — each chunk sees the freshest quota state, so a quota that
	// returns mid-job is used immediately instead of several parallel chunks
	// all falling to paid at once. Fast mode keeps the normal concurrency.
	const chunkConcurrency =
		AI_CHUNK_CONCURRENCY;
	await mapWithConcurrency(
		audio.chunks.slice(1),
		chunkConcurrency,
		(chunk, sliceIndex) => processChunk(chunk, sliceIndex + 1, knownSpeakers),
	);

	const transcribedChunks: Array<{ vtt: string; offsetSec: number }> = [
		...seedParts,
		...completedResults.filter(
			(r): r is { vtt: string; offsetSec: number } => r !== undefined,
		),
	];

	if (reusedChunkCount > 0) {
		console.log(
			`[transcribe] resume: reused ${reusedChunkCount}/${audio.chunks.length} chunk(s) from saved partial for ${context.videoId} (no re-transcription).`,
		);
	}

	// Only fail the whole job if EVERY chunk failed (nothing usable to save).
	// Reused chunks count as usable, so a partial seed alone keeps the job alive.
	if (failedChunkCount === audio.chunks.length) {
		// Every chunk died for quota/credits => the account is out of money, not
		// the video broken. Tag it so markError records a QUOTA reason and the
		// recovery cron can re-run this video once credits return.
		if (quotaFailedChunkCount === failedChunkCount) {
			throw new TranscriptionQuotaFailureError(
				`All ${failedChunkCount} transcription chunks failed for ${context.videoId}: AI quota/credits exhausted`,
			);
		}
		throw new Error(
			`All ${failedChunkCount} transcription chunks failed for ${context.videoId}`,
		);
	}
	if (failedChunkCount > 0) {
		console.warn(
			`[transcribe] ${failedChunkCount}/${audio.chunks.length} chunks failed for ${context.videoId}; saved a partial transcript.`,
		);
		// VISIBLE, not silent (round-10 #4): a cheap job with a broken free key
		// and a resumed partial otherwise COMPLETEs looking finished while every
		// un-transcribed chunk is a permanent gap (cheap gap-fill is free-only).
		// The gaps are already recorded in metadata.transcriptionGaps; this
		// alert is the human-facing signal that a "finished" transcript shipped
		// with holes and why.
		await sendOpsAlert(
			`Transcription for ${context.videoId} completed PARTIALLY: ${failedChunkCount}/${audio.chunks.length} chunk(s) failed and remain as gaps`,
		).catch(() => {});
	}

	return restoreRussianScript(mergeChunkedWebVtt(transcribedChunks));
}

/**
 * How far into a chunk the cues actually reach (seconds) — measured by the
 * latest cue START, or 0 if it has no cues. We deliberately use START, not END:
 * Gemini sometimes emits a runaway END (a cue ending 60 min later), which would
 * make an END-based measure look fully-covered while the chunk really stopped
 * transcribing after 1 minute. START is immune to that and detects the
 * silent-gap bug (a 15-min chunk whose cues stop a few minutes in).
 */
export function webVttCoverageSec(vtt: string): number {
	let maxStart = 0;
	for (const line of vtt.split(/\r?\n/)) {
		const arrow = line.indexOf("-->");
		if (arrow === -1) continue;
		const m = line
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		const start =
			(m[1] ? Number(m[1]) : 0) * 3600 +
			Number(m[2]) * 60 +
			Number(m[3]) +
			Number(m[4]) / 1000;
		if (start > maxStart) maxStart = start;
	}
	return maxStart;
}

/** A chunk whose cues cover less than this fraction of its duration is treated
 * as grossly incomplete (retry it). 0.5 tolerates normal trailing silence. */
export const MIN_CHUNK_COVERAGE = 0.5;

/**
 * The largest silent hole (seconds) tolerated INSIDE a chunk — measured from the
 * chunk start to its first cue, and between consecutive cue starts. Trailing
 * silence (after the last cue) is ignored. A hole bigger than this means Gemini
 * skipped a stretch of speech (the "first 14 minutes missing" bug), which the
 * reach-based coverage metric can't see: a single cue near the chunk END makes
 * `webVttCoverageSec` look ~fully covered while everything before it is blank.
 * 120s is well above a normal meeting pause but far below a dropped section.
 */
export const MAX_CHUNK_GAP_SEC = 120;

/**
 * The largest leading/internal gap (seconds) in a chunk's cue timeline. Returns
 * the whole chunk duration when there are no cues at all. Trailing silence is
 * intentionally NOT counted (a chunk can legitimately end quiet).
 */
export function webVttLargestGapSec(
	vtt: string,
	chunkDurationSec: number,
): number {
	const starts: number[] = [];
	for (const line of vtt.split(/\r?\n/)) {
		const arrow = line.indexOf("-->");
		if (arrow === -1) continue;
		const m = line
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		starts.push(
			(m[1] ? Number(m[1]) : 0) * 3600 +
				Number(m[2]) * 60 +
				Number(m[3]) +
				Number(m[4]) / 1000,
		);
	}
	if (starts.length === 0) return chunkDurationSec > 0 ? chunkDurationSec : 0;
	starts.sort((a, b) => a - b);
	// Leading gap: chunk start (0) → first cue.
	let largest = starts[0] ?? 0;
	for (let i = 1; i < starts.length; i++) {
		const gap = (starts[i] ?? 0) - (starts[i - 1] ?? 0);
		if (gap > largest) largest = gap;
	}
	return largest;
}

/**
 * Retry-resume gate: does an already-saved partial transcript ALREADY cover this
 * chunk's absolute time range well enough to SKIP re-transcribing it? Uses the
 * exact same "well covered" definition as transcribeAudioChunkWithRetry (cues
 * reach ≥ MIN_CHUNK_COVERAGE of the duration AND no leading/internal hole bigger
 * than MAX_CHUNK_GAP_SEC), measured over the partial's cues that fall inside
 * [startSec, startSec+durationSec). This is what lets a retry continue from where
 * a previous interrupted run stopped instead of re-billing Gemini for chunks
 * that already succeeded.
 */
export function isChunkCoveredByPartial(
	partialVtt: string,
	startSec: number,
	durationSec: number,
): boolean {
	if (durationSec <= 0) return false;
	const endSec = startSec + durationSec;
	const relStarts: number[] = [];
	for (const line of partialVtt.split(/\r?\n/)) {
		const arrow = line.indexOf("-->");
		if (arrow === -1) continue;
		const m = line
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		const abs =
			(m[1] ? Number(m[1]) : 0) * 3600 +
			Number(m[2]) * 60 +
			Number(m[3]) +
			Number(m[4]) / 1000;
		if (abs >= startSec && abs < endSec) relStarts.push(abs - startSec);
	}
	if (relStarts.length === 0) return false;
	relStarts.sort((a, b) => a - b);
	const reach = relStarts[relStarts.length - 1] ?? 0;
	let largestGap = relStarts[0] ?? 0; // leading gap: chunk start → first cue
	for (let i = 1; i < relStarts.length; i++) {
		const gap = (relStarts[i] ?? 0) - (relStarts[i - 1] ?? 0);
		if (gap > largestGap) largestGap = gap;
	}
	return (
		reach >= durationSec * MIN_CHUNK_COVERAGE && largestGap <= MAX_CHUNK_GAP_SEC
	);
}

export interface VttGap {
	startSec: number;
	endSec: number;
}

/**
 * All holes bigger than minGapSec in a MERGED (absolute-timestamped) VTT:
 * leading (0 → first cue start), internal (between consecutive cue starts),
 * and — unlike the per-chunk metric — TRAILING (last cue start → total
 * duration) when the real duration is known. This is the merge-level "did the
 * final transcript actually cover the whole video" measure that per-chunk
 * checks can never provide (a wholly-failed chunk merges in as silence).
 */
export function findVttGaps(
	vtt: string,
	totalDurationSec: number | null,
	minGapSec: number = MAX_CHUNK_GAP_SEC,
): VttGap[] {
	const starts: number[] = [];
	for (const line of vtt.split(/\r?\n/)) {
		const arrow = line.indexOf("-->");
		if (arrow === -1) continue;
		const m = line
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		starts.push(
			(m[1] ? Number(m[1]) : 0) * 3600 +
				Number(m[2]) * 60 +
				Number(m[3]) +
				Number(m[4]) / 1000,
		);
	}
	starts.sort((a, b) => a - b);

	const gaps: VttGap[] = [];
	if (starts.length === 0) {
		if (totalDurationSec != null && totalDurationSec > minGapSec) {
			gaps.push({ startSec: 0, endSec: totalDurationSec });
		}
		return gaps;
	}
	const first = starts[0] ?? 0;
	if (first > minGapSec) gaps.push({ startSec: 0, endSec: first });
	for (let i = 1; i < starts.length; i++) {
		const prev = starts[i - 1] ?? 0;
		const cur = starts[i] ?? 0;
		if (cur - prev > minGapSec) gaps.push({ startSec: prev, endSec: cur });
	}
	const last = starts[starts.length - 1] ?? 0;
	if (totalDurationSec != null && totalDurationSec - last > minGapSec) {
		gaps.push({ startSec: last, endSec: totalDurationSec });
	}
	return gaps;
}

/**
 * Keeps only the cues of `vtt` whose ABSOLUTE start time (relative start +
 * offsetSec) falls strictly inside (minAbsStartSec, maxAbsStartSec). Used to
 * drop recovered gap-fill cues that land on top of an existing good cue's
 * boundary — see the boundary-damage note on `fillTranscriptGaps`. Relative
 * timestamps in kept cue blocks are left unchanged; only whole cues are
 * dropped.
 */
export function filterVttCuesByAbsoluteStart(
	vtt: string,
	offsetSec: number,
	minAbsStartSec: number,
	maxAbsStartSec: number,
): string {
	const blocks = vtt.split(/\r?\n\r?\n/);
	const kept: string[] = [];

	for (const block of blocks) {
		const lines = block
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);

		if (lines.length === 0 || /^WEBVTT/i.test(lines[0] ?? "")) {
			continue;
		}

		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex === -1) continue;

		const timingLine = lines[timingIndex] ?? "";
		const arrow = timingLine.indexOf("-->");
		const m = timingLine
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;

		const start =
			(m[1] ? Number(m[1]) : 0) * 3600 +
			Number(m[2]) * 60 +
			Number(m[3]) +
			Number(m[4]) / 1000;
		const absStart = start + offsetSec;

		if (absStart > minAbsStartSec && absStart < maxAbsStartSec) {
			kept.push(block);
		}
	}

	return kept.length > 0 ? `WEBVTT\n\n${kept.join("\n\n")}\n\n` : "WEBVTT\n\n";
}

/** Gap-fill spans are deliberately SHORT: Gemini is far more reliable on ≤5-min
 * audio than on the 15-min chunks that produced the hole in the first place. */
export const GAP_FILL_SPAN_SEC = 5 * 60;
/** Upper bound on gap-fill work per video (12 spans = 1h of re-transcription). */
export const MAX_GAP_FILL_SPANS = 12;

interface GapSpanAudio {
	key: string;
	url: string;
	startSec: number;
	durationSec: number;
	gapStartSec: number;
	gapEndSec: number;
}

async function extractGapSpanAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	spans: Array<{
		startSec: number;
		durationSec: number;
		gapStartSec: number;
		gapEndSec: number;
	}>,
): Promise<GapSpanAudio[]> {
	"use step";

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const videoUrl = await resolveVideoSourceUrl(videoId, userId, video);

	const out: GapSpanAudio[] = [];
	for (const span of spans) {
		// One failed span must not kill the whole gap-fill pass.
		let uploadedKey: string | null = null;
		try {
			const result = await extractAudioSpanFromUrl(
				videoUrl,
				span.startSec,
				span.durationSec,
			);
			try {
				const audioBuffer = await fs.readFile(result.filePath);
				const key = `${userId}/${videoId}/audio-gap-${Math.round(span.startSec)}.mp3`;
				await bucket
					.putObject(key, audioBuffer, { contentType: "audio/mpeg" })
					.pipe(runPromise);
				uploadedKey = key;
				const url = await bucket
					.getInternalSignedObjectUrl(key)
					.pipe(runPromise);
				out.push({
					key,
					url,
					startSec: span.startSec,
					durationSec: span.durationSec,
					gapStartSec: span.gapStartSec,
					gapEndSec: span.gapEndSec,
				});
			} finally {
				await result.cleanup();
			}
		} catch (error) {
			console.warn(
				`[transcribe] gap-fill span extraction at ${span.startSec}s failed for ${videoId}; skipping span`,
				error,
			);
			// The object may have been uploaded before signing failed — clean it up
			// rather than leaking an orphaned temp file in R2.
			if (uploadedKey) {
				await bucket
					.deleteObject(uploadedKey)
					.pipe(runPromise)
					.catch(() => {});
			}
		}
	}
	return out;
}

/**
 * Merge-level safety net for the "dropped section" class: whatever holes the
 * per-chunk retries left in the FINAL merged transcript get re-transcribed in
 * short spans and merged back in. Holes that survive (genuine silence or
 * persistent ASR failure) are returned so the caller can RECORD them instead
 * of silently shipping a gapped transcript as complete.
 */
export async function fillTranscriptGaps(
	{
		videoId,
		userId,
		video,
		ownerEncryptedGeminiKey,
		context,
		mergedVtt,
		totalDurationSec,
	}: {
		videoId: string;
		userId: string;
		video: typeof videos.$inferSelect;
		ownerEncryptedGeminiKey: string | null;
		context: { userId: string; orgId: string; videoId: string };
		mergedVtt: string;
		totalDurationSec: number | null;
	},
	deps: {
		extractSpans?: typeof extractGapSpanAudio;
		transcribeFn?: typeof transcribeAudio;
		cleanupFn?: typeof cleanupTempAudioKeys;
	} = {},
): Promise<{ transcription: string; remainingGaps: VttGap[] }> {
	const extractSpans = deps.extractSpans ?? extractGapSpanAudio;
	const transcribeFn = deps.transcribeFn ?? transcribeAudio;
	const cleanupFn = deps.cleanupFn ?? cleanupTempAudioKeys;

	const gaps = findVttGaps(mergedVtt, totalDurationSec);
	if (gaps.length === 0) {
		return { transcription: mergedVtt, remainingGaps: [] };
	}

	const spans: Array<{
		startSec: number;
		durationSec: number;
		gapStartSec: number;
		gapEndSec: number;
	}> = [];
	for (const gap of gaps) {
		for (let s = gap.startSec; s < gap.endSec; s += GAP_FILL_SPAN_SEC) {
			if (spans.length >= MAX_GAP_FILL_SPANS) break;
			spans.push({
				startSec: s,
				durationSec: Math.min(GAP_FILL_SPAN_SEC, gap.endSec - s),
				gapStartSec: gap.startSec,
				gapEndSec: gap.endSec,
			});
		}
	}
	console.warn(
		`[transcribe] gap-fill for ${videoId}: ${gaps.length} gap(s) -> ${spans.length} span(s): ${JSON.stringify(gaps.map((g) => [Math.round(g.startSec), Math.round(g.endSec)]))}`,
	);

	let spanAudios: GapSpanAudio[];
	try {
		spanAudios = await extractSpans(videoId, userId, video, spans);
	} catch (error) {
		console.error(
			`[transcribe] gap-fill audio extraction failed for ${videoId}; keeping gapped transcript`,
			error,
		);
		return { transcription: mergedVtt, remainingGaps: gaps };
	}

	const parts: Array<{ vtt: string; offsetSec: number }> = [
		{ vtt: mergedVtt, offsetSec: 0 },
	];
	await mapWithConcurrency(spanAudios, AI_CHUNK_CONCURRENCY, async (span) => {
		try {
			const vtt = await transcribeFn(
				span.url,
				span.durationSec,
				ownerEncryptedGeminiKey,
				// Gap-fill takes the same single path as every chunk: free probe
				// first, paid continuation on exhaustion or the deadline. A real
				// failure lands in the catch below and the span stays a gap.
				context,
			);
			// Boundary protection: an internal gap's startSec IS the previous good
			// cue's start (gaps are measured cue-START to cue-START), so a
			// recovered cue landing at/near relative 0 would sit at or just after
			// that good cue's start — mergeChunkedWebVtt would then clamp the good
			// cue's end down to it, shrinking a real caption to ~0.1s. Drop any
			// recovered cue that isn't strictly INSIDE its parent gap. A leading
			// gap (gapStartSec === 0) has no preceding cue to protect, so a cue at
			// absolute 0 is kept.
			const minAbs = span.gapStartSec === 0 ? -1 : span.gapStartSec + 1;
			const maxAbs = span.gapEndSec - 0.25;
			const filteredVtt = filterVttCuesByAbsoluteStart(
				vtt,
				span.startSec,
				minAbs,
				maxAbs,
			);
			parts.push({ vtt: filteredVtt, offsetSec: span.startSec });
		} catch (error) {
			// NO rethrow, quota-wait included (round-7 #2): gap-fill is an
			// OPTIONAL improvement pass over an already-complete transcript, and
			// its spans are never submitted to Batch — parking here threw away a
			// fully transcribed video over a transient free-tier error and burned
			// a day of ladder re-kicks. A failed span simply stays a gap.
			console.warn(
				`[transcribe] gap-fill span at ${span.startSec}s failed for ${videoId} (kept as a gap)`,
				error,
			);
		}
	});

	await cleanupFn(spanAudios.map((s) => s.key), video);

	const filled =
		parts.length > 1
			? restoreRussianScript(mergeChunkedWebVtt(parts))
			: mergedVtt;
	const remainingGaps = findVttGaps(filled, totalDurationSec);
	if (remainingGaps.length > 0) {
		console.warn(
			`[transcribe] gap-fill for ${videoId}: ${remainingGaps.length} gap(s) REMAIN (recorded in metadata): ${JSON.stringify(remainingGaps.map((g) => [Math.round(g.startSec), Math.round(g.endSec)]))}`,
		);
	}
	return { transcription: filled, remainingGaps };
}

export async function transcribeAudioChunkWithRetry(
	{
		chunk,
		ownerEncryptedGeminiKey,
		context,
		knownSpeakers,
	}: {
		chunk: ExtractedAudioChunk;
		ownerEncryptedGeminiKey: string | null;
		context: { userId: string; orgId: string; videoId: string };
		knownSpeakers?: string[];
	},
	transcribeFn: typeof transcribeAudio = transcribeAudio,
): Promise<string> {
	const maxAttempts = 4;
	let lastError: unknown;
	// Keep the BEST result across attempts so a retry can only improve, never
	// lose a partial we already have. "Best" = highest reach with the smallest
	// internal gap (reach − largestGap), so a denser transcript beats one that
	// merely reaches further with a big hole in it.
	let bestVtt: string | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;
	const chunkDurationSec = chunk.durationSec ?? 0;
	const needSec =
		chunkDurationSec > 0 ? chunkDurationSec * MIN_CHUNK_COVERAGE : 0;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const vtt = await transcribeFn(
				chunk.url,
				chunk.durationSec,
				ownerEncryptedGeminiKey,
				context,
				knownSpeakers ?? [],
			);
			const coverage = webVttCoverageSec(vtt);
			const largestGap = webVttLargestGapSec(vtt, chunkDurationSec);
			const score = coverage - largestGap;
			if (score > bestScore) {
				bestScore = score;
				bestVtt = vtt;
			}
			// Under-covered if cues stop early OR a big hole was skipped mid-chunk
			// (the leading/internal-gap bug the reach metric alone can't see).
			const wellCovered =
				coverage >= needSec && largestGap <= MAX_CHUNK_GAP_SEC;
			if (wellCovered || attempt === maxAttempts) {
				if (!wellCovered) {
					console.warn(
						`[transcribe] Chunk at ${chunk.startSec}s for ${context.videoId} under-covered after ${attempt} attempts: cues reach ${coverage.toFixed(0)}s of ${chunk.durationSec}s, largest gap ${largestGap.toFixed(0)}s — keeping best partial (a transcript gap will remain here).`,
					);
				}
				return bestVtt ?? vtt;
			}
			console.warn(
				`[transcribe] Chunk at ${chunk.startSec}s for ${context.videoId} under-covered (reach ${coverage.toFixed(0)}s/${chunk.durationSec}s, largest gap ${largestGap.toFixed(0)}s) on attempt ${attempt}; retrying for fuller coverage.`,
			);
		} catch (error) {
			lastError = error;
			if (error instanceof FatalError || attempt === maxAttempts) {
				break;
			}
			console.warn(
				`[transcribe] Retrying audio chunk at ${chunk.startSec}s for ${context.videoId} after failed attempt ${attempt}`,
			);
		}
	}

	// If some attempt produced a (partial) transcript, keep it rather than
	// discarding everything — a partial is better than a fully-missing chunk.
	if (bestVtt !== null) return bestVtt;
	throw lastError;
}

/**
 * Read the partial transcript a previous interrupted run left in storage, if
 * any. Missing file (fresh first run) or any read error → undefined, so the
 * caller simply transcribes everything from scratch (no behavior change).
 */
async function loadPartialTranscription(
	videoId: string,
	video: typeof videos.$inferSelect,
): Promise<string | undefined> {
	"use step";

	try {
		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
		const content = await bucket
			.getObject(`${video.ownerId}/${videoId}/transcription-partial.vtt`)
			.pipe(runPromise);
		if (Option.isNone(content)) return undefined;
		const vtt = content.value;
		return vtt.trim().length > 0 ? vtt : undefined;
	} catch {
		return undefined;
	}
}

async function savePartialTranscription(
	videoId: string,
	video: typeof videos.$inferSelect,
	transcribedChunks: Array<{ vtt: string; offsetSec: number }>,
	completed: number,
	total: number,
): Promise<void> {
	"use step";
	const merged = mergeChunkedWebVtt(transcribedChunks);
	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	await bucket
		.putObject(`${video.ownerId}/${videoId}/transcription-partial.vtt`, merged, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);
	// Re-read metadata to avoid clobbering concurrent writes.
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	await db()
		.update(videos)
		.set({
			metadata: {
				...((row?.metadata as VideoMetadata) || {}),
				transcriptionChunksCompleted: completed,
				transcriptionChunksTotal: total,
				// Chunk progress is now the live truth — the audio-extraction
				// sub-phase is over (undefined keys are dropped on JSON serialize).
				aiProcessingSubStep: undefined,
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function saveTranscription(
	videoId: string,
	_userId: string,
	video: typeof videos.$inferSelect,
	transcription: string,
	remainingGaps: VttGap[] = [],
	coverageUnknown = false,
): Promise<void> {
	"use step";

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

	await bucket
		.putObject(`${video.ownerId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	const md = { ...((row?.metadata as VideoMetadata) || {}) } as VideoMetadata;
	delete (md as any).transcriptionChunksCompleted;
	delete (md as any).transcriptionChunksTotal;
	delete md.aiProcessingSubStep;
	delete md.aiQuotaWaiting;
	// Success ends the quota episode: drop the reason AND the retry budget, so a
	// future outage starts from a full budget instead of an exhausted counter.
	delete md.transcriptionError;
	delete md.quotaRetryAttempts;
	delete md.quotaRetryNextAt;
	// Success also refunds the FREE auto-recover budget (round-4 #5): the
	// counter is only ever incremented by the recovery cron, so leaving it
	// meant a video that once used its retries started every LATER cheap job
	// at attempts=2 and went straight to the paid flip with zero free
	// re-kicks — against the owner's explicit cheap choice.
	delete md.autoRecoverAttempts;
	// Terminal transcription: drop the job's 4h clock so a LATER brand-new
	// analysis does not inherit this completed job's timestamp and immediately
	// flip to paid (spec §5 C6, bug #8). A retry keeps it via resolveAiJobStartedAt.
	delete md.aiJobStartedAt;
	if (remainingGaps.length > 0) {
		md.transcriptionGaps = remainingGaps.map((g) => ({
			startSec: Math.round(g.startSec),
			endSec: Math.round(g.endSec),
		}));
	} else {
		delete md.transcriptionGaps;
	}
	if (coverageUnknown) {
		md.transcriptionCoverageUnknown = true;
	} else {
		delete md.transcriptionCoverageUnknown;
	}
	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE", metadata: md })
		.where(eq(videos.id, videoId as Video.VideoId));
	// best-effort delete partial file (never throw)
	await bucket
		.deleteObject(`${video.ownerId}/${videoId}/transcription-partial.vtt`)
		.pipe(runPromise)
		.catch(() => {});
}

async function cleanupTempAudioKeys(
	audioKeys: string[],
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	if (audioKeys.length === 0) return;

	try {
		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

		for (const audioKey of audioKeys) {
			try {
				await bucket.deleteObject(audioKey).pipe(runPromise);
			} catch (error) {
				console.error(
					`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
					error,
				);
			}
		}
	} catch (error) {
		console.error("[transcribe] Failed to access storage for audio cleanup", error);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function shouldQueueAiGeneration(
	videoId: string,
	aiGenerationEnabled: boolean,
): Promise<boolean> {
	"use step";

	if (aiGenerationEnabled) return true;

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	return shouldStartAiAfterTranscription({
		metadata: (video?.metadata as VideoMetadata) || {},
		aiGenerationEnabled,
	});
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runPromise);

		const [videoRecord] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (videoRecord?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}
