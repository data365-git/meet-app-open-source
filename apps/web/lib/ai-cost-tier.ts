export type CostTier = "paid" | "free";

/** paid if any real money was recorded; free if only $0 quota rows exist; null = nothing to show. */
export function costTier(input: {
	totalUsdCents: number;
	freeEventCount: number | null;
}): CostTier | null {
	if (input.totalUsdCents > 0) return "paid";
	if ((input.freeEventCount ?? 0) > 0) return "free";
	return null;
}
