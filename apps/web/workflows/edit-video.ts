import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type {
	AiSummary,
	VideoEditRange,
	VideoEditSpec,
	VideoMetadata,
} from "@cap/database/types";
import { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";
import { trimRemoteVideoToMp4 } from "@/lib/video-convert";
import { getEditSpecOutputDuration } from "@/lib/video-edits";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import {
	remapChaptersByStart,
	remapChaptersByStartSec,
	remapVttCuesForEdit,
} from "@/lib/vtt-edit-remap";

interface EditVideoWorkflowPayload {
	videoId: string;
	userId: string;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	editSpec: VideoEditSpec;
	keepRanges: VideoEditRange[];
	aiGenerationEnabled: boolean;
}

interface VideoEditRenderResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function editVideoWorkflow(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult> {
	"use workflow";

	const { videoId, sourceKey, keepRanges } = payload;

	// The general timeline editor (lib/video-edits.ts) can produce multiple
	// keepRanges (e.g. deleting a middle segment), but the actual product case
	// today is PreUploadTrimmer sending exactly one {start,end} — support that
	// well and reject the rest with a clear error instead of silently dropping
	// segments a multi-range concat would need to stitch together.
	if (keepRanges.length === 0) {
		const message = "Your edit doesn't keep any playable range.";
		await clearEditProcessingState(videoId, sourceKey);
		throw new FatalError(message);
	}
	if (keepRanges.length > 1) {
		const message =
			"Multi-segment trims aren't supported yet — keep a single continuous range.";
		await clearEditProcessingState(videoId, sourceKey);
		throw new FatalError(message);
	}

	try {
		const metadata = await applyTrimAndUpload(payload);
		await remapTranscriptAndArtifacts(videoId, payload.editSpec);
		// BEFORE the row delete: an edited video keeps its pre-edit
		// raw-upload.*, so without the marker the recover-stale-ai-jobs rowless
		// pass would relaunch processing from that raw and silently undo the trim.
		await markEditProcessed(videoId);
		await clearEditProcessingState(videoId, sourceKey);
		return { metadata };
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await clearEditProcessingState(videoId, sourceKey);
		throw new FatalError(errorMessage);
	}
}

/**
 * Downloads the pristine source copy (source/original.mp4 — always the
 * un-trimmed original; see actions/videos/save-edits.ts's
 * ensureOriginalSourceCopy), cuts the single requested keepRange with ffmpeg,
 * and overwrites `result.mp4` — the same canonical key
 * processVideoWorkflow writes to and every reader resolves first (see the
 * comment on workflows/process-video.ts's optimizeAndFinalizeVideo).
 */
async function applyTrimAndUpload(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult["metadata"]> {
	"use step";

	const { videoId, sourceKey, editSpec, keepRanges } = payload;
	const range = keepRanges[0];
	if (!range) throw new FatalError("Missing trim range");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) throw new FatalError("Video does not exist");

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(sourceKey)
		.pipe(runPromise);

	// Math fallback in case the post-encode probe below can't read a duration
	// (e.g. malformed output) — computed from the same keepRanges the UI used.
	let outputDurationSec = getEditSpecOutputDuration(editSpec);

	const result = await trimRemoteVideoToMp4(sourceUrl, {
		startSec: range.start,
		endSec: range.end,
	});

	try {
		const buffer = await fs.readFile(result.filePath);
		await bucket
			.putObject(`${video.ownerId}/${videoId}/result.mp4`, buffer, {
				contentType: "video/mp4",
			})
			.pipe(runPromise);

		if (
			result.metadata?.durationSec != null &&
			result.metadata.durationSec > 0
		) {
			outputDurationSec = result.metadata.durationSec;
		}

		console.log(
			`[edit-video] Trimmed video for ${videoId}: ${buffer.length} bytes, duration=${outputDurationSec}`,
		);
	} finally {
		await result.cleanup();
	}

	await db()
		.update(videos)
		.set({ duration: outputDurationSec })
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		duration: outputDurationSec,
		width: result.metadata?.width ?? video.width ?? 0,
		height: result.metadata?.height ?? video.height ?? 0,
		fps: video.fps ?? 0,
	};
}

/**
 * Post-AI trim desync guard (must-fix #7 from the plan review): a trim must
 * never leave a transcript cue, chapter, or summary timestamp pointing at a
 * moment that no longer exists in the output. If there's no transcript yet,
 * this is a no-op. Deterministic remaps (base VTT cues, base/per-language
 * chapter arrays) are applied; anything that can't be cleanly remapped is
 * dropped rather than shown at a wrong time — the honest signal is
 * VideoMetadata.chaptersStaleAfterTrim (chapters) and
 * VideoMetadata.aiTranslationStatus[lang] = "ERROR" (translated captions).
 */
async function remapTranscriptAndArtifacts(
	videoId: string,
	editSpec: VideoEditSpec,
): Promise<void> {
	"use step";

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	if (!video) return;

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const baseTranscriptKey = `${video.ownerId}/${videoId}/transcription.vtt`;
	const baseTranscript = await bucket
		.getObject(baseTranscriptKey)
		.pipe(runPromise);

	// No transcript exists yet (AI never ran, or was skipped) — nothing to
	// remap; leave metadata untouched.
	if (Option.isNone(baseTranscript)) return;

	const cueResult = remapVttCuesForEdit(baseTranscript.value, editSpec);
	await bucket
		.putObject(baseTranscriptKey, cueResult.vtt, { contentType: "text/vtt" })
		.pipe(runPromise);
	console.log(
		`[edit-video] Remapped transcript cues for ${videoId}: ${cueResult.keptCues}/${cueResult.totalCues} kept (${cueResult.droppedCues} dropped, ${cueResult.clippedCues} clipped)`,
	);

	const metadata = (video.metadata as VideoMetadata) ?? {};
	const nextMetadata: VideoMetadata = { ...metadata };
	let chaptersStale = false;

	if (metadata.chapters && metadata.chapters.length > 0) {
		const legacy = remapChaptersByStart(metadata.chapters, editSpec);
		nextMetadata.chapters = legacy.chapters;
		if (!legacy.clean) chaptersStale = true;
	}

	const remapSummaryChapters = (summary: AiSummary): AiSummary => {
		const chapters = remapChaptersByStartSec(summary.chapters, editSpec);
		const refined = remapChaptersByStartSec(
			summary.refinedTranscript?.chapters,
			editSpec,
		);
		if (!chapters.clean || !refined.clean) chaptersStale = true;

		return {
			...summary,
			chapters: chapters.chapters ?? [],
			refinedTranscript: {
				...summary.refinedTranscript,
				chapters: refined.chapters ?? [],
			},
		};
	};

	if (metadata.aiSummary) {
		nextMetadata.aiSummary = remapSummaryChapters(metadata.aiSummary);
	}

	if (metadata.aiSummaryByLanguage) {
		const nextByLanguage = { ...metadata.aiSummaryByLanguage };
		const nextTranslationStatus = { ...(metadata.aiTranslationStatus ?? {}) };

		for (const [lang, summary] of Object.entries(
			metadata.aiSummaryByLanguage,
		) as [keyof typeof nextByLanguage, AiSummary | undefined][]) {
			if (!summary) continue;
			nextByLanguage[lang] = remapSummaryChapters(summary);

			// The translated transcript VTT was built by copying the BASE VTT's
			// cue TIMING onto this language's cue TEXT by index (see
			// workflows/transcribe.ts's syncTranslatedTranscriptTimings). A trim
			// changes the base's cue COUNT (drops/clips), so that index
			// alignment can no longer be trusted — drop the stale file and flag
			// the language for re-translation rather than serve out-of-sync
			// captions.
			const translatedKey = `${video.ownerId}/${videoId}/transcription.${lang}.vtt`;
			const translated = await bucket
				.getObject(translatedKey)
				.pipe(runPromise);
			if (Option.isSome(translated)) {
				await bucket
					.deleteObject(translatedKey)
					.pipe(runPromise)
					.catch(() => {});
				nextTranslationStatus[lang] = "ERROR";
			}
		}

		nextMetadata.aiSummaryByLanguage = nextByLanguage;
		nextMetadata.aiTranslationStatus = nextTranslationStatus;
	}

	if (chaptersStale) {
		nextMetadata.chaptersStaleAfterTrim = true;
	} else {
		delete nextMetadata.chaptersStaleAfterTrim;
	}

	await db()
		.update(videos)
		.set({ metadata: nextMetadata })
		.where(eq(videos.id, videoId as Video.VideoId));
}

/** The durable `metadata.processedAt` success marker (see process-video.ts's
 * markProcessingFinished). JSON_SET, never a whole-object overwrite. */
async function markEditProcessed(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({
			metadata: sql`JSON_SET(
				COALESCE(${videos.metadata}, JSON_OBJECT()),
				'$.processedAt', ${new Date().toISOString()}
			)`,
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function clearEditProcessingState(
	videoId: string,
	sourceKey: string,
): Promise<void> {
	"use step";

	await db()
		.delete(videoUploads)
		.where(
			and(
				eq(videoUploads.videoId, videoId as Video.VideoId),
				eq(videoUploads.rawFileKey, sourceKey),
			),
		);
}
