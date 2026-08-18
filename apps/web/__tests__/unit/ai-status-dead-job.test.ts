import { describe, expect, it } from "vitest";
import {
	AI_GENERATION_HANDOFF_MAX_MS,
	buildAiStatusFacts,
} from "@/lib/ai-request-pending";
import { isAiStatusTerminal } from "../../hooks/use-ai-status";

/**
 * ROUND-THREE REVIEW, FINDING 1 — the MIRROR of the freeze the previous round
 * fixed. `metadata.aiGenerationRequestedAt` is a one-way latch: nothing ever
 * clears it and no redeemer reads it. So a bare `!aiGenerationRequested` in
 * the terminal predicate keeps the poll alive FOREVER on every job that died
 * with the flag set — /api/video/ai every 4s for as long as the tab is open,
 * the one-shot router.refresh() never fires, and the panel never falls through
 * to its error+retry branch. The owner's own acceptance line for this round:
 * a failed analysis either finishes or shows "qayta urinish" — never a page
 * that just sits there.
 *
 * The flag may therefore hold the poll open in exactly ONE state: transcription
 * COMPLETE, generation not yet queued, and the wait still plausible.
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

	it("NOT terminal in the real handoff gap (COMPLETE, generation not queued yet)", () => {
		// The state the flag exists for: transcribe.ts:1980 writes COMPLETE two
		// "use step" boundaries before generate-ai.ts writes QUEUED. Stopping
		// here is the freeze the previous round fixed — it must stay fixed.
		expect(
			isAiStatusTerminal({ ...deadJob, transcriptionStatus: "COMPLETE" }),
		).toBe(false);
	});

	it("terminal once that gap has gone stale (a workflow killed inside it)", () => {
		expect(
			isAiStatusTerminal({
				...deadJob,
				transcriptionStatus: "COMPLETE",
				aiGenerationRequestStale: true,
			}),
		).toBe(true);
	});

	it("a QUEUED or PROCESSING generation still wins over every rule above", () => {
		// The running-AI guard sits before the fall-through; a real run must
		// never be cut short by the dead-job rules.
		expect(
			isAiStatusTerminal({
				...deadJob,
				transcriptionStatus: "ERROR",
				aiGenerationStatus: "PROCESSING",
			}),
		).toBe(false);
	});
});

describe("staleness is computed server-side, on the clock that wrote the marker", () => {
	const requestedAt = "2026-08-18T12:00:00.000Z";
	const requestedAtMs = Date.parse(requestedAt);

	it("a fresh request is not stale", () => {
		expect(
			buildAiStatusFacts({
				transcriptionStatus: "COMPLETE",
				metadata: { aiGenerationRequestedAt: requestedAt },
				now: requestedAtMs + AI_GENERATION_HANDOFF_MAX_MS - 1,
			}).aiGenerationRequestStale,
		).toBe(false);
	});

	it("a request older than the handoff bound is stale", () => {
		expect(
			buildAiStatusFacts({
				transcriptionStatus: "COMPLETE",
				metadata: { aiGenerationRequestedAt: requestedAt },
				now: requestedAtMs + AI_GENERATION_HANDOFF_MAX_MS + 1,
			}).aiGenerationRequestStale,
		).toBe(true);
	});

	it("no marker at all is not stale (nothing is holding the poll open)", () => {
		const facts = buildAiStatusFacts({
			transcriptionStatus: "COMPLETE",
			metadata: {},
			now: requestedAtMs,
		});
		expect(facts.aiGenerationRequested).toBe(false);
		expect(facts.aiGenerationRequestStale).toBe(false);
	});

	it("an unparseable marker is not stale rather than NaN-true", () => {
		expect(
			buildAiStatusFacts({
				transcriptionStatus: "COMPLETE",
				metadata: { aiGenerationRequestedAt: "not-a-date" },
				now: requestedAtMs,
			}).aiGenerationRequestStale,
		).toBe(false);
	});
});
