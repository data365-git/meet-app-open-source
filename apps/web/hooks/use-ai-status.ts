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

/** Carries the HTTP status so the poll can tell "never" from "not now". */
export class AiStatusRequestError extends Error {
	constructor(readonly status: number) {
		super(`AI_STATUS_FAILED_${status}`);
		this.name = "AiStatusRequestError";
	}
}

/**
 * Is this failure permanent? 401/403 mean this viewer may never read the
 * status (a public share-link visitor), 404 means the video is gone. Anything
 * else — 500, 502, a proxy blip, a dropped connection — is temporary and the
 * poll must survive it.
 */
const isPermanentAiStatusFailure = (error: unknown): boolean =>
	error instanceof AiStatusRequestError &&
	(error.status === 401 || error.status === 403 || error.status === 404);

/**
 * When may this poll fire again? Exported so the rule is assertable — an
 * unasserted rule is not a rule, and every live defect here has been either
 * "the poll never stopped" or "the poll stopped and never came back".
 *
 * A poll that can never succeed must stop: the query function throws on any
 * non-OK response and `data` then never lands, so an interval keyed only on
 * `data` would fire every 4s for as long as the tab stays open.
 *
 * But a poll that hits ONE transient failure must NOT stop. `retry: 2` retires
 * a query within ~2s, and nothing in the share page re-arms it without a
 * button press — so treating every error as fatal froze the panel on "AI
 * analysis running" after a single 502 mid-transcription, recoverable only by
 * the page reload this whole feature exists to remove.
 */
export const nextAiStatusPollInterval = (
	query: {
		status: "pending" | "error" | "success";
		data?: AiStatusResult;
		error?: unknown;
	},
	intervalMs: number,
): number | false => {
	if (query.status === "error")
		return isPermanentAiStatusFailure(query.error) ? false : intervalMs;
	if (!query.data) return intervalMs;
	return isAiStatusTerminal(query.data) ? false : intervalMs;
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
				throw new AiStatusRequestError(res.status);
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
		refetchInterval: (query) =>
			nextAiStatusPollInterval(
				{
					status: query.state.status,
					data: query.state.data,
					error: query.state.error,
				},
				intervalMs,
			),
		retry: 2,
		retryDelay: 1000,
	});
};
