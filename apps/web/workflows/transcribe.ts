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
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { withCostGuard } from "@/lib/ai-cost-guard";
import { shouldStartAiAfterTranscription } from "@/lib/ai-generation-request";
import { type AiSpeedMode, resolveAiSpeedMode } from "@/lib/ai-speed-mode";
import {
	BatchFallbackError,
	transcribeChunkWithBatch,
} from "@/lib/gemini-batch-transcribe";
import { AI_CHUNK_CONCURRENCY, mapWithConcurrency } from "@/lib/concurrency";
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
	transcribeWithGemini,
} from "@/lib/gemini-transcribe";
import { fetchScribeWordTimes } from "@/lib/eleven-scribe";
import { startAiGeneration } from "@/lib/generate-ai";
import { restoreRussianScript } from "@/lib/restore-russian-script";
import { runPromise } from "@/lib/server";
import { isTranscriptionDisabled } from "@/lib/transcription-settings";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import { transferVttTimingWithStats } from "@/lib/vtt-timing-transfer";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
	/** Optional per-click override of the org-level aiSpeedMode default (see
	 * GenerateAiPanel's price chooser). Falls back to the org setting when absent. */
	speedModeOverride?: AiSpeedMode;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	isOwnerPro: boolean;
	ownerEncryptedGeminiKey: string | null;
	orgId: string;
	aiSpeedMode: AiSpeedMode;
}

export interface ExtractedAudioChunk {
	key: string;
	url: string;
	startSec: number;
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

// Chunk length is the ceiling on transcript↔audio drift: Gemini estimates (does
// not force-align) timestamps, so cues run progressively ahead within a chunk and
// only re-anchor at the next chunk's absolute start offset. Shorter chunks reset
// that drift more often. 6 min keeps enough context for speaker/term accuracy
// while capping worst-case drift far below the old 15-min value. Total audio sent
// to Gemini is unchanged (chunks don't overlap), so cost is ~flat — only the
// per-call prompt repeats. Threshold sits just above the chunk size so mid-length
// audios (which were previously one un-reset chunk) also get split.
const LONG_AUDIO_CHUNK_DURATION_SEC = 6 * 60;
const LONG_AUDIO_CHUNK_THRESHOLD_SEC = 8 * 60;
const ELEVEN_SCRIBE_COST_USD_MICROS_PER_HOUR = 220_000;

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled, speedModeOverride } = payload;

	const videoData = await validateVideo(videoId, speedModeOverride);

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

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
			{ userId, orgId: videoData.orgId, videoId, aiSpeedMode: videoData.aiSpeedMode },
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
			context: { userId, orgId: videoData.orgId, videoId, aiSpeedMode: videoData.aiSpeedMode },
			mergedVtt: transcription,
			totalDurationSec: audio.totalDurationSec,
		});

		const finalTranscription = await applyScribeTimingTransfer(
			audio,
			gapFill.transcription,
			videoId,
			{ userId, orgId: videoData.orgId },
		);

		await saveTranscription(
			videoId,
			userId,
			videoData.video,
			finalTranscription,
			gapFill.remainingGaps,
			audio.totalDurationSec == null,
		);
	} catch (error) {
		await markError(videoId);
		await cleanupTempAudioKeys(tempAudioKeys, videoData.video);
		throw error;
	}

	await cleanupTempAudioKeys(tempAudioKeys, videoData.video);

	if (await shouldQueueAiGeneration(videoId, aiGenerationEnabled)) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

export async function applyScribeTimingTransfer(
	audio: ExtractedAudio,
	transcription: string,
	videoId: string,
	context?: { userId: string; orgId: string },
): Promise<string> {
	"use step";

	if (audio.chunks.length <= 1 || !serverEnv().ELEVENLABS_API_KEY) {
		return transcription;
	}

	try {
		const words = await fetchScribeWordTimes(audio.chunks);
		await recordScribeTimingUsage(audio, videoId, context).catch((error) => {
			console.log("[transcribe] scribe-transfer usage record failed", error);
		});
		const result = transferVttTimingWithStats(transcription, words);
		console.log(
			`[transcribe] scribe-transfer: ${result.stats.shiftedCueCount} cues shifted, mean ${result.stats.meanShiftSec.toFixed(1)}s, ${result.stats.denseMatches} dense matches`,
		);
		return result.vtt;
	} catch (error) {
		console.log(
			`[transcribe] scribe-transfer failed for ${videoId}; keeping Gemini-timed VTT`,
			error,
		);
		return transcription;
	}
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
			model: "elevenlabs-scribe-v1",
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

async function validateVideo(
	videoId: string,
	speedModeOverride?: AiSpeedMode,
): Promise<VideoData> {
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

	// Read the org's transcription speed/cost mode ONCE, here at workflow start,
	// from settings already loaded above (no extra query). Defaults to "fast"
	// (sync) so an org that never opted in behaves exactly as before. A per-click
	// override (from the share page's price chooser) takes precedence when present.
	//
	// "Arzon"/batch (cheap) mode is DISABLED here: the Gemini Batch API runs async
	// for many minutes, but the inline after() task this workflow lives in does not
	// survive that long, so a batch job left videos frozen mid-transcription
	// (e.g. stuck at 2/3 chunks forever). Coerce any "cheap" request — per-click
	// override or org default — to the reliable synchronous path until a durable
	// batch runner exists.
	const requestedSpeedMode =
		speedModeOverride ?? resolveAiSpeedMode(result.orgSettings?.aiSpeedMode);
	const aiSpeedMode: AiSpeedMode =
		requestedSpeedMode === "cheap" ? "fast" : requestedSpeedMode;

	console.log(
		`[transcribe] Owner check: stripeSubscriptionStatus=${result.owner.stripeSubscriptionStatus}, thirdPartyStripeSubscriptionId=${result.owner.thirdPartyStripeSubscriptionId}, isOwnerPro=${isOwnerPro}, aiSpeedMode=${aiSpeedMode}`,
	);

	await db()
		.update(videos)
		.set({
			transcriptionStatus: "PROCESSING",
			metadata: {
				...((result.video.metadata as VideoMetadata) || {}),
				processingStartedAt: new Date().toISOString(),
				aiProcessingStep: "transcribe",
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		transcriptionDisabled,
		isOwnerPro,
		ownerEncryptedGeminiKey: result.owner.geminiApiKey ?? null,
		orgId: result.video.orgId,
		aiSpeedMode,
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

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markError(videoId: string): Promise<void> {
	"use step";

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
					durationSec: chunk.durationSec,
				});
			}

			console.log(
				`[transcribe] Extracted ${chunks.length} audio chunks for ${videoId}`,
			);

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
	context: { userId: string; orgId: string; videoId: string; aiSpeedMode?: AiSpeedMode },
	knownSpeakers: string[] = [],
): Promise<string> {
	"use step";

	let apiKey: string | undefined;

	if (ownerEncryptedGeminiKey) {
		try {
			apiKey = await decrypt(ownerEncryptedGeminiKey);
		} catch {
			console.error(
				"[transcribe] Failed to decrypt user Gemini key, falling back to server key",
			);
		}
	}

	if (!apiKey) {
		apiKey = serverEnv().GEMINI_API_KEY;
	}

	if (!apiKey) {
		throw new FatalError(
			"No Gemini API key configured. Set one in Settings → Account → Transcription API Keys, or ask your admin to set GEMINI_API_KEY.",
		);
	}

	const resolvedApiKey = apiKey;

	// Synchronous path — the default. UNCHANGED from before batch mode existed;
	// this is the regression line that must behave identically when mode=fast.
	const runSync = async (): Promise<string> => {
		// Free-tier first (auto-smart cost saver): when a billing-off Gemini key is
		// configured, transcribe on the free tier (gemini-3.5-flash, $0) and fall
		// back to the paid key/model on ANY failure — quota exhausted, error, etc.
		// No free key → this block is skipped and behavior is exactly as before.
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
						const res = await transcribeWithGemini(audioUrl, {
							apiKey: freeKey,
							audioDurationSec: audioDurationSec ?? undefined,
							knownSpeakers,
							models: [FREE_TRANSCRIBE_MODEL],
						});
						return {
							transcriptVtt: res.transcriptVtt,
							inputTokens: res.inputTokens,
							outputTokens: res.outputTokens,
							audioInTokens: res.audioInTokens,
						};
					},
				});
				return freeResult.transcriptVtt;
			} catch (error) {
				console.warn(
					`[transcribe] free-tier (${FREE_TRANSCRIBE_MODEL}) attempt failed for video=${context.videoId}, falling back to paid: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		const result = await withCostGuard({
			orgId: context.orgId,
			userId: context.userId,
			videoId: context.videoId,
			operation: "transcription",
			model: "gemini-3-flash-preview",
			fn: async () => {
				const res = await transcribeWithGemini(audioUrl, {
					apiKey: resolvedApiKey,
					audioDurationSec: audioDurationSec ?? undefined,
					knownSpeakers,
				});
				return {
					transcriptVtt: res.transcriptVtt,
					inputTokens: res.inputTokens,
					outputTokens: res.outputTokens,
					audioInTokens: res.audioInTokens,
				};
			},
		});
		return result.transcriptVtt;
	};

	if (context.aiSpeedMode !== "cheap") {
		return runSync();
	}

	// Cheap (Batch API) path. Records cost at batch rates (batch: true). Any
	// error from the batch attempt — a slow/terminal batch (BatchFallbackError)
	// or a plain error (e.g. the batch succeeded but an inline per-request error
	// or empty output was thrown by unwrapBatchResponse) — falls back to the
	// SYNC path for this one chunk, so a single-chunk video (no retry wrapper
	// above this call) never fails just because batch mode had a bad outcome.
	// If runSync() itself then fails, that error propagates to the caller's
	// existing retry path unchanged.
	try {
		const result = await withCostGuard({
			orgId: context.orgId,
			userId: context.userId,
			videoId: context.videoId,
			operation: "transcription",
			model: "gemini-3-flash-preview",
			batch: true,
			fn: async () => {
				const res = await transcribeChunkWithBatch(audioUrl, {
					apiKey: resolvedApiKey,
					audioDurationSec: audioDurationSec ?? undefined,
					knownSpeakers,
					videoId: context.videoId,
				});
				return {
					transcriptVtt: res.transcriptVtt,
					inputTokens: res.inputTokens,
					outputTokens: res.outputTokens,
					audioInTokens: res.audioInTokens,
				};
			},
		});
		return result.transcriptVtt;
	} catch (error) {
		if (error instanceof BatchFallbackError) {
			console.warn(
				`[transcribe] batch fallback → sync for video=${context.videoId} at ${audioUrl.split("?")[0]}: ${error.message}`,
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(
				`[transcribe] batch error → sync fallback for video=${context.videoId} at ${audioUrl.split("?")[0]}: ${message}`,
			);
		}
		return runSync();
	}
}

export async function transcribeAudioChunks(
	audio: ExtractedAudio,
	ownerEncryptedGeminiKey: string | null,
	context: { userId: string; orgId: string; videoId: string; aiSpeedMode?: AiSpeedMode },
	transcribeChunk: typeof transcribeAudioChunkWithRetry = transcribeAudioChunkWithRetry,
	onProgress?: (p: { transcribedChunks: Array<{ vtt: string; offsetSec: number }>; completed: number; total: number }) => Promise<void>,
	existingPartialVtt?: string,
): Promise<string> {
	if (audio.chunks.length === 1) {
		const chunk = audio.chunks[0];
		if (!chunk) return "WEBVTT\n\n";
		return restoreRussianScript(
			await transcribeAudio(
				chunk.url,
				chunk.durationSec ?? audio.totalDurationSec,
				ownerEncryptedGeminiKey,
				context,
			),
		);
	}

	let failedChunkCount = 0;
	let completedCount = 0;
	let reusedChunkCount = 0;
	const completedResults = new Array<{ vtt: string; offsetSec: number } | undefined>(
		audio.chunks.length,
	);

	// Retry resume: an earlier interrupted run may have saved a partial merged
	// transcript. Seed the result with it (offsetSec 0 = already absolute, the
	// same pattern fillTranscriptGaps uses) so every chunk it already covers can
	// be skipped below — a retry never re-bills Gemini for work that succeeded.
	const hasPartial =
		typeof existingPartialVtt === "string" &&
		existingPartialVtt.trim().length > 0 &&
		!/^WEBVTT\s*$/.test(existingPartialVtt.trim());
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
			result = { vtt, offsetSec: chunk.startSec };
		} catch (error) {
			// FAULT TOLERANCE (long-video fix): a single bad chunk must NOT discard the
			// whole transcript. Previously one failed chunk threw -> the outer catch marked
			// the ENTIRE video ERROR and dropped every successful chunk (root cause of
			// long-video AI failures). Now: log, keep a gap at this offset, and continue.
			failedChunkCount++;
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

	await mapWithConcurrency(
		audio.chunks.slice(1),
		AI_CHUNK_CONCURRENCY,
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
		throw new Error(
			`All ${failedChunkCount} transcription chunks failed for ${context.videoId}`,
		);
	}
	if (failedChunkCount > 0) {
		console.warn(
			`[transcribe] ${failedChunkCount}/${audio.chunks.length} chunks failed for ${context.videoId}; saved a partial transcript.`,
		);
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
		context: { userId: string; orgId: string; videoId: string; aiSpeedMode?: AiSpeedMode };
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
			console.warn(
				`[transcribe] gap-fill span at ${span.startSec}s failed for ${videoId} (silence or ASR failure)`,
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
		context: { userId: string; orgId: string; videoId: string; aiSpeedMode?: AiSpeedMode };
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
