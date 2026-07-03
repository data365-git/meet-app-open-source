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
