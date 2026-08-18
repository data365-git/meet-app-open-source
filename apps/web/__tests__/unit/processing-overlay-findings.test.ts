import { describe, expect, it } from "vitest";
import {
	buildProcessingProgress,
	pollAuthoritativeValue,
	PROCESSING_STAGE_STALE_MS,
	shouldActivateProcessingPoll,
} from "@/lib/ai-request-pending";
import { isAiStatusTerminal, nextAiStatusPollInterval } from "../../hooks/use-ai-status";

describe("FINDING 1 — poll is authoritative for stage/percent", () => {
	it("clears a stale server-rendered value when the poll authoritatively reports null", () => {
		// The poll HAS data (hasPollData=true) and reports null: the overlay
		// must go away, not fall through to the old server prop via `??`.
		expect(pollAuthoritativeValue(true, null, "optimizing")).toBeNull();
		expect(pollAuthoritativeValue(true, null, 42)).toBeNull();
	});

	it("keeps the server-rendered value until the first poll response lands", () => {
		expect(pollAuthoritativeValue(false, null, "optimizing")).toBe(
			"optimizing",
		);
		expect(pollAuthoritativeValue(false, null, 42)).toBe(42);
	});
});

describe("FINDING 2 — a running optimize/save stage keeps the poll alive", () => {
	it("nextAiStatusPollInterval does not go false while processingStage is set, even with old AI content", () => {
		const reprocessedWithOldContent = {
			hasContent: true,
			aiGenerationStatus: "COMPLETE",
			processingStage: "optimizing",
		} as never;
		expect(
			nextAiStatusPollInterval(
				{ status: "success", data: reprocessedWithOldContent },
				4000,
			),
		).toBe(4000);
	});

	it("isAiStatusTerminal is false whenever processingStage is non-null", () => {
		expect(
			isAiStatusTerminal({
				hasContent: true,
				aiGenerationStatus: "COMPLETE",
				processingStage: "saving",
			}),
		).toBe(false);
	});
});

describe("FINDING 3 — a share visitor with no AI run stops polling once processing clears", () => {
	it("isAiStatusTerminal is true once the stage clears and no AI run ever started", () => {
		expect(
			isAiStatusTerminal({
				hasContent: false,
				aiGenerationStatus: null,
				processingStage: null,
				aiRequestPending: false,
			}),
		).toBe(true);
	});

	it("stays false while the stage is still running", () => {
		expect(
			isAiStatusTerminal({
				hasContent: false,
				aiGenerationStatus: null,
				processingStage: "optimizing",
				aiRequestPending: false,
			}),
		).toBe(false);
	});

	it("stays false while a banked AI request is still unclaimed", () => {
		expect(
			isAiStatusTerminal({
				hasContent: false,
				aiGenerationStatus: null,
				processingStage: null,
				aiRequestPending: true,
			}),
		).toBe(false);
	});
});

describe("FINDING 4 — a later prop refresh turns the poller on", () => {
	it("turns on when a fresh processingStage appears on an inactive card", () => {
		expect(shouldActivateProcessingPoll(false, "optimizing")).toBe(true);
	});

	it("does not turn on again once already active", () => {
		expect(shouldActivateProcessingPoll(true, "optimizing")).toBe(false);
	});

	it("does not turn on when there is no stage", () => {
		expect(shouldActivateProcessingPoll(false, null)).toBe(false);
	});
});

describe("FINDING 5 — a stale processingUpdatedAt is treated as absent", () => {
	it("keeps a fresh stage", () => {
		const now = Date.parse("2026-08-18T12:00:00.000Z");
		const result = buildProcessingProgress({
			metadata: {
				processingStage: "optimizing",
				processingPercent: 40,
				processingUpdatedAt: new Date(now - 1000).toISOString(),
			} as never,
			now,
		});
		expect(result.processingStage).toBe("optimizing");
		expect(result.processingPercent).toBe(40);
	});

	it("drops a stage whose last write is older than the cutoff — the killed-worker case", () => {
		const now = Date.parse("2026-08-18T12:00:00.000Z");
		const result = buildProcessingProgress({
			metadata: {
				processingStage: "optimizing",
				processingPercent: 40,
				processingUpdatedAt: new Date(
					now - PROCESSING_STAGE_STALE_MS - 1,
				).toISOString(),
			} as never,
			now,
		});
		expect(result.processingStage).toBeNull();
		expect(result.processingPercent).toBeNull();
	});
});

// REGRESSION GUARD added by the main session's diff review, 2026-08-18.
// FINDING 3's fix introduced `return !d.aiRequestPending` as the fall-through.
// That is TRUE during an in-flight transcription, because isAiRequestPending
// returns false the moment transcriptionStatus is truthy ("the press was
// already claimed") and app/api/videos/[videoId]/generate/route.ts:107
// deliberately leaves aiGenerationStatus UNSET until the generation stage
// starts. Without the transcriptionStatus check the poll stopped mid-
// transcription and the "Bo'lak N/M" line froze until a manual reload.
describe("a transcription in flight is never terminal", () => {
	const midTranscription = {
		hasContent: false,
		aiGenerationStatus: null,
		processingStage: null,
		aiRequestPending: false,
		transcriptionStatus: "PROCESSING" as const,
	};

	it("isAiStatusTerminal stays false while transcription is PROCESSING", () => {
		expect(isAiStatusTerminal(midTranscription)).toBe(false);
	});

	it("the poll keeps its interval while transcription is PROCESSING", () => {
		expect(
			nextAiStatusPollInterval(
				{ status: "success", data: midTranscription as never },
				4000,
			),
		).toBe(4000);
	});

	it("still terminal once transcription is COMPLETE with no AI run", () => {
		expect(
			isAiStatusTerminal({ ...midTranscription, transcriptionStatus: "COMPLETE" }),
		).toBe(true);
	});
});
