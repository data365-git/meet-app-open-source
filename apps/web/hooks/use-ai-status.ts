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
	/** Durable "the user wants AI" flag (never cleared once set). Distinct from
	 * `aiRequestPending` — see `buildAiStatusFacts` in `lib/ai-request-pending.ts`. */
	aiGenerationRequested: boolean;
	/** Server-computed: that durable flag is older than the handoff can take,
	 * so the run it promised is never coming. Without it the flag is a one-way
	 * latch and the poll never stops on a job that died. */
	aiGenerationRequestStale: boolean;
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
	/** The silent pre-AI optimize/save stage (2026-08-18 wave 2, Change B) —
	 * `videoUploads` is already gone by the time this stage runs, so this is
	 * the only carrier for it. `processingStage` null means this stage is not
	 * running (either not started yet or already finished). */
	processingStage: "optimizing" | "saving" | null;
	processingPercent: number | null;
	processingUpdatedAt: string | null;
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
	/** Optional so existing call sites without the field keep compiling; a
	 * non-null stage means the silent optimize/save stage is still running,
	 * so the poll must not stop even if old AI content already exists. */
	processingStage?: "optimizing" | "saving" | null;
	/** Optional for the same reason. A banked-but-unclaimed AI request means
	 * there is still something to wait for even with no content and no
	 * `aiGenerationStatus` yet. */
	aiRequestPending?: boolean;
	/** Optional for the same reason. A transcription in flight is the one
	 * "still working" state that neither of the two fields above reports. */
	transcriptionStatus?: TranscriptionStatus | null;
	/** Optional for the same reason. The durable "AI was requested" flag —
	 * true across the multi-step gap between `transcriptionStatus:"COMPLETE"`
	 * and `generate-ai.ts` finally writing `aiGenerationStatus:"QUEUED"`. A
	 * poll landing in that gap must not be treated as terminal, or the summary
	 * generates invisibly and the page freezes until a manual reload. */
	aiGenerationRequested?: boolean;
	/** Optional for the same reason. Server-computed: the durable flag above is
	 * older than the handoff can legitimately take, so the run it promised is
	 * never coming (a workflow killed inside the gap). Computed on the SERVER,
	 * against the clock that wrote the marker — a viewer's device clock can be
	 * hours off, and this decides whether a poll ever stops. */
	aiGenerationRequestStale?: boolean;
}): boolean => {
	if (d.processingStage != null) return false;
	// A transcription in flight is NOT terminal, and nothing else here says so:
	// `aiRequestPending` is false the moment `transcriptionStatus` is truthy
	// (isAiRequestPending — "the press was already claimed"), and
	// `app/api/videos/[videoId]/generate/route.ts:107` deliberately leaves
	// `aiGenerationStatus` UNSET until the generation stage starts. Without
	// this line the fall-through below returns TRUE mid-transcription, the
	// poll stops, and the "Bo'lak N/M" progress line freezes until a manual
	// reload — the exact defect this file's other fixes exist to remove.
	if (d.transcriptionStatus === "PROCESSING") return false;
	if (
		d.aiGenerationStatus === "QUEUED" ||
		d.aiGenerationStatus === "PROCESSING"
	)
		return false;
	if (
		d.hasContent ||
		d.aiGenerationStatus === "COMPLETE" ||
		d.aiGenerationStatus === "ERROR" ||
		d.aiGenerationStatus === "SKIPPED"
	)
		return true;
	// No AI run ever started and the optimize/save stage has cleared: nothing
	// left to wait for, unless a banked request is about to claim the row, or
	// we are inside the transcribe.ts:1980 -> generate-ai.ts:120 handoff gap.
	//
	// That second exception is deliberately NARROW. Nothing ever clears
	// `aiGenerationRequestedAt` and no redeemer reads it, so a bare
	// `!d.aiGenerationRequested` keeps the poll alive FOREVER on every dead
	// job — transcription ERROR / NO_AUDIO / SKIPPED, or a row an operator
	// reset — which is the mirror image of the freeze this file exists to fix:
	// /api/video/ai every 4s for as long as the tab is open, and the panel
	// never falls through to its error+retry branch. It would also break the
	// rule ai-request-pending.ts states in its own words: a pending flag must
	// never trap a dead job. So the flag may hold the poll open only in the
	// state it was added for — transcription COMPLETE, generation not yet
	// queued — and only while that wait is still plausible.
	const awaitingAiHandoff =
		d.aiGenerationRequested === true &&
		d.transcriptionStatus === "COMPLETE" &&
		d.aiGenerationRequestStale !== true;
	return !d.aiRequestPending && !awaitingAiHandoff;
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
/** Give up on a route that keeps failing: 6 consecutive failed fetches. */
export const MAX_TRANSIENT_AI_STATUS_FAILURES = 6;

export const nextAiStatusPollInterval = (
	query: {
		status: "pending" | "error" | "success";
		data?: AiStatusResult;
		error?: unknown;
		failureCount?: number;
	},
	intervalMs: number,
): number | false => {
	if (query.status === "error") {
		if (isPermanentAiStatusFailure(query.error)) return false;
		const failures = query.failureCount ?? 0;
		// Bounded, and backing OFF while it lasts. Retrying a failing endpoint
		// every 4s from every open tab amplifies load exactly during an outage,
		// which is the mirror of the defect this branch was added to fix — so
		// the retry must be both slower each time and finite.
		if (failures >= MAX_TRANSIENT_AI_STATUS_FAILURES) return false;
		return Math.min(intervalMs * 2 ** Math.min(failures, 4), 60_000);
	}
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
				aiGenerationRequested: !!body.aiGenerationRequested,
				// Absent (an older server mid-rollout) reads as "not stale", so
				// the poll behaves exactly as it did before this bound existed
				// — the narrowing above still closes the dead-job cases.
				aiGenerationRequestStale: !!body.aiGenerationRequestStale,
				aiProcessingStep: body.aiProcessingStep ?? null,
				aiProcessingSubStep: body.aiProcessingSubStep ?? null,
				hasContent: !!(body.summary || body.chapters),
				transcriptionChunksCompleted:
					body.transcriptionChunksCompleted ?? null,
				transcriptionChunksTotal: body.transcriptionChunksTotal ?? null,
				aiStageChunksCompleted: body.aiStageChunksCompleted ?? null,
				aiStageChunksTotal: body.aiStageChunksTotal ?? null,
				processingStage: body.processingStage ?? null,
				processingPercent: body.processingPercent ?? null,
				processingUpdatedAt: body.processingUpdatedAt ?? null,
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
					failureCount: query.state.fetchFailureCount,
				},
				intervalMs,
			),
		retry: 2,
		retryDelay: 1000,
	});
};
