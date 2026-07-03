import { describe, expect, it } from "vitest";
import { priceForMicros } from "./ai-pricing";

describe("priceForMicros", () => {
	it("prices text-in, audio-in, and output at their distinct 2.5-flash rates", () => {
		// 1M text-in @ $0.30 + 1M audio-in @ $1.00 + 1M output @ $2.50 = $3.80
		const micros = priceForMicros("gemini-2.5-flash", {
			textInTokens: 1_000_000,
			audioInTokens: 1_000_000,
			outputTokens: 1_000_000,
			batch: false,
		});
		expect(micros).toBe(3_800_000);
	});

	it("prices a text-only call using only the text-in rate", () => {
		// 1M text-in @ $0.30, no audio, no output.
		const micros = priceForMicros("gemini-2.5-flash", {
			textInTokens: 1_000_000,
			audioInTokens: 0,
			outputTokens: 0,
		});
		expect(micros).toBe(300_000);
	});

	it("prices audio-in at 3.3x the text-in rate — the bug this task fixes", () => {
		const textOnly = priceForMicros("gemini-2.5-flash", {
			textInTokens: 1_000_000,
			audioInTokens: 0,
			outputTokens: 0,
		});
		const audioOnly = priceForMicros("gemini-2.5-flash", {
			textInTokens: 0,
			audioInTokens: 1_000_000,
			outputTokens: 0,
		});
		// Previously audio-in was priced as text-in (1x). Real rate is $1.00 vs
		// $0.30 — audio must cost strictly more, not the same.
		expect(audioOnly).toBeGreaterThan(textOnly);
		expect(audioOnly / textOnly).toBeCloseTo(1.0 / 0.3, 5);
	});

	it("halves every component when batch is true", () => {
		const sync = priceForMicros("gemini-2.5-flash", {
			textInTokens: 500_000,
			audioInTokens: 500_000,
			outputTokens: 500_000,
			batch: false,
		});
		const batch = priceForMicros("gemini-2.5-flash", {
			textInTokens: 500_000,
			audioInTokens: 500_000,
			outputTokens: 500_000,
			batch: true,
		});
		expect(batch).toBe(Math.round(sync / 2));
	});

	it("falls back to DEFAULT_PRICE (2.5-flash rates) for an unrecognized model", () => {
		const unknown = priceForMicros("some-future-unlisted-model", {
			textInTokens: 1_000_000,
			audioInTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		const known = priceForMicros("gemini-2.5-flash", {
			textInTokens: 1_000_000,
			audioInTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		// Unknown models must NEVER under-price relative to the real rate table.
		expect(unknown).toBe(known);
	});

	it("prices the embedding model at zero", () => {
		const micros = priceForMicros("gemini-embedding-001", {
			textInTokens: 1_000_000,
			audioInTokens: 1_000_000,
			outputTokens: 1_000_000,
		});
		expect(micros).toBe(0);
	});

	it("hand-calc sanity: 1h audio input-side cost ≈ $0.115 sync, half with batch", () => {
		// Spec's verified fact: audio ≈ 32 tokens/sec → 1h audio ≈ 115,200 audio tokens.
		const AUDIO_TOKENS_1H = 115_200;

		const syncMicros = priceForMicros("gemini-2.5-flash", {
			textInTokens: 0,
			audioInTokens: AUDIO_TOKENS_1H,
			outputTokens: 0,
			batch: false,
		});
		const syncUsd = syncMicros / 1_000_000;
		expect(syncUsd).toBeCloseTo(0.115, 2);

		const batchMicros = priceForMicros("gemini-2.5-flash", {
			textInTokens: 0,
			audioInTokens: AUDIO_TOKENS_1H,
			outputTokens: 0,
			batch: true,
		});
		const batchUsd = batchMicros / 1_000_000;
		expect(batchUsd).toBeCloseTo(syncUsd / 2, 5);
	});
});
