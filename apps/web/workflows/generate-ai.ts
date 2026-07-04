import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import type {
	AiSummary,
	ShareLanguage,
	VideoMetadata,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	parseAiGenerationLanguage,
	type Video,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { z } from "zod";
import { BudgetExceededError, withCostGuard } from "@/lib/ai-cost-guard";
import { AI_CHUNK_CONCURRENCY, mapWithConcurrency } from "@/lib/concurrency";
import { withGeminiRetry } from "@/lib/gemini-retry";
import { stripRunawayRepetition } from "@/lib/gemini-transcribe";
import { MIXED_LANGUAGE_PRESERVATION_RULES } from "@/lib/prompt-rules";
import { restoreRussianScriptDeep } from "@/lib/restore-russian-script";
import { runPromise } from "@/lib/server";
import { normalizeWebVttVoiceText } from "@/lib/transcript-vtt";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { getStorageAccessForVideo } from "@/lib/video-storage";

interface GenerateAiWorkflowPayload {
	videoId: string;
	userId: string;
	/**
	 * Force a re-run even when usable AI content already exists (owner-triggered
	 * "Qayta analiz" / retry). Bypasses the "already generated" guard; the new
	 * result overwrites the old one in saveResults. Uses the existing transcript
	 * — no re-upload / re-transcription.
	 */
	force?: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	metadata: VideoMetadata;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface VttSegment {
	start: number;
	text: string;
}

interface TranscriptChunk {
	text: string;
	segments: VttSegment[];
	startTime: number;
	endTime: number;
}

interface RefinedTranscriptLine {
	id: number;
	start: number;
	time: string;
	text: string;
	speaker: string | null;
}

interface TranscriptData {
	segments: VttSegment[];
	text: string;
}

interface AiCallContext {
	orgId: string;
	userId: string;
	videoId: string;
}

interface AiResult {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
	aiSummary?: AiSummary | null;
	_usage?: { model: string; inputTokens: number; outputTokens: number };
}

// Resilient by design: the AI's structured JSON is imperfect on long (2h+)
// multi-chunk syntheses — a single item missing an inner field (e.g. a chapter
// with no `body`) used to fail the WHOLE parse (parseAiSummary → null), which
// stored a COMPLETE video with an EMPTY structured summary (no tasks/topics/
// refined). Every field now has a default and every array/scalar `.catch`es
// parse errors, so partial imperfections degrade gracefully instead of nuking
// the entire structured summary.
const AiSummarySchema = z.object({
	overview: z.string().catch(""),
	topics: z
		.array(
			z.object({
				title: z.string().catch(""),
				body: z.string().catch(""),
			}),
		)
		.catch([]),
	nextSteps: z.array(z.string()).catch([]),
	tasks: z
		.array(
			z.object({
				title: z.string().catch(""),
				assignee: z.string().catch(""),
				priority: z.enum(["high", "medium", "low"]).catch("medium"),
				deadline: z.string().catch(""),
				done: z.boolean().catch(false),
			}),
		)
		.catch([]),
	chapters: z
		.array(
			z.object({
				startSec: z.number().catch(0),
				title: z.string().catch(""),
				body: z.string().catch(""),
			}),
		)
		.catch([]),
	refinedTranscript: z
		.object({
			chapters: z
				.array(
					z.object({
						startSec: z.number().catch(0),
						title: z.string().catch(""),
						paragraphs: z.array(z.string()).catch([]),
					}),
				)
				.catch([]),
		})
		.catch({ chapters: [] }),
});

function parseAiSummary(raw: unknown): AiSummary | null {
	const result = AiSummarySchema.safeParse(raw);
	if (!result.success) return null;
	return result.data;
}

const MAX_CHARS_PER_CHUNK = 24000;
export const MAX_REFINED_TRANSCRIPT_AUTO_CHARS = 12000;
export const MAX_REFINED_TRANSCRIPT_AUTO_SECONDS = 12 * 60;
const AI_SUMMARY_FAILURE_PLACEHOLDER =
	"The AI was unable to generate a proper summary for this content.";
const GENERATED_TITLE_PATTERN =
	/^(data365 (Recording|Upload) - .+|Untitled|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|.+ \((Display|Window|Area|Camera)\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)$/;

export function shouldReplaceVideoTitle({
	currentTitle,
	previousAiTitle,
	nextAiTitle,
	sourceName,
	titleManuallyEdited,
}: {
	currentTitle: string | null;
	previousAiTitle?: string | null;
	nextAiTitle?: string | null;
	sourceName?: string | null;
	titleManuallyEdited?: boolean | null;
}) {
	const nextTitle = nextAiTitle?.trim();
	if (!nextTitle) return false;
	if (titleManuallyEdited) return false;

	const title = currentTitle?.trim();
	if (!title) return true;
	if (previousAiTitle?.trim() && title === previousAiTitle.trim()) return true;
	if (sourceName?.trim() && title === sourceName.trim()) return true;
	return GENERATED_TITLE_PATTERN.test(title);
}

export async function generateAiWorkflow(payload: GenerateAiWorkflowPayload) {
	"use workflow";

	const { videoId, userId, force } = payload;

	const videoData = await validateAndSetProcessing(videoId, force ?? false);

	const transcript = await fetchTranscript(videoId, userId, videoData.video);

	if (!transcript) {
		await markSkipped(videoId, videoData.metadata);
		return {
			success: true,
			message: "Transcript empty or too short - skipped",
		};
	}

	let result: AiResult;
	try {
		result = await generateWithAi(transcript, videoData.aiGenerationLanguage, {
			orgId: videoData.video.orgId,
			userId,
			videoId,
		});
	} catch (error) {
		if (error instanceof BudgetExceededError) {
			await markBudgetExceeded(videoId, videoData.metadata);
			return {
				success: false,
				message: "AI budget exceeded",
			};
		}
		throw error;
	}

	await saveResults(videoId, videoData, result);

	return { success: true, message: "AI generation completed successfully" };
}

async function validateAndSetProcessing(
	videoId: string,
	force = false,
): Promise<VideoData> {
	"use step";

	if (!serverEnv().GEMINI_API_KEY) {
		throw new FatalError("Missing GEMINI_API_KEY");
	}

	const query = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new FatalError("Transcription not complete");
	}

	if (!force && metadata.summary && metadata.chapters) {
		throw new FatalError("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "PROCESSING",
				aiProcessingStartedAt: new Date().toISOString(),
				aiProcessingStep: "summary",
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video,
		metadata,
		aiGenerationLanguage: parseAiGenerationLanguage(
			query[0]?.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function fetchTranscript(
	videoId: string,
	_userId: string,
	video: typeof videos.$inferSelect,
): Promise<TranscriptData | null> {
	"use step";

	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* getStorageAccessForVideo(video);
		return yield* bucket.getObject(
			`${video.ownerId}/${videoId}/transcription.vtt`,
		);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments, text };
}

async function markSkipped(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	"use step";

	const currentMetadata = await getCurrentVideoMetadata(videoId, metadata);

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				aiGenerationStatus: "SKIPPED",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markBudgetExceeded(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	"use step";

	const currentMetadata = await getCurrentVideoMetadata(videoId, metadata);

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				aiGenerationStatus: "ERROR",
				aiGenerationError: "AI budget exceeded",
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function generateWithAi(
	transcript: TranscriptData,
	language: AiGenerationLanguage,
	context: AiCallContext,
): Promise<AiResult> {
	"use step";

	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	const videoDuration = getVideoDuration(transcript.segments);
	const languageInstruction = getAiLanguageInstruction(language);
	const includeRefinedTranscript = shouldGenerateRefinedTranscript({
		transcriptCharCount: transcript.text.length,
		videoDurationSeconds: videoDuration,
	});

	// The refined transcript is generated as a SEPARATE chapter-aligned pass below
	// (its chapters mirror aiSummary.chapters exactly, like the raw "Matn" tab).
	// The chunk paths must NOT produce their own chunk-shaped refined — that both
	// mis-aligns the sections AND doubles the AI spend. So pass `false` here.
	let result: AiResult;
	if (chunks.length === 1) {
		result = await generateSingleChunk(
			transcript.segments,
			videoDuration,
			languageInstruction,
			context,
			false,
		);
	} else {
		result = await generateMultipleChunks(
			chunks,
			videoDuration,
			languageInstruction,
			context,
			false,
		);
	}

	if (result.chapters) {
		result.chapters = clampChapters(result.chapters, videoDuration);
	}
	if (result.aiSummary) {
		result.aiSummary.chapters = sanitizeSummaryChapters(
			result.aiSummary.chapters,
			videoDuration,
		);
	}

	// Chapter-aligned refined transcript: clean the transcript slice under each
	// finalized summary chapter so "Refined" and "Matn" share the same sections.
	if (includeRefinedTranscript) {
		await patchVideoMetadata(context.videoId, (current) => ({
			...current,
			aiProcessingStep: "refined",
		}));
		const refined = await generateChapterAlignedRefined(
			transcript.segments,
			result.aiSummary?.chapters ?? [],
			context,
		);
		if (refined.chapters.length > 0) {
			if (result.aiSummary) {
				// Keep the summary chapters and the refined chapters as ONE list.
				// generateChapterAlignedRefined drops any chapter whose time window
				// contains no transcript segments (a boundary Gemini placed in a dead
				// zone — common when the transcript VTT has inflated/runaway
				// timestamps). Without this, aiSummary.chapters (e.g. 5) can outnumber
				// refinedTranscript.chapters (e.g. 4), so the "Matn" tab shows a
				// chapter heading with no refined body — the intermittent "chala" bug.
				// Align summary chapters to exactly the ones that produced content.
				result.aiSummary.chapters = alignChaptersToRefined(
					result.aiSummary.chapters,
					refined.chapters,
				);
				result.aiSummary.refinedTranscript = { chapters: refined.chapters };
			} else {
				result.aiSummary = parseAiSummary({
					refinedTranscript: { chapters: refined.chapters },
				});
			}
		}
		if (result._usage) {
			result._usage.inputTokens += refined.inputTokens;
			result._usage.outputTokens += refined.outputTokens;
		}
	}

	// Deterministic script guard on EVERY AI output surface (title, summary,
	// chapters, aiSummary incl. refined paragraphs) - the prompt asks, this
	// guarantees. _usage contains only numbers and passes through untouched.
	return restoreRussianScriptDeep(result);
}

export function getAiLanguageInstruction(
	language: AiGenerationLanguage,
): string {
	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return [
			"Detect the dominant spoken language from the transcript and write the title, summary, chapter titles, section summaries, and key points in that same language.",
			"If the transcript is Uzbek or mixed Uzbek/English/Russian, write Uzbek Latin output and keep English/Russian technical words exactly as spoken.",
			"Do not translate the meeting into English just because the app UI or schema examples are English.",
		].join(" ");
	}

	return `Write the title, summary, chapter titles, section summaries, and key points in ${getAiGenerationLanguageName(language)}.`;
}

export function shouldGenerateRefinedTranscript({
	transcriptCharCount,
	videoDurationSeconds,
}: {
	transcriptCharCount: number;
	videoDurationSeconds: number;
}): boolean {
	// The cleaned transcript is generated SEPARATELY from the summary JSON call
	// (single-chunk: its own delete-classifier call; multi-chunk: one
	// delete-classifier call per chunk, each bounded by MAX_CHARS_PER_CHUNK). It
	// therefore does NOT share the summary token budget. We intentionally do NOT
	// gate on duration: this is a lessons platform with long recordings, and the previous
	// duration cap (a) excluded every video longer than the cap and (b) tripped
	// on inflated durations from hallucinated trailing VTT cues — both left the
	// Refined tab empty. The only requirement is that a transcript exists.
	// (videoDurationSeconds is kept in the signature for callers/tests.)
	void videoDurationSeconds;
	return transcriptCharCount > 0;
}

// Shared, strengthened rules — single source in lib/prompt-rules.ts.
// (imported below; kept as a const alias so the many template-literal
// call sites in this file stay unchanged)

function getVideoDuration(segments: VttSegment[]): number {
	if (segments.length === 0) return 0;
	const lastSegment = segments[segments.length - 1];
	return lastSegment ? lastSegment.start + 3 : 0;
}

// Coerce a chapter start (seconds) into a sane range. The summary model
// occasionally returns the value in the WRONG unit — observed ~x60 inflated
// (e.g. 6000 for a real 100s mark), which rendered as "100:00" in the UI.
// Recover the common x60 double-conversion, otherwise clamp into [0, duration]
// so a bad value can never reach the UI as a garbage timestamp.
function sanitizeStartSec(value: number, videoDuration: number): number | null {
	if (!Number.isFinite(value) || value < 0) return null;
	if (videoDuration <= 0) return Math.round(value);
	if (value <= videoDuration) return Math.round(value);
	if (value / 60 <= videoDuration) return Math.round(value / 60);
	return Math.round(videoDuration);
}

function clampChapters(
	chapters: { title: string; start: number }[],
	videoDuration: number,
): { title: string; start: number }[] {
	const cleaned: { title: string; start: number }[] = [];
	for (const ch of chapters) {
		const start = sanitizeStartSec(ch.start, videoDuration);
		if (start === null) continue;
		cleaned.push({ title: ch.title, start });
	}

	if (cleaned.length === 0 && chapters.length > 0) {
		const first = chapters[0];
		return first ? [{ title: first.title, start: 0 }] : [];
	}

	cleaned.sort((a, b) => a.start - b.start);

	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	const deduped: { title: string; start: number }[] = [];
	for (const chapter of cleaned) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(chapter.start - last.start) >= minGap) {
			deduped.push(chapter);
		}
	}

	return deduped;
}

// Same sanitization for the aiSummary.chapters[] shape ({ startSec, ... }).
function sanitizeSummaryChapters<T extends { startSec: number }>(
	chapters: T[],
	videoDuration: number,
): T[] {
	const cleaned: T[] = [];
	for (const ch of chapters) {
		const startSec = sanitizeStartSec(ch.startSec, videoDuration);
		if (startSec === null) continue;
		cleaned.push({ ...ch, startSec });
	}
	cleaned.sort((a, b) => a.startSec - b.startSec);

	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	const deduped: T[] = [];
	for (const ch of cleaned) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(ch.startSec - last.startSec) >= minGap) {
			deduped.push(ch);
		}
	}
	return deduped;
}

/**
 * Whether a summary/aiSummary pair is actually user-facing content (not an
 * empty shell). A refined-transcript-only shell (built when the summary JSON
 * failed or truncated) is NOT usable.
 */
function hasUsableSummaryContent(
	summary: string | null | undefined,
	aiSummary: AiSummary | null | undefined,
): boolean {
	return (
		(typeof summary === "string" &&
			summary.trim().length > 0 &&
			summary.trim() !== AI_SUMMARY_FAILURE_PLACEHOLDER) ||
		Boolean(
			aiSummary &&
				((aiSummary.overview ?? "").trim().length > 0 ||
					(aiSummary.topics?.length ?? 0) > 0 ||
					(aiSummary.tasks?.length ?? 0) > 0 ||
					(aiSummary.chapters?.length ?? 0) > 0 ||
					(aiSummary.nextSteps?.length ?? 0) > 0),
		)
	);
}

export const AI_EMPTY_RESULT_ERROR = "AI generation returned no usable content";

/**
 * Pure metadata-patch decision for saveResults. Exported for unit tests.
 *
 * Rules:
 * - Content from THIS run is merged only when THIS run is usable — an
 *   empty/shell retry never clobbers good stored content.
 * - A run whose own result is NOT usable is always reported as ERROR — even
 *   when usable content from a previous run is already stored. Reporting
 *   COMPLETE for a failed run masks the failure (empty-shell-COMPLETE bug).
 * - On failure the error text describes THIS run (never a stale message from
 *   a previous run); on success any stale error is cleared.
 * - result.aiSummary only replaces a stored aiSummary when the new one is
 *   itself usable (a text-only summary run must not wipe stored topics/tasks).
 */
export function buildSaveResultsPatch(
	current: VideoMetadata,
	result: AiResult,
	opts: {
		generatedTitle?: string;
		resolvedBaseLanguage?: ShareLanguage;
	} = {},
): VideoMetadata {
	// Judge usability from THIS run's result only (not merged with old
	// metadata) — otherwise an empty "{}" retry could overwrite `summary` with
	// the failure placeholder yet still be marked COMPLETE because stale
	// content existed.
	const resultSummaryText = result.summary?.trim() ?? "";
	const runIsUsable =
		(resultSummaryText.length > 0 &&
			resultSummaryText !== AI_SUMMARY_FAILURE_PLACEHOLDER) ||
		hasUsableSummaryContent(null, result.aiSummary);

	// Only take THIS run's content when it is usable — never clobber good
	// stored content with an empty/shell result (the retry-over-stale bug).
	const nextSummary = runIsUsable
		? result.summary || current.summary
		: current.summary;
	const nextChapters = runIsUsable
		? result.chapters || current.chapters
		: current.chapters;
	const nextAiSummary = runIsUsable
		? hasUsableSummaryContent(null, result.aiSummary)
			? (result.aiSummary ?? current.aiSummary)
			: current.aiSummary
		: current.aiSummary;
	// COMPLETE requires BOTH: this run produced usable content AND the final
	// stored content is genuinely usable.
	const finalUsable =
		runIsUsable && hasUsableSummaryContent(nextSummary, nextAiSummary);
	return {
		...current,
		aiTitle: opts.generatedTitle || current.aiTitle,
		summary: nextSummary,
		chapters: nextChapters,
		aiSummary: nextAiSummary,
		aiBaseLanguage: opts.resolvedBaseLanguage ?? current.aiBaseLanguage,
		aiGenerationStatus: finalUsable ? "COMPLETE" : "ERROR",
		// Success clears any stale error; failure records THIS run's outcome
		// instead of leaving a message from an older run lying around.
		aiGenerationError: finalUsable ? undefined : AI_EMPTY_RESULT_ERROR,
		aiProcessingStep: finalUsable ? "done" : current.aiProcessingStep,
	};
}

async function saveResults(
	videoId: string,
	videoData: VideoData,
	result: AiResult,
): Promise<void> {
	"use step";

	const { video, metadata, aiGenerationLanguage } = videoData;
	// Only record a base language when it was explicitly resolved (not "auto" or
	// a language outside ShareLanguage) — the client-side detectShareLanguage
	// fallback handles "auto" by sniffing the generated summary text instead.
	const resolvedBaseLanguage: ShareLanguage | undefined =
		aiGenerationLanguage === "en" || aiGenerationLanguage === "ru"
			? aiGenerationLanguage
			: undefined;
	const generatedTitle = result.title?.trim();
	const currentVideo = await getCurrentVideo(videoId);
	const currentMetadata = currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: metadata;
	const currentTitle = currentVideo?.name ?? video.name;

	await patchVideoMetadata(videoId, (current) =>
		buildSaveResultsPatch(current, result, {
			generatedTitle,
			resolvedBaseLanguage,
		}),
	);

	if (
		generatedTitle &&
		shouldReplaceVideoTitle({
			currentTitle,
			previousAiTitle: currentMetadata.aiTitle,
			nextAiTitle: generatedTitle,
			sourceName: currentMetadata.sourceName,
			titleManuallyEdited: currentMetadata.titleManuallyEdited,
		})
	) {
		await db()
			.update(videos)
			.set({ name: generatedTitle })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.name, currentTitle),
				),
			);
	}
}

async function getCurrentVideo(
	videoId: string,
): Promise<typeof videos.$inferSelect | null> {
	const [currentVideo] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return currentVideo ?? null;
}

async function getCurrentVideoMetadata(
	videoId: string,
	fallback: VideoMetadata,
): Promise<VideoMetadata> {
	const currentVideo = await getCurrentVideo(videoId);
	return currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: fallback;
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
			// Belt-and-suspenders: some VTTs (e.g. Gemini's "**[start --> end]** text")
			// put the cue text on the SAME line as the timestamp. Capture it so AI never
			// silently skips on an odd VTT.
			const afterArrow = line.slice(line.lastIndexOf("-->") + 3);
			const inlineText = afterArrow
				.replace(/^[^\]]*\]/, "") // drop trailing end-time + closing bracket(s)
				.replace(/\*\*/g, "")
				.replace(/[[\]]/g, "")
				.replace(/^[\s\-–—:>]+/, "")
				.trim();
			if (inlineText && !/^\d{1,2}:\d{2}/.test(inlineText)) {
				const normalized = normalizeWebVttVoiceText(inlineText);
				segments.push({
					start: currentStart,
					text: normalized.speaker
						? `${normalized.speaker}: ${normalized.text}`
						: normalized.text,
				});
			}
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			const normalized = normalizeWebVttVoiceText(line);
			segments.push({
				start: currentStart,
				text: normalized.speaker
					? `${normalized.speaker}: ${normalized.text}`
					: normalized.text,
			});
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): TranscriptChunk[] {
	const chunks: TranscriptChunk[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map((s) => s.text).join(" "),
				segments: [...currentChunk],
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map((s) => s.text).join(" "),
			segments: [...currentChunk],
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	}

	return chunks;
}

// 3-flash-preview follows the "remove filler, keep all substance" refine
// instruction dramatically better than 2.5-flash (A/B on a real 53-min uz call:
// clean flowing prose vs. residual chat-cruft) AND emits ~4x fewer output tokens
// for the same content — so the refined pass is both cleaner and ~75% cheaper.
const GEMINI_SUMMARY_MODEL = "gemini-3-flash-preview";

interface AiApiResult {
	content: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

async function callAiApi(
	prompt: string,
	options: { json?: boolean },
	context: AiCallContext,
): Promise<AiApiResult> {
	const { json = true } = options;
	const apiKey = serverEnv().GEMINI_API_KEY;
	if (!apiKey) {
		console.warn("[generate-ai] GEMINI_API_KEY not set, skipping AI call");
		return { content: "{}", model: "unknown", inputTokens: 0, outputTokens: 0 };
	}

	const result = await withCostGuard({
		orgId: context.orgId,
		userId: context.userId,
		videoId: context.videoId,
		operation: "summary",
		model: GEMINI_SUMMARY_MODEL,
		fn: async () => {
			const { data } = await withGeminiRetry(async () => {
				const res = await fetch(
					`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SUMMARY_MODEL}:generateContent?key=${apiKey}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ parts: [{ text: prompt }] }],
							generationConfig: {
								temperature: 0.2,
								// Both calls can produce large output for long videos. The
								// structured-summary JSON holds a chapter + a task + a topic PER
								// agenda item, so a ~65-min meeting needs ~8.6k output tokens — the
								// old 8192 cap TRUNCATED it mid-JSON (finishReason MAX_TOKENS),
								// JSON.parse then threw and the error was swallowed, so
								// summary/chapters/tasks came back empty while the (separate)
								// refined-transcript call survived. Give BOTH calls the model's
								// full output room (65536). Verified via repro: 8192 -> MAX_TOKENS
								// + parse fail + 0 chapters/tasks; 65536 -> STOP + 30/30.
								maxOutputTokens: 65536,
								...(json ? { responseMimeType: "application/json" } : {}),
								thinkingConfig: { thinkingBudget: 0 },
							},
						}),
					},
				);

				const data = (await res.json()) as {
					candidates?: Array<{
						content: { parts: Array<{ text?: string }> };
						finishReason?: string;
					}>;
					usageMetadata?: {
						promptTokenCount?: number;
						candidatesTokenCount?: number;
					};
					promptFeedback?: { blockReason?: string };
					error?: { message: string };
				};

				if (!res.ok) {
					throw new Error(
						`Gemini generateContent failed (HTTP ${res.status}): ${data.error?.message ?? "unknown"}`,
					);
				}

				return { data };
			});

			const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!rawText) {
				console.error("[generate-ai] empty AI response", {
					finishReason: data.candidates?.[0]?.finishReason,
					blockReason: data.promptFeedback?.blockReason,
					candidateCount: data.candidates?.length ?? 0,
				});
			}
			if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
				console.error(
					"[generate-ai] response TRUNCATED (MAX_TOKENS) - raise maxOutputTokens",
					{ json, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
				);
			}
			const content = rawText ?? "{}";
			const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
			const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

			return { content, inputTokens, outputTokens };
		},
	});

	return { ...result, model: GEMINI_SUMMARY_MODEL };
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

function formatTranscriptTime(seconds: number): string {
	const safeSeconds = Number.isFinite(seconds)
		? Math.max(0, Math.floor(seconds))
		: 0;
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const secs = safeSeconds % 60;
	if (hours > 0) {
		return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function splitSpeakerPrefix(text: string): {
	speaker: string | null;
	body: string;
} {
	const trimmed = text.trim();
	const match = trimmed.match(/^([^:\n]{1,50}):\s+(.+)$/);
	if (!match) return { speaker: null, body: trimmed };
	return {
		speaker: match[1]?.trim() || null,
		body: match[2]?.trim() || trimmed,
	};
}

function buildRefinedTranscriptLines(
	segments: VttSegment[],
): RefinedTranscriptLine[] {
	return segments
		.map((segment) => ({
			start: segment.start,
			text: segment.text.trim(),
		}))
		.filter((line) => line.text.length > 0)
		.map((line, id) => {
			const { speaker } = splitSpeakerPrefix(line.text);
			return {
				id,
				start: line.start,
				time: formatTranscriptTime(line.start),
				text: line.text,
				speaker,
			};
		});
}

function normalizeRefinedComparable(text: string): string {
	return text
		.toLowerCase()
		.replace(/[`'’]/g, "")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const PURE_ACKNOWLEDGEMENT_LINES = new Set([
	"aha",
	"aha aha",
	"mhm",
	"hm",
	"hmm",
	"mm",
	"uh",
	"um",
	"uh huh",
	"xop",
	"hop",
	"mayli",
	"ok",
	"okay",
	"okey",
	"aga",
	"ugu",
	"aga aga",
	"ugu ugu",
	"да",
	"ага",
	"угу",
	"угу угу",
]);

const PROTECTED_ENTITY_STOPWORDS = new Set([
	"admin",
	"speaker",
	"bugun",
	"mana",
	"demak",
	"lekin",
	"keyin",
	"shunaqa",
	"ha",
	"yoq",
	"yani",
	"agar",
	"bilan",
	"uchun",
	"kerak",
	"bor",
	"yo",
	"va",
	"the",
	"and",
	"this",
	"that",
	"yes",
	"no",
	"ok",
	"okay",
]);

function isPureAcknowledgementLine(line: RefinedTranscriptLine): boolean {
	const { body } = splitSpeakerPrefix(line.text);
	const normalized = normalizeRefinedComparable(body);
	return PURE_ACKNOWLEDGEMENT_LINES.has(normalized);
}

function isExactRefinedRepeat(
	line: RefinedTranscriptLine,
	lines: RefinedTranscriptLine[],
): boolean {
	const normalized = normalizeRefinedComparable(
		splitSpeakerPrefix(line.text).body,
	);
	if (!normalized) return false;
	const previous = lines.slice(Math.max(0, line.id - 3), line.id);
	return previous.some(
		(prev) =>
			normalizeRefinedComparable(splitSpeakerPrefix(prev.text).body) ===
			normalized,
	);
}

function isBareEcho(
	line: RefinedTranscriptLine,
	lines: RefinedTranscriptLine[],
): boolean {
	const normalized = normalizeRefinedComparable(
		splitSpeakerPrefix(line.text).body,
	);
	if (!normalized) return false;
	const tokens = normalized.split(" ");
	if (tokens.length > 3 || normalized.length > 40) return false;
	const previous = lines.slice(Math.max(0, line.id - 3), line.id);
	return previous.some((prev) => {
		const prevNormalized = normalizeRefinedComparable(
			splitSpeakerPrefix(prev.text).body,
		);
		return new RegExp(`(^| )${escapeRegExp(normalized)}( |$)`).test(
			prevNormalized,
		);
	});
}

function isShortFalseStart(line: RefinedTranscriptLine): boolean {
	const { body } = splitSpeakerPrefix(line.text);
	const normalized = normalizeRefinedComparable(body);
	if (!normalized || /\d/.test(normalized)) return false;
	const tokenCount = normalized.split(" ").length;
	return tokenCount <= 5 && /(?:[-–—]|\.\.\.|…)\s*$/.test(body.trim());
}

function isSafeRefinedDelete(
	line: RefinedTranscriptLine,
	lines: RefinedTranscriptLine[],
): boolean {
	return (
		isPureAcknowledgementLine(line) ||
		isExactRefinedRepeat(line, lines) ||
		isBareEcho(line, lines) ||
		isShortFalseStart(line)
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractProtectedRefinedTokens(text: string): Set<string> {
	if (
		PURE_ACKNOWLEDGEMENT_LINES.has(
			normalizeRefinedComparable(splitSpeakerPrefix(text).body),
		)
	) {
		return new Set();
	}

	const numbers = text.match(/\d[\d\s.,]*\d|\d/g) ?? [];
	const entityLike =
		text.match(
			/\b(?:[A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*|[A-Za-z]*\d+[A-Za-z]*|[А-ЯЁ][А-ЯЁа-яё0-9]+)\b/g,
		) ?? [];
	const tokens = new Set<string>();

	for (const number of numbers) {
		const normalized = number.replace(/\D/g, "");
		if (normalized.length >= 2) tokens.add(`n:${normalized}`);
	}

	for (const entity of entityLike) {
		const normalized = entity
			.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
			.toLowerCase();
		if (
			normalized.length > 1 &&
			!/^\d+$/.test(normalized) &&
			!PURE_ACKNOWLEDGEMENT_LINES.has(normalizeRefinedComparable(normalized)) &&
			!PROTECTED_ENTITY_STOPWORDS.has(normalized)
		) {
			tokens.add(`e:${normalized}`);
		}
	}

	return tokens;
}

function guardDeletesForProtectedTokens(
	lines: RefinedTranscriptLine[],
	deleteIds: Set<number>,
): Set<number> {
	const guardedDeleteIds = new Set(deleteIds);
	const keptTokens = new Set<string>();

	for (const line of lines) {
		if (guardedDeleteIds.has(line.id)) continue;
		for (const token of extractProtectedRefinedTokens(line.text)) {
			keptTokens.add(token);
		}
	}

	for (const line of lines) {
		if (!guardedDeleteIds.has(line.id)) continue;
		const lineTokens = extractProtectedRefinedTokens(line.text);
		if ([...lineTokens].some((token) => !keptTokens.has(token))) {
			guardedDeleteIds.delete(line.id);
			for (const token of lineTokens) keptTokens.add(token);
		}
	}

	return guardedDeleteIds;
}

function readDeleteId(value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) {
		return Number.parseInt(value, 10);
	}
	if (isRecord(value)) {
		return readDeleteId(value.id);
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addDeleteIds(
	value: unknown,
	validIds: Set<number>,
	deleteIds: Set<number>,
) {
	if (!Array.isArray(value)) return;
	for (const item of value) {
		const id = readDeleteId(item);
		if (id !== null && validIds.has(id)) deleteIds.add(id);
	}
}

function parseRefinedDeleteIds(
	content: string,
	lines: RefinedTranscriptLine[],
): Set<number> {
	const validIds = new Set(lines.map((line) => line.id));
	const deleteIds = new Set<number>();
	const parsed = JSON.parse(cleanJsonResponse(content).trim()) as unknown;

	if (Array.isArray(parsed)) {
		addDeleteIds(parsed, validIds, deleteIds);
		return deleteIds;
	}

	if (!isRecord(parsed)) return deleteIds;

	addDeleteIds(parsed.deleteIds, validIds, deleteIds);
	addDeleteIds(parsed.delete_ids, validIds, deleteIds);
	addDeleteIds(parsed.deletedIds, validIds, deleteIds);
	addDeleteIds(parsed.deleted_ids, validIds, deleteIds);

	const decisions = parsed.lines ?? parsed.decisions ?? parsed.items;
	if (Array.isArray(decisions)) {
		for (const decision of decisions) {
			if (!isRecord(decision)) continue;
			const shouldDelete =
				decision.delete === true ||
				decision.keep === false ||
				decision.action === "delete" ||
				decision.decision === "delete";
			if (!shouldDelete) continue;
			const id = readDeleteId(decision.id);
			if (id !== null && validIds.has(id)) deleteIds.add(id);
		}
	}

	return deleteIds;
}

function buildRefinedDeletePrompt(lines: RefinedTranscriptLine[]): string {
	const transcriptLines = JSON.stringify(
		lines.map(({ id, time, speaker, text }) => ({
			id,
			time,
			speaker,
			text,
		})),
		null,
		2,
	);

	return `You are a lossless transcript noise classifier.

Your only job is to mark transcript lines that should be DELETED. You must not rewrite, shorten, translate, merge, or clean any text. The application will keep every unmarked line verbatim.

Delete a line ONLY when the whole line is useless noise:
- Pure acknowledgement/backchannel: "aha", "xo'p", "mhm", "uh huh", "ага", "угу", etc.
- A bare echo of a number or word the other speaker just said.
- Exact verbatim repetition of a previous line.
- A false start with no completed useful content.

KEEP every line that contains any fact, number, name, price, place, decision, explanation, argument, question, or answer. When unsure, KEEP. Do not translate Uzbek, Russian, or English.

Return ONLY valid JSON in this exact shape:
{"deleteIds":[1,2,3]}

Do not include ids for lines that should be kept.

Transcript lines:
${transcriptLines}`;
}

// Break a verbatim text block into shorter, reading-friendly paragraphs of a
// few sentences each (owner: "leave a blank line after every 2-3 sentences").
// This is purely cosmetic: sentences are split on terminal punctuation followed
// by whitespace (so numbers/dates like "3.11.2025" are never split — no space
// inside them) and re-joined with a single space, so no word is added, removed,
// or rewritten. The refined-transcript lossless guarantee is preserved.
const SENTENCES_PER_REFINED_PARAGRAPH = 3;
function splitIntoReadableParagraphs(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const sentences = trimmed
		.split(/(?<=[.!?…])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (sentences.length <= SENTENCES_PER_REFINED_PARAGRAPH) return [trimmed];
	const paragraphs: string[] = [];
	for (let i = 0; i < sentences.length; i += SENTENCES_PER_REFINED_PARAGRAPH) {
		paragraphs.push(
			sentences.slice(i, i + SENTENCES_PER_REFINED_PARAGRAPH).join(" "),
		);
	}
	return paragraphs;
}

function buildRefinedParagraphsFromLines(
	lines: RefinedTranscriptLine[],
	deleteIds: Set<number>,
): string[] {
	const paragraphs: string[] = [];
	let currentSpeaker: string | null = null;
	let currentParts: string[] = [];
	let currentLength = 0;

	const flush = () => {
		if (currentParts.length > 0) {
			for (const para of splitIntoReadableParagraphs(currentParts.join(" "))) {
				paragraphs.push(para);
			}
		}
		currentSpeaker = null;
		currentParts = [];
		currentLength = 0;
	};

	for (const line of lines) {
		if (deleteIds.has(line.id)) continue;
		const text = line.text.trim();
		if (!text) continue;

		const { speaker } = splitSpeakerPrefix(text);
		const canJoin =
			currentParts.length > 0 &&
			speaker !== null &&
			speaker === currentSpeaker &&
			currentLength + text.length < 2000;

		if (!canJoin) flush();
		currentSpeaker = speaker;
		currentParts.push(text);
		currentLength += text.length + 1;
	}

	flush();
	return paragraphs;
}

function buildRawRefinedParagraphs(segments: VttSegment[]): string[] {
	return buildRefinedParagraphsFromLines(
		buildRefinedTranscriptLines(segments),
		new Set(),
	);
}

async function generateLosslessFilteredRefined(
	segments: VttSegment[],
	context: AiCallContext,
	logLabel: string,
): Promise<{
	paragraphs: string[];
	inputTokens: number;
	outputTokens: number;
}> {
	const lines = buildRefinedTranscriptLines(segments);
	if (lines.length === 0) {
		return { paragraphs: [], inputTokens: 0, outputTokens: 0 };
	}

	const deterministicDeleteIds = new Set(
		lines
			.filter((line) => isPureAcknowledgementLine(line))
			.map((line) => line.id),
	);
	let inputTokens = 0;
	let outputTokens = 0;

	try {
		const refinedResult = await callAiApi(
			buildRefinedDeletePrompt(lines),
			{ json: true },
			context,
		);
		inputTokens += refinedResult.inputTokens;
		outputTokens += refinedResult.outputTokens;

		const { text: guardedJson, runaway } = stripRunawayRepetition(
			refinedResult.content,
		);
		if (runaway) {
			console.warn(
				`[generate-ai] refined delete classifier runaway truncated (${logLabel})`,
			);
		}

		const modelDeleteIds = parseRefinedDeleteIds(guardedJson, lines);
		for (const id of modelDeleteIds) {
			const line = lines[id];
			if (line && isSafeRefinedDelete(line, lines)) {
				deterministicDeleteIds.add(id);
			}
		}
	} catch (error) {
		console.warn(
			`[generate-ai] refined delete classifier failed; keeping raw lines (${logLabel})`,
			error,
		);
	}

	return {
		paragraphs: buildRefinedParagraphsFromLines(
			lines,
			guardDeletesForProtectedTokens(lines, deterministicDeleteIds),
		),
		inputTokens,
		outputTokens,
	};
}

async function generateSingleChunk(
	segments: VttSegment[],
	videoDuration: number,
	languageInstruction: string,
	context: AiCallContext,
	includeRefinedTranscript: boolean,
): Promise<AiResult> {
	const transcriptWithTimestamps = segments
		.map(
			(s) =>
				`[${Math.floor(s.start / 60)}:${String(s.start % 60).padStart(2, "0")}] ${s.text}`,
		)
		.join("\n");

	const schemaExample = `{
  "title": "Weekly Team Sync",
  "summary": "The team discussed Q3 roadmap priorities and resolved the deployment blocker.",
  "chapters": [{"title": "Intro", "start": 0}],
  "aiSummary": {
    "overview": "A weekly sync covering roadmap and blockers.",
    "topics": [{"title": "Q3 Roadmap", "body": "The team aligned on three key priorities."}],
    "nextSteps": ["Share updated roadmap doc by Friday"],
    "tasks": [{"title": "Update roadmap", "assignee": "Alice", "priority": "high", "deadline": "2024-07-05", "done": false}],
    "chapters": [{"startSec": 0, "title": "Intro", "body": "Brief intro and agenda."}, {"startSec": 45, "title": "Q3 Roadmap", "body": "Discussion of top priorities."}]
  }
}`;

	// NOTE: refinedTranscript is intentionally NOT requested here. The refined
	// transcript is (near) the FULL raw transcript and on its own can approach or
	// exceed the 65536 maxOutputTokens cap. Asking for it together with
	// summary/tasks/chapters in one JSON response caused the combined output to
	// overflow the cap and TRUNCATE the refined transcript (or invalidate the
	// whole JSON). It is generated separately below with its own dedicated call,
	// exactly like the multi-chunk path does.
	const prompt = `You are analyzing a meeting/video transcript. The content may be in Uzbek, Russian, or English. Respond in the same language as the content.

The video is ${videoDuration} seconds long. ${languageInstruction}

Extract structured data in JSON format. Return ONLY valid JSON with this exact structure:
${schemaExample}

Rules:
- "start" and "startSec" are INTEGER SECONDS from the start of the video — NOT minutes and NOT "mm:ss". A transcript label like [1:40] means start=100; [7:07] means start=427. Every value MUST be a whole number between 0 and ${videoDuration}, and must NEVER exceed ${videoDuration}.
- tasks[].priority must be "high", "medium", or "low"
- tasks[].done is always false unless explicitly resolved in the transcript
- Keep ALL JSON property names exactly as shown
- In aiSummary.overview, topics[].title, topics[].body and nextSteps, use markdown **bold** VERY sparingly — bold at most the 1–2 single most important terms or names per field. Do NOT bold every foreign/technical word and do NOT copy the transcript's bold density.
${MIXED_LANGUAGE_PRESERVATION_RULES}

Transcript:
${transcriptWithTimestamps}`;

	const apiResult = await callAiApi(prompt, {}, context);
	const parsed = parseAiResponse(apiResult.content);

	// Full cleaned transcripts are useful but expensive because output length is
	// close to raw transcript length. Keep them automatic only for short videos.
	const refined = includeRefinedTranscript
		? await generateChapterAlignedRefined(
				segments,
				(parsed.chapters ?? []).map((c) => ({
					startSec: c.start,
					title: c.title,
				})),
				context,
			)
		: { chapters: [], inputTokens: 0, outputTokens: 0 };
	const refinedChapters = refined.chapters;

	// Attach the separately-generated refined transcript. If the summary JSON
	// failed to parse (aiSummary === null) but we still cleaned the transcript,
	// build a minimal aiSummary so Refined is never lost.
	const aiSummaryWithRefined =
		parsed.aiSummary == null
			? refinedChapters.length > 0
				? parseAiSummary({
						refinedTranscript: { chapters: refinedChapters },
					})
				: parsed.aiSummary
			: {
					...parsed.aiSummary,
					refinedTranscript: { chapters: refinedChapters },
				};

	return {
		...parsed,
		aiSummary: aiSummaryWithRefined,
		_usage: {
			model: apiResult.model,
			inputTokens: apiResult.inputTokens + refined.inputTokens,
			outputTokens: apiResult.outputTokens + refined.outputTokens,
		},
	};
}

// Produces a chapter-aligned refined transcript: for each finalized summary
// chapter, clean ONLY the transcript segments that fall under that chapter's
// time range. This makes the "Refined" tab split into the SAME sections as the
// raw "Matn" tab (same count/titles/startSec) instead of coarse ~24KB chunks.
// Each chapter is filtered by a dedicated JSON delete-classifier call; kept cue
// text is never rewritten. Falls back to the raw slice text if filtering fails.
/**
 * Force the summary chapters and the refined-transcript chapters to be the SAME
 * set. generateChapterAlignedRefined emits a refined chapter only for windows
 * that actually contain transcript segments; a summary chapter whose window is
 * empty (a dead-zone boundary, common with inflated/runaway VTT timestamps) has
 * no refined counterpart. Keeping both lists in sync prevents the intermittent
 * "chala" bug where the "Matn" tab shows a heading with no refined body.
 * Matches by startSec (refined ranges reuse the chapter startSec verbatim).
 * If the intersection is empty (e.g. summary had no chapters), the original list
 * is returned unchanged so we never blank out a usable summary.
 */
export function alignChaptersToRefined<T extends { startSec: number }>(
	chapters: T[],
	refinedChapters: { startSec: number }[],
): T[] {
	if (refinedChapters.length === 0) return chapters;
	const refinedStarts = new Set(refinedChapters.map((c) => c.startSec));
	const aligned = chapters.filter((c) => refinedStarts.has(c.startSec));
	return aligned.length > 0 ? aligned : chapters;
}

async function generateChapterAlignedRefined(
	segments: VttSegment[],
	chapters: { startSec: number; title: string }[],
	context: AiCallContext,
): Promise<{
	chapters: { startSec: number; title: string; paragraphs: string[] }[];
	inputTokens: number;
	outputTokens: number;
}> {
	const sorted = [...chapters]
		.filter((c) => Number.isFinite(c.startSec))
		.sort((a, b) => a.startSec - b.startSec);

	// No usable chapters (e.g. summary JSON failed) → clean the whole transcript
	// as a single section so the Refined tab is never empty.
	const ranges =
		sorted.length > 0
			? sorted.map((c, i) => ({
					startSec: c.startSec,
					title: c.title,
					endSec: sorted[i + 1]?.startSec ?? Number.POSITIVE_INFINITY,
				}))
			: [
					{
						startSec: segments[0]?.start ?? 0,
						title: "Transcript",
						endSec: Number.POSITIVE_INFINITY,
					},
				];

	let inputTokens = 0;
	let outputTokens = 0;

	const results = await mapWithConcurrency(
		ranges,
		AI_CHUNK_CONCURRENCY,
		async (range) => {
			const slice = segments.filter(
				(s) => s.start >= range.startSec && s.start < range.endSec,
			);
			if (slice.length === 0) return null;

			let paragraphs: string[] = [];
			try {
				const refined = await generateLosslessFilteredRefined(
					slice,
					context,
					`chapter startSec=${range.startSec}`,
				);
				inputTokens += refined.inputTokens;
				outputTokens += refined.outputTokens;
				paragraphs = refined.paragraphs;
			} catch (error) {
				console.error(
					"[generate-ai] chapter-aligned refine failed for chapter; using raw slice",
					{ startSec: range.startSec, error },
				);
			}

			if (paragraphs.length === 0) {
				paragraphs = buildRawRefinedParagraphs(slice);
			}

			return {
				startSec: range.startSec,
				title: range.title,
				paragraphs,
			};
		},
	);

	const out = results.filter(
		(r): r is { startSec: number; title: string; paragraphs: string[] } =>
			r !== null,
	);

	return { chapters: out, inputTokens, outputTokens };
}

/**
 * Fetch AI content and JSON-parse it; on a parse failure make EXACTLY ONE
 * fresh attempt (a fresh Gemini call usually returns well-formed JSON — the
 * failures are stochastic truncation/markdown noise, not deterministic).
 * Token usage from ALL attempts is accumulated (both were paid for).
 * Returns parsed:null after both attempts fail; the caller decides fallback.
 */
export async function parseJsonWithRetry(
	fetchContent: (attempt: number) => Promise<{
		content: string;
		inputTokens: number;
		outputTokens: number;
		model: string;
	}>,
	label: string,
): Promise<{
	parsed: Record<string, unknown> | null;
	inputTokens: number;
	outputTokens: number;
	model: string;
}> {
	let inputTokens = 0;
	let outputTokens = 0;
	let model = "unknown";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = await fetchContent(attempt);
		inputTokens += result.inputTokens;
		outputTokens += result.outputTokens;
		model = result.model;
		try {
			return {
				parsed: JSON.parse(cleanJsonResponse(result.content).trim()),
				inputTokens,
				outputTokens,
				model,
			};
		} catch {
			console.error(
				`[generate-ai] ${label} JSON parse FAILED (attempt ${attempt}/2)`,
				{
					contentLength: result.content.length,
					tail: result.content.slice(-150),
				},
			);
		}
	}
	return { parsed: null, inputTokens, outputTokens, model };
}

async function generateMultipleChunks(
	chunks: TranscriptChunk[],
	videoDuration: number,
	languageInstruction: string,
	context: AiCallContext,
	includeRefinedTranscript: boolean,
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
		rawText: string;
	}[] = [];

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let usedModel = "unknown";

	const chunkResults = await mapWithConcurrency(
		chunks,
		AI_CHUNK_CONCURRENCY,
		async (chunk, i) => {
			if (!chunk) return null;

			const chunkPrompt = `You are data365 AI, an expert at analyzing video content. This is section ${i + 1} of ${chunks.length} from a video that is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). This section covers timestamp ${Math.floor(chunk.startTime / 60)}:${String(chunk.startTime % 60).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(chunk.endTime % 60).padStart(2, "0")}.

Analyze this section thoroughly and provide JSON:
{
  "summary": "string (detailed summary of this section - capture ALL key points, topics discussed, decisions made, or concepts explained. Include specific details like names, numbers, action items, and conclusions. This should be 3-6 sentences minimum.)",
  "keyPoints": ["string (specific key point or takeaway)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

${languageInstruction}
Keep JSON property names exactly as shown.
IMPORTANT: All chapter "start" values MUST be between ${chunk.startTime} and ${chunk.endTime} seconds. The total video is only ${videoDuration} seconds long.
Be thorough - this summary will be combined with other sections to create a comprehensive overview.
${MIXED_LANGUAGE_PRESERVATION_RULES}
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${chunk.text}`;

			const { parsed, inputTokens, outputTokens, model } =
				await parseJsonWithRetry(
					() => callAiApi(chunkPrompt, {}, context),
					`per-chunk summary [${chunk.startTime}-${chunk.endTime}s]`,
				);
			totalInputTokens += inputTokens;
			totalOutputTokens += outputTokens;
			usedModel = model;
			if (!parsed) {
				console.error(
					"[generate-ai] per-chunk summary FAILED after retry (chunk skipped)",
					{ startTime: chunk.startTime, endTime: chunk.endTime },
				);
				return null;
			}
			return {
				summary: (parsed.summary as string) || "",
				keyPoints: (parsed.keyPoints as string[]) || [],
				chapters: (parsed.chapters as { title: string; start: number }[]) || [],
				startTime: chunk.startTime,
				endTime: chunk.endTime,
				rawText: chunk.text,
			};
		},
	);

	chunkSummaries.push(
		...chunkResults.filter(
			(
				r,
			): r is {
				summary: string;
				keyPoints: string[];
				chapters: { title: string; start: number }[];
				startTime: number;
				endTime: number;
				rawText: string;
			} => r !== null,
		),
	);

	// Per-chunk refined cleaning: clean raw transcript text, do NOT summarize.
	// Iterates the ORIGINAL chunks array so every chunk is cleaned regardless of
	// whether its summary JSON parsed successfully.
	const refinedChapters: {
		startSec: number;
		title: string;
		paragraphs: string[];
	}[] = [];
	if (includeRefinedTranscript) {
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk) continue;
			// Use chapter title from the matching summary if available, else "Part N"
			const matchedSummary = chunkSummaries.find(
				(cs) => cs.startTime === chunk.startTime,
			);
			const chapterTitle =
				matchedSummary?.chapters[0]?.title ?? `Part ${i + 1}`;
			// A single failing chunk call must not abort the whole loop and silently
			// collapse the refined transcript to []. Fall back to raw text instead.
			try {
				const refined = await generateLosslessFilteredRefined(
					chunk.segments,
					context,
					`chunk ${i + 1}/${chunks.length}`,
				);
				totalInputTokens += refined.inputTokens;
				totalOutputTokens += refined.outputTokens;
				const paragraphs =
					refined.paragraphs.length > 0
						? refined.paragraphs
						: buildRawRefinedParagraphs(chunk.segments);
				refinedChapters.push({
					startSec: chunk.startTime,
					title: chapterTitle,
					paragraphs,
				});
			} catch (error) {
				console.warn(
					`[generate-ai] Refined transcript chunk ${i + 1}/${chunks.length} failed; using raw text`,
					error,
				);
				const rawParagraphs = buildRawRefinedParagraphs(chunk.segments);
				refinedChapters.push({
					startSec: chunk.startTime,
					title: chapterTitle,
					paragraphs: rawParagraphs.length > 0 ? rawParagraphs : [chunk.text],
				});
			}
		}
	}

	const allChapters: { title: string; start: number }[] = [];
	const sortedChapters = chunkSummaries
		.flatMap((c) => c.chapters)
		.sort((a, b) => a.start - b.start);
	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	for (const chapter of sortedChapters) {
		const lastChapter = allChapters[allChapters.length - 1];
		if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= minGap) {
			allChapters.push(chapter);
		}
	}

	const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${Math.floor(c.startTime / 60)}:${String(c.startTime % 60).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(c.endTime % 60).padStart(2, "0")}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");

	const aiSummaryChaptersFromChunks = chunkSummaries.flatMap((c) =>
		c.chapters.map((ch) => ({
			startSec: ch.start,
			title: ch.title,
			body: "",
		})),
	);

	const schemaExample = `{
  "title": "Weekly Team Sync",
  "summary": "The team discussed Q3 roadmap priorities and resolved the deployment blocker.",
  "aiSummary": {
    "overview": "A weekly sync covering roadmap and blockers.",
    "topics": [{"title": "Q3 Roadmap", "body": "The team aligned on three key priorities."}],
    "nextSteps": ["Share updated roadmap doc by Friday"],
    "tasks": [{"title": "Update roadmap", "assignee": "Alice", "priority": "high", "deadline": "2024-07-05", "done": false}],
    "chapters": [{"startSec": 0, "title": "Intro", "body": "Brief intro and agenda."}, {"startSec": 45, "title": "Q3 Roadmap", "body": "Discussion of top priorities."}],
    "refinedTranscript": {
      "chapters": [{"startSec": 0, "title": "Intro", "paragraphs": ["Welcome everyone.", "Today we cover roadmap and blockers."]}]
    }
  }
}`;

	const finalPrompt = `You are analyzing a meeting/video transcript. The content may be in Uzbek, Russian, or English. Respond in the same language as the content.

Based on these section analyses, produce a final JSON summary. ${languageInstruction}

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}

Return ONLY valid JSON with this exact structure:
${schemaExample}

Rules:
- aiSummary.chapters[].startSec must be INTEGER SECONDS (not minutes, not mm:ss) between 0 and ${videoDuration}; e.g. the label [1:40] means startSec=100. Use the section timestamps provided above and never exceed ${videoDuration}.
- tasks[].priority must be "high", "medium", or "low"
- refinedTranscript.chapters may be left as an empty array — it is handled separately
- Keep ALL JSON property names exactly as shown
- In aiSummary.overview, topics[].title, topics[].body and nextSteps, use markdown **bold** VERY sparingly — bold at most the 1–2 single most important terms or names per field. Do NOT bold every foreign/technical word and do NOT copy the transcript's bold density.
${MIXED_LANGUAGE_PRESERVATION_RULES}`;

	const {
		parsed,
		inputTokens: finalInputTokens,
		outputTokens: finalOutputTokens,
		model: finalModel,
	} = await parseJsonWithRetry(
		() => callAiApi(finalPrompt, {}, context),
		"final synthesis",
	);
	totalInputTokens += finalInputTokens;
	totalOutputTokens += finalOutputTokens;
	usedModel = finalModel;
	if (parsed) {
		const aiSummaryRaw = parsed.aiSummary ?? {
			overview: parsed.summary ?? "",
			topics: [],
			nextSteps: [],
			tasks: [],
			chapters: aiSummaryChaptersFromChunks,
			refinedTranscript: { chapters: [] },
		};
		// Override refinedTranscript with the per-chunk cleaned result when this
		// run intentionally paid for it; otherwise clear any model-invented value.
		if (includeRefinedTranscript) {
			if (aiSummaryRaw && typeof aiSummaryRaw === "object") {
				(aiSummaryRaw as Record<string, unknown>).refinedTranscript = {
					chapters: refinedChapters,
				};
			}
		} else if (aiSummaryRaw && typeof aiSummaryRaw === "object") {
			(aiSummaryRaw as Record<string, unknown>).refinedTranscript = {
				chapters: [],
			};
		}
		return {
			title: parsed.title as string,
			summary: parsed.summary as string,
			chapters: allChapters,
			aiSummary: parseAiSummary(aiSummaryRaw),
			_usage: {
				model: usedModel,
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
			},
		};
	}
	const fallbackSummary = chunkSummaries
		.map((c, i) => `**Part ${i + 1}:** ${c.summary}`)
		.join("\n\n");
	const keyPointsSummary =
		allKeyPoints.length > 0
			? `\n\n**Key Points:**\n${allKeyPoints.map((p) => `- ${p}`).join("\n")}`
			: "";
	return {
		title: "Video Summary",
		summary: fallbackSummary + keyPointsSummary,
		chapters: allChapters,
		aiSummary: parseAiSummary({
			overview: fallbackSummary,
			topics: [],
			nextSteps: [],
			tasks: [],
			chapters: aiSummaryChaptersFromChunks,
			refinedTranscript: { chapters: refinedChapters },
		}),
		_usage: {
			model: usedModel,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
		},
	};
}

function parseAiResponse(content: string): AiResult {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());

		const chapters = Array.isArray(data.chapters)
			? data.chapters
					.filter(
						(ch: { start?: number }) =>
							typeof ch.start === "number" && ch.start >= 0,
					)
					.sort(
						(a: { start: number }, b: { start: number }) => a.start - b.start,
					)
			: [];

		return {
			title: data.title,
			summary: data.summary,
			chapters,
			aiSummary: parseAiSummary(data.aiSummary ?? null),
		};
	} catch {
		console.error(
			"[generate-ai] summary JSON parse FAILED (likely truncated)",
			{ contentLength: content.length, tail: content.slice(-150) },
		);
		return {
			title: "Generated Title",
			summary: AI_SUMMARY_FAILURE_PLACEHOLDER,
			chapters: [],
			aiSummary: null,
		};
	}
}
