const PRICES: Record<
	string,
	{ textInPerMillion: number; audioInPerMillion: number; outputPerMillion: number }
> = {
	"gemini-3-flash-preview": {
		textInPerMillion: 0.3,
		audioInPerMillion: 1.0,
		outputPerMillion: 2.5,
	},
	"gemini-2.5-flash": {
		textInPerMillion: 0.3,
		audioInPerMillion: 1.0,
		outputPerMillion: 2.5,
	},
	"gemini-embedding-001": {
		textInPerMillion: 0,
		audioInPerMillion: 0,
		outputPerMillion: 0,
	},
};

// Unknown models fall back to this. Set to 2.5-flash's real rates (not a
// discount guess) so an unrecognized model NEVER under-prices spend.
const DEFAULT_PRICE = {
	textInPerMillion: 0.3,
	audioInPerMillion: 1.0,
	outputPerMillion: 2.5,
};

export function priceForMicros(
	model: string,
	usage: {
		textInTokens: number;
		audioInTokens: number;
		outputTokens: number;
		batch?: boolean;
	},
): number {
	const price = PRICES[model] ?? DEFAULT_PRICE;
	const batchFactor = usage.batch ? 0.5 : 1;
	const textInCostUsd =
		(usage.textInTokens / 1_000_000) * price.textInPerMillion * batchFactor;
	const audioInCostUsd =
		(usage.audioInTokens / 1_000_000) * price.audioInPerMillion * batchFactor;
	const outputCostUsd =
		(usage.outputTokens / 1_000_000) * price.outputPerMillion * batchFactor;
	return Math.round((textInCostUsd + audioInCostUsd + outputCostUsd) * 1_000_000);
}

// ── Passive upfront estimate (GenerateAiPanel label) ──────────────────────
//
// Approximates the cost of the WHOLE per-video AI pipeline (transcription +
// summary + refined + chapters), not just transcription audio-in, so the
// label roughly matches what actually gets recorded by withCostGuard() over
// a video's lifetime. Rates come from the same PRICES table priceForMicros
// uses — there is no separate price source here.
//
// Token-per-second factors (documented, not measured per-video — this is a
// rough estimate, not a precise forecast):
//   - AUDIO_TOKENS_PER_SEC = 32: given fact (gemini audio ≈ 32 tokens/sec of
//     input audio), drives the transcription audio-in cost.
//   - TEXT_IN_TOKENS_PER_SEC = 10: the transcript is re-read as text input by
//     ~3 downstream stages (summary, refined, translate-prep). Speech runs
//     ~2.5 words/sec * ~1.3 tokens/word ≈ 3.3 text tokens/sec per pass, so
//     ~3 passes ≈ 10 text-in tokens/sec.
//   - OUTPUT_TOKENS_PER_SEC = 36: combined generated text across summary +
//     refined transcript + chapters/title scales with duration; text-in and
//     audio-in alone land far under the verified ~$0.45/hour anchor because
//     output tokens are priced far higher ($2.50/M vs $0.30-1.00/M), so
//     output is calibrated to close the gap to that anchor.
// With these factors, 1h sync ≈ $0.45 (audio $0.115 + text-in $0.011 +
// output $0.324), matching the plan's verified ≈$0.45/soat anchor.
const AUDIO_TOKENS_PER_SEC = 32;
const TEXT_IN_TOKENS_PER_SEC = 10;
const OUTPUT_TOKENS_PER_SEC = 36;
const ESTIMATE_MODEL = "gemini-2.5-flash";

/**
 * Rough upfront USD estimate for the full AI pipeline on a video of the
 * given duration. Returns 0 for unknown/zero/negative duration. `batch: true`
 * halves the estimate automatically (via priceForMicros' batch rates), same
 * as real cheap-mode recording.
 */
export function estimateVideoAiCostUsd(
	durationSec: number | null | undefined,
	options: { batch?: boolean } = {},
): number {
	if (!durationSec || durationSec <= 0) return 0;
	const micros = priceForMicros(ESTIMATE_MODEL, {
		textInTokens: TEXT_IN_TOKENS_PER_SEC * durationSec,
		audioInTokens: AUDIO_TOKENS_PER_SEC * durationSec,
		outputTokens: OUTPUT_TOKENS_PER_SEC * durationSec,
		batch: options.batch ?? false,
	});
	return micros / 1_000_000;
}
