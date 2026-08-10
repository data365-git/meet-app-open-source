/**
 * Type definitions for JSON metadata fields
 */

export interface AiSummary {
	overview: string;
	topics: { title: string; body: string }[];
	nextSteps: string[];
	tasks: {
		title: string;
		assignee: string;
		priority: "high" | "medium" | "low";
		deadline: string;
		done: boolean;
		/** Theme bucket for the Vazifalar grouping (T8). Language-neutral — the
		 * base summary carries it; translations copy it over from the base. */
		category?: string;
	}[];
	chapters: { startSec: number; title: string; body: string }[];
	refinedTranscript: {
		chapters: { startSec: number; title: string; paragraphs: string[] }[];
	};
}

/**
 * Languages offered for on-demand multi-language analysis (ИSH 3).
 * The enum in web-domain supports 24 codes, but the share-page picker is uz/ru/en.
 */
export type ShareLanguage = "uz" | "ru" | "en";

export type TranslationStatus = "PROCESSING" | "COMPLETE" | "ERROR";

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	/**
	 * Custom created date that can be edited by the user
	 * This overrides the display of the actual createdAt timestamp
	 */
	customCreatedAt?: string;
	/**
	 * Title of the captured monitor or window
	 */
	sourceName?: string;
	/**
	 * AI generated title for the video
	 */
	aiTitle?: string;
	titleManuallyEdited?: boolean;
	/**
	 * AI generated summary of the content
	 */
	summary?: string;
	/**
	 * Chapter markers generated from the transcript
	 */
	chapters?: { title: string; start: number }[];
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	aiProcessingStep?: "transcribe" | "summary" | "refined" | "done";
	/**
	 * Fine sub-phase marker inside the "transcribe" step, written by the workflow
	 * at the moment the phase actually starts — the UI must never claim a step it
	 * cannot prove from metadata. "extract_audio" = ffmpeg is splitting the video
	 * into audio chunks (before any chunk totals exist). Cleared as soon as chunk
	 * progress (transcriptionChunksCompleted/Total) takes over.
	 */
	aiProcessingSubStep?: "extract_audio";
	aiGenerationRequestedAt?: string;
	aiGenerationRequestedBy?: string;
	aiGenerationError?: string;
	/**
	 * Why the last transcription attempt died. `QUOTA` = the AI account is out of
	 * credits / rate-limited — transient, auto-retried by recover-stale-ai-jobs.
	 * `FAILED` = a genuine transcription failure — terminal, manual retry only.
	 * Cleared on entry (validateVideo) and on success (saveTranscription).
	 */
	transcriptionError?: {
		code: "QUOTA" | "FAILED";
		message: string;
		at: string;
	};
	/** Bounded counter for QUOTA re-kicks. Distinct from autoRecoverAttempts,
	 * which counts stale-PROCESSING recoveries. Reset on success. */
	quotaRetryAttempts?: number;
	/** ISO time before which the quota re-kick must not run again (backoff).
	 * Without it a flat attempt cap burns out hours before credits return. */
	quotaRetryNextAt?: string;
	/** ISO timestamp set when transcription starts; used by recover-stale-ai-jobs to detect staleness. */
	processingStartedAt?: string;
	/** ISO timestamp set when AI generation starts; used by recover-stale-ai-jobs to detect staleness. */
	aiProcessingStartedAt?: string;
	/** Per-job AI cost mode. */
	aiMode?: "fast" | "cheap";
	/** ISO timestamp of the first AI job start; used by the cheap -> paid ladder. */
	aiJobStartedAt?: string;
	/** True while a cheap job is waiting for free-tier quota to refresh. */
	aiQuotaWaiting?: boolean;
	/** Cheap-mode chunks submitted to the Gemini Batch API, awaiting collection by
	 * the poll-batch-jobs cron. Each entry is dropped once merged into the partial
	 * checkpoint (succeeded) or abandoned (failed / 4h paid flip). */
	aiBatchJobs?: Array<{
		batchName: string;
		fileName: string;
		startSec: number;
		durationSec: number;
		/** Rescale anchor captured at submit — same value the Standard path feeds
		 * rescaleChunkVtt. Without it a collected Batch chunk was merged with
		 * Gemini's RAW clock while Standard chunks were rescaled, leaving two
		 * different clocks in one recording (found by an independent review,
		 * verified 2026-07-29). Optional: jobs submitted before this field exist
		 * without it — the collector falls back to durationSec. */
		speechSpanSec?: number;
		submittedAt: string;
	}>;
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	isDemo?: boolean;
	aiSummary?: AiSummary | null;
	transcriptionChunksCompleted?: number;
	transcriptionChunksTotal?: number;
	/**
	 * Per-stage chunk progress for the summary/refine AI passes (T3 fine-grained
	 * status). Written from inside the generate-ai fan-out; reset at each stage
	 * transition. Distinct from the transcription counters above.
	 */
	aiStageChunksCompleted?: number;
	aiStageChunksTotal?: number;
	/**
	 * Holes (>120s) left in the final transcript after the gap-fill pass —
	 * either genuine silence or a stretch the ASR persistently failed on.
	 * Absent/undefined when the transcript is fully covered.
	 */
	transcriptionGaps?: { startSec: number; endSec: number }[];
	/**
	 * True when the video's total duration was unknown at gap-fill time, so
	 * `transcriptionGaps` could not detect trailing/whole-file holes — a video
	 * can show COMPLETE with no recorded gaps despite stopping early.
	 */
	transcriptionCoverageUnknown?: boolean;
	/** On-demand per-file Scribe timing refinement. Gemini remains the default. */
	timestampRefinement?: {
		status: "PROCESSING" | "COMPLETE" | "ERROR";
		requestedAt: string;
		completedAt?: string;
		model?: "elevenlabs-scribe-v2";
		error?:
			| "missing_key"
			| "missing_transcript"
			| "no_audio"
			| "low_confidence"
			| "failed";
		shiftedCueCount?: number;
		meanShiftSec?: number;
	};
	/**
	 * Multi-language analysis (ИSH 3). The base `aiSummary` above is the original
	 * generation; `aiSummaryByLanguage` holds on-demand-translated cached versions.
	 * Translated caption/transcript VTT lives in R2 at
	 * `{ownerId}/{videoId}/transcription.{lang}.vtt`.
	 */
	aiBaseLanguage?: ShareLanguage;
	aiSummaryByLanguage?: Partial<Record<ShareLanguage, AiSummary>>;
	aiTranslationStatus?: Partial<Record<ShareLanguage, TranslationStatus>>;
	/** Per-video default display language, set by owner/org member. */
	preferredLanguage?: ShareLanguage;
	/** True when the imported file was audio-only (no video track). */
	isAudio?: boolean;
	/** Count of automatic re-kicks recover-stale-ai-jobs has performed for this video (D1-C). */
	autoRecoverAttempts?: number;
	/** Set when the nightly storage reconciliation cron could not find this video's S3 object (D3b). */
	storageMissing?: boolean;
	/**
	 * True when a trim cut removed the exact source point a chapter marker (or
	 * a translated language's chapter set) pointed to and no clean remap was
	 * possible. The stale chapters were DROPPED rather than shown at a wrong
	 * time — re-run AI generation to regenerate them against the new timeline.
	 */
	chaptersStaleAfterTrim?: boolean;
}

export type VideoEditRange = {
	start: number;
	end: number;
};

export type VideoEditSpec = {
	version: 1;
	sourceDuration: number;
	keepRanges: VideoEditRange[];
};

/**
 * Space metadata structure
 */
export interface SpaceMetadata {
	[key: string]: never;
}

/**
 * User metadata structure
 */
export interface UserMetadata {
	[key: string]: never;
}
