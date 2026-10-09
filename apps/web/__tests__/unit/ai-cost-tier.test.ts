import { describe, expect, it } from "vitest";
import { costTier } from "../../lib/ai-cost-tier";

describe("costTier", () => {
	it("paid>0 & free>0 -> paid", () => {
		expect(costTier({ totalUsdCents: 5, freeEventCount: 3 })).toBe("paid");
	});

	it("paid>0 & free=0 -> paid", () => {
		expect(costTier({ totalUsdCents: 5, freeEventCount: 0 })).toBe("paid");
	});

	it("paid=0 & free>0 -> free", () => {
		expect(costTier({ totalUsdCents: 0, freeEventCount: 3 })).toBe("free");
	});

	it("0 & 0 -> null", () => {
		expect(costTier({ totalUsdCents: 0, freeEventCount: 0 })).toBeNull();
	});

	it("0 & null -> null", () => {
		expect(costTier({ totalUsdCents: 0, freeEventCount: null })).toBeNull();
	});
});
