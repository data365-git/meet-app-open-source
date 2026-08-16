import type { Video } from "@cap/web-domain";
import { useQuery } from "@tanstack/react-query";

export type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

export type AiProcessingStep = "transcribe" | "summary" | "refined" | "done";
export type AiProcessingSubStep = "extract_audio";

export type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

type AiStatusResult = {
	processing: boolean;
	aiGenerationStatus: AiGenerationStatus | null;
	/** Live transcription status — the share page used to read this only from
	 * the server-rendered prop, so a job that had really started still looked
	 * "not started" until a manual page reload. */
	transcriptionStatus: TranscriptionStatus | null;
	/** The user's press is banked (or not yet claimed by the workflow).
	 * Computed server-side from metadata so it survives polls and remounts. */
	aiRequestPending: boolean;
	aiProcessingStep: AiProcessingStep | null;
	/** Fine sub-phase inside "transcribe" ("videodan audio ajratilyapti"). */
	aiProcessingSubStep: AiProcessingSubStep | null;
	hasContent: boolean;
	/** Fine-grained transcription chunk progress ("Gemini'ga N/M audio yuborildi"). */
	transcriptionChunksCompleted: number | null;
	transcriptionChunksTotal: number | null;
	/** Fine-grained summary/refine chunk progress, reset at each stage transition. */
	aiStageChunksCompleted: number | null;
	aiStageChunksTotal: number | null;
};

/**
 * Is this poll result a state the client can stop polling on?
 *
 * `hasContent` alone is NOT terminal: a re-analysis runs against a video that
 * already has a summary, so the endpoint answers with the OLD content while
 * the new run is QUEUED/PROCESSING — treating that as terminal stopped the
 * poll mid-run and dropped the page back to a "not running" view.
 * Exported so ShareVideo's stop-polling effect uses the same rule instead of
 * a second, drifting copy.
 */
export const isAiStatusTerminal = (d: {
	hasContent: boolean;
	aiGenerationStatus: AiGenerationStatus | null;
}): boolean => {
	if (
		d.aiGenerationStatus === "QUEUED" ||
		d.aiGenerationStatus === "PROCESSING"
	)
		return false;
	return (
		d.hasContent ||
		d.aiGenerationStatus === "COMPLETE" ||
		d.aiGenerationStatus === "ERROR" ||
		d.aiGenerationStatus === "SKIPPED"
	);
};

export const useAiStatus = (
	videoId: Video.VideoId,
	enabled: boolean,
	// Dashboard grids can enable this hook for several cards at once (one per
	// video with an active AI run); a longer default there keeps polling load
	// sensible without slowing the single-video share page (which keeps 4s).
	intervalMs = 4000,
) => {
	return useQuery({
		queryKey: ["ai-status", videoId],
		queryFn: async (): Promise<AiStatusResult> => {
			const res = await fetch(`/api/video/ai?videoId=${videoId}`);
			if (!res.ok) {
				throw new Error("AI_STATUS_FAILED");
			}
			const body = await res.json();
			return {
				processing: !!body.processing,
				aiGenerationStatus: body.aiGenerationStatus ?? null,
				transcriptionStatus: body.transcriptionStatus ?? null,
				aiRequestPending: !!body.aiRequestPending,
				aiProcessingStep: body.aiProcessingStep ?? null,
				aiProcessingSubStep: body.aiProcessingSubStep ?? null,
				hasContent: !!(body.summary || body.chapters),
				transcriptionChunksCompleted:
					body.transcriptionChunksCompleted ?? null,
				transcriptionChunksTotal: body.transcriptionChunksTotal ?? null,
				aiStageChunksCompleted: body.aiStageChunksCompleted ?? null,
				aiStageChunksTotal: body.aiStageChunksTotal ?? null,
			};
		},
		enabled,
		refetchOnWindowFocus: false,
		refetchInterval: (query) => {
			const d = query.state.data;
			if (!d) return intervalMs;
			return isAiStatusTerminal(d) ? false : intervalMs;
		},
		retry: 2,
		retryDelay: 1000,
	});
};
