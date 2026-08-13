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

type AiStatusResult = {
	processing: boolean;
	aiGenerationStatus: AiGenerationStatus | null;
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
			const terminal =
				d.hasContent ||
				d.aiGenerationStatus === "COMPLETE" ||
				d.aiGenerationStatus === "ERROR" ||
				d.aiGenerationStatus === "SKIPPED";
			return terminal ? false : intervalMs;
		},
		retry: 2,
		retryDelay: 1000,
	});
};
