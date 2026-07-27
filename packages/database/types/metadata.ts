/**
 * Type definitions for JSON metadata fields
 */

export interface AiSummary {
	overview: string;
	topics: { title: string; body: string }[];
	nextSteps: string[];
	tasks: {
		title: string;
		/** Context group label (a person, workstream, or stage — the AI's chosen axis). */
		category?: string;
		assignee: string;
		priority: "high" | "medium" | "low";
		deadline: string;
		done: boolean;
	}[];
	chapters: { startSec: number; title: string; body: string }[];
	refinedTranscript: {
		intro?: {
			participants: string[];
			duration: string;
			purpose: string;
		};
		chapters: { startSec: number; title: string; paragraphs: string[] }[];
	};
}

export type PipelinePhaseKey = "audio" | "transcribe" | "analyze" | "index";

export interface PipelinePhase {
	key: PipelinePhaseKey;
	/** Uzbek: Audio tayyorlash | Transkripsiya | AI tahlil | AI indekslash */
	label: string;
	status: "queued" | "active" | "done" | "error";
	/** units completed */
	done: number;
	/** total units (chunks); audio: 100 if % parsed else 0; analyze: 1 (atomic) */
	total: number;
	startedAt?: string; // ISO
	completedAt?: string; // ISO
	/** transcribe/index: per-chunk wall-clock durations in ms (for median ETA) */
	unitTimesMs?: number[];
	/** Index of the chunk currently being processed (0-based) */
	activeUnitIndex?: number;
	/** ISO timestamp when the current chunk started processing */
	activeUnitStartedAt?: string;
	/** Human-readable label for what the current chunk is doing */
	activeUnitLabel?: string;
	/** Estimated seconds remaining for the current chunk */
	activeUnitEtaSec?: number;
}

export interface PipelineProgress {
	currentPhase: PipelinePhaseKey;
	phases: PipelinePhase[];
	startedAt: string; // overall ISO
	updatedAt: string; // ISO
}

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
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	isDemo?: boolean;
	aiSummary?: AiSummary | null;
	/**
	 * Live transcription progress (0-100) while a long audio is being
	 * transcribed in chunks. Used to show a percentage in the UI.
	 */
	transcriptionProgress?: number;
	/**
	 * Live progress for the transcription → AI generation pipeline. Written by the
	 * transcribe + generate-ai workflows via read-modify-write into this JSON (no
	 * DB column). Exposes real units of work per phase so the frontend can build a
	 * counting-down ETA (per-chunk wall-clock times) and a real audio-conversion %.
	 * Phases execute in order: audio → transcribe → index → analyze.
	 */
	pipelineProgress?: PipelineProgress;
	/**
	 * Human-readable reason the transcription failed (the videos table has no
	 * errorMessage column). Cleared at the start of every transcription run.
	 */
	transcriptionError?: string;
	/**
	 * Set by the cancel endpoint to request that an in-flight transcription stop.
	 * The workflow checks this between chunk batches (cooperative cancellation) and
	 * settles as CANCELLED.
	 */
	cancelRequested?: boolean;
	/**
	 * Per-chunk VTT results for parallel transcription. Keys are chunk indices (as
	 * strings). Written after each chunk succeeds so a retry can skip already-done
	 * chunks. Cleared when transcription completes successfully.
	 */
	completedChunks?: Record<string, string>;
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
