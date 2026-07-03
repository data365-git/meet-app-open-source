import { describe, expect, it } from "vitest";
import {
	buildBatchRequestBody,
	extractInlinedResponse,
	isTerminalBatchState,
	mapBatchState,
	shouldFallbackToSync,
	TERMINAL_BATCH_STATES,
	unwrapBatchResponse,
} from "@/lib/gemini-batch-transcribe";

// ─── State mapping (terminal vs pending) ──────────────────────────────────────
describe("mapBatchState", () => {
	it("classifies the live BATCH_STATE_* terminal states", () => {
		expect(mapBatchState("BATCH_STATE_SUCCEEDED")).toBe("succeeded");
		expect(mapBatchState("BATCH_STATE_FAILED")).toBe("failed");
		expect(mapBatchState("BATCH_STATE_CANCELLED")).toBe("failed");
		expect(mapBatchState("BATCH_STATE_EXPIRED")).toBe("failed");
	});

	it("treats pending/running/unknown/empty as still-pending", () => {
		expect(mapBatchState("BATCH_STATE_PENDING")).toBe("pending");
		expect(mapBatchState("BATCH_STATE_RUNNING")).toBe("pending");
		expect(mapBatchState("BATCH_STATE_UNSPECIFIED")).toBe("pending");
		expect(mapBatchState("SOMETHING_UNRECOGNIZED")).toBe("pending");
		expect(mapBatchState(undefined)).toBe("pending");
		expect(mapBatchState(null)).toBe("pending");
		expect(mapBatchState("")).toBe("pending");
	});

	it("is tolerant of a bare (un-prefixed) terminal token", () => {
		// Guards against Google dropping the BATCH_STATE_ prefix in some payloads.
		expect(mapBatchState("SUCCEEDED")).toBe("succeeded");
		expect(mapBatchState("failed")).toBe("failed");
	});

	it("isTerminalBatchState agrees with mapBatchState for every declared terminal state", () => {
		for (const s of TERMINAL_BATCH_STATES) {
			expect(isTerminalBatchState(s)).toBe(true);
		}
		expect(isTerminalBatchState("BATCH_STATE_RUNNING")).toBe(false);
	});
});

// ─── Timeout → sync fallback decision ─────────────────────────────────────────
describe("shouldFallbackToSync", () => {
	it("does NOT fall back while pending and under the timeout", () => {
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_RUNNING",
				elapsedMs: 5 * 60_000,
				timeoutMs: 30 * 60_000,
			}),
		).toBe(false);
	});

	it("falls back when pending AND the timeout is reached", () => {
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_RUNNING",
				elapsedMs: 30 * 60_000,
				timeoutMs: 30 * 60_000,
			}),
		).toBe(true);
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_PENDING",
				elapsedMs: 31 * 60_000,
				timeoutMs: 30 * 60_000,
			}),
		).toBe(true);
	});

	it("never reports fallback once the state is terminal, even past the timeout", () => {
		// A terminal state is handled by mapBatchState, not the timeout branch.
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_SUCCEEDED",
				elapsedMs: 99 * 60_000,
				timeoutMs: 30 * 60_000,
			}),
		).toBe(false);
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_FAILED",
				elapsedMs: 99 * 60_000,
				timeoutMs: 30 * 60_000,
			}),
		).toBe(false);
	});
});

// ─── Tolerant response unwrap (doubled nesting + fallbacks) ────────────────────
describe("extractInlinedResponse / unwrapBatchResponse", () => {
	// The exact shape the spike observed: response.inlinedResponses.inlinedResponses[0]
	const doubledNested = (inner: unknown) => ({
		state: "BATCH_STATE_SUCCEEDED",
		response: { inlinedResponses: { inlinedResponses: [inner] } },
	});
	// A plausible single-nested variant Google has also shipped.
	const singleNested = (inner: unknown) => ({
		state: "BATCH_STATE_SUCCEEDED",
		response: { inlinedResponses: [inner] },
	});

	const goodGen = {
		response: {
			candidates: [
				{ content: { parts: [{ text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nhello\n\n" }] }, finishReason: "STOP" },
			],
			usageMetadata: {
				promptTokenCount: 25737,
				candidatesTokenCount: 5869,
				promptTokensDetails: [
					{ modality: "TEXT", tokenCount: 6541 },
					{ modality: "AUDIO", tokenCount: 19196 },
				],
			},
		},
	};

	it("unwraps the DOUBLED-nested shape and splits audio vs text tokens", () => {
		const out = unwrapBatchResponse(doubledNested(goodGen));
		expect(out.rawText).toContain("hello");
		expect(out.inputTokens).toBe(25737);
		expect(out.outputTokens).toBe(5869);
		expect(out.audioInTokens).toBe(19196);
		expect(out.finishReason).toBe("STOP");
	});

	it("also unwraps the single-nested fallback shape", () => {
		const out = unwrapBatchResponse(singleNested(goodGen));
		expect(out.rawText).toContain("hello");
		expect(out.audioInTokens).toBe(19196);
	});

	it("routes an inline per-request error into a throw (same as a sync error)", () => {
		const withError = doubledNested({
			error: { code: 429, message: "RESOURCE_EXHAUSTED" },
		});
		expect(() => unwrapBatchResponse(withError)).toThrow(/RESOURCE_EXHAUSTED/);
	});

	it("throws when there are no inlined responses at all", () => {
		expect(() => unwrapBatchResponse({ state: "BATCH_STATE_SUCCEEDED" })).toThrow(
			/missing inlinedResponses/,
		);
		expect(extractInlinedResponse({})).toBeUndefined();
	});

	it("throws on an empty transcript (finishReason surfaced) so the chunk retries", () => {
		const empty = doubledNested({
			response: { candidates: [{ content: { parts: [{ text: "   " }] }, finishReason: "MAX_TOKENS" }] },
		});
		expect(() => unwrapBatchResponse(empty)).toThrow(/empty transcript/);
		expect(() => unwrapBatchResponse(empty)).toThrow(/MAX_TOKENS/);
	});

	it("defaults token counts to 0 when usageMetadata is absent", () => {
		const noUsage = doubledNested({
			response: { candidates: [{ content: { parts: [{ text: "some words here" }] } }] },
		});
		const out = unwrapBatchResponse(noUsage);
		expect(out.inputTokens).toBe(0);
		expect(out.outputTokens).toBe(0);
		expect(out.audioInTokens).toBe(0);
	});
});

// ─── Request body shape (spike-proven envelope) ───────────────────────────────
describe("buildBatchRequestBody", () => {
	it("wraps contents/generationConfig in batch.input_config.requests.requests[0].request", () => {
		const body = buildBatchRequestBody({
			model: "gemini-2.5-flash",
			mimeType: "audio/mpeg",
			fileUri: "https://files/xyz",
			displayName: "cap-batch-test",
		}) as any;

		const req = body.batch.input_config.requests.requests[0].request;
		expect(req).toBeTruthy();
		// Same generationConfig the sync path uses.
		expect(req.generationConfig.temperature).toBe(0.1);
		expect(req.generationConfig.maxOutputTokens).toBe(65536);
		expect(req.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
		// fileData part carries the uploaded audio.
		const fileDataPart = req.contents[0].parts.find((p: any) => p.fileData);
		expect(fileDataPart.fileData.fileUri).toBe("https://files/xyz");
		expect(fileDataPart.fileData.mimeType).toBe("audio/mpeg");
		// The English transcription prompt is included as a text part.
		const textPart = req.contents[0].parts.find((p: any) => typeof p.text === "string");
		expect(textPart.text).toContain("WebVTT");
	});
});
