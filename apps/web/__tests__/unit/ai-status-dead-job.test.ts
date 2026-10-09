import { describe, expect, it } from "vitest";
import { buildAiStatusFacts } from "@/lib/ai-request-pending";
import { isAiStatusTerminal } from "../../hooks/use-ai-status";

/**
 * ROUND-THREE REVIEW, FINDING 1 — the MIRROR of the freeze the previous round
 * fixed. `metadata.aiGenerationRequestedAt` is a one-way latch: nothing ever
 * clears it. So a bare `!aiGenerationRequested` in the terminal predicate keeps
 * the poll alive FOREVER on every job that died with the flag set —
 * /api/video/ai every 4s for as long as the tab is open, the one-shot
 * router.refresh() never fires, and the panel never falls through to its
 * error+retry branch. The owner's acceptance line for this round: a failed
 * analysis either finishes or shows "qayta urinish" — never a page that just
 * sits there.
 *
 * The flag may therefore hold the poll open in exactly ONE state: transcription
 * COMPLETE with generation not yet queued.
 */
const deadJob = {
	hasContent: false,
	aiGenerationStatus: null,
	processingStage: null,
	aiRequestPending: false,
	// The durable flag is set in every case below — that is the whole point.
	aiGenerationRequested: true,
} as const;

describe("a dead AI job is terminal even though 'AI was requested' is latched", () => {
	// transcribe.ts:617 writes ERROR; NO_AUDIO/SKIPPED are the other two
	// terminal transcription outcomes. No AI stage can follow any of them.
	for (const transcriptionStatus of ["ERROR", "NO_AUDIO", "SKIPPED"] as const) {
		it(`terminal when transcription is ${transcriptionStatus}`, () => {
			expect(isAiStatusTerminal({ ...deadJob, transcriptionStatus })).toBe(
				true,
			);
		});
	}

	it("terminal on a reset row: no transcription status, nothing pending", () => {
		// An operator reset leaves transcriptionStatus NULL while the latched
		// flag survives in metadata. Pre-fix this polled forever.
		expect(isAiStatusTerminal({ ...deadJob, transcriptionStatus: null })).toBe(
			true,
		);
	});

	it("a running generation still wins over every rule above", () => {
		// The QUEUED/PROCESSING guard sits before the fall-through; a real run
		// must never be cut short by the dead-job rules.
		expect(
			isAiStatusTerminal({
				...deadJob,
				transcriptionStatus: "ERROR",
				aiGenerationStatus: "PROCESSING",
			}),
		).toBe(false);
	});
});

/**
 * ROUND-FOUR REVIEW — the regression guard for the bound that was DISCARDED.
 *
 * A 10-minute staleness bound was tried here and removed: `aiGenerationRequestedAt`
 * is stamped at PRESS time and never re-anchored when COMPLETE lands, so pressing
 * "AI tahlil" during a long transcription (a supported flow, and the shape every
 * cron-recovered job has by construction) made the marker read "stale" during a
 * perfectly legitimate handoff — the freeze, back again, for long videos.
 *
 * These assertions exist so that regression cannot return quietly: the wait is
 * NOT terminal no matter how old the press is. The previous round's tests could
 * not catch it because they hand-fed a staleness flag instead of composing the
 * real server facts.
 */
describe("the handoff wait is age-blind: an old press is still a live wait", () => {
	const waitingSince = (agoMs: number) => ({
		...deadJob,
		...buildAiStatusFacts({
			transcriptionStatus: "COMPLETE",
			metadata: {
				aiGenerationRequestedAt: new Date(Date.now() - agoMs).toISOString(),
			},
		}),
		hasContent: false,
		processingStage: null,
	});

	it("NOT terminal in the real handoff gap, minutes after the press", () => {
		// transcribe.ts:1980 writes COMPLETE several "use step" boundaries before
		// generate-ai.ts writes QUEUED, and transcribe.ts:2038 reads this very
		// marker to auto-start the run — so a run really is coming.
		expect(isAiStatusTerminal(waitingSince(5 * 60_000))).toBe(false);
	});

	it("NOT terminal even when the press is hours old (long transcription)", () => {
		expect(isAiStatusTerminal(waitingSince(5 * 60 * 60_000))).toBe(false);
	});

	it("a video with no marker at all reports no request and stays terminal", () => {
		const noMarker = buildAiStatusFacts({
			transcriptionStatus: "COMPLETE",
			metadata: {},
		});
		expect(noMarker.aiGenerationRequested).toBe(false);
		expect(
			isAiStatusTerminal({
				...deadJob,
				...noMarker,
				hasContent: false,
				processingStage: null,
			}),
		).toBe(true);
	});
});
