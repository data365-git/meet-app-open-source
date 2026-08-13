import { beforeEach, describe, expect, it, vi } from "vitest";

// A2 — withCostGuard priced + recorded the hardcoded `options.model` literal even
// when the caller's fn actually ran a different (fallen-back) model. Fix: prefer
// `result.modelUsed ?? options.model` at both the pricing call and the recorded
// DB row. This exercises the real withCostGuard against a mocked db/priceForMicros.

const H = vi.hoisted(() => ({
	insertValues: vi.fn(() => Promise.resolve(undefined)),
	priceForMicros: vi.fn(() => 12_345),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve([{ preferences: null, settings: null }])),
					// getMonthlySpendMicros/getVideoSpendMicros call .where(...) directly
					// (no .limit) and await it — make the where() result itself awaitable.
					then: (resolve: (value: unknown) => void) => resolve([{ total: 0 }]),
				})),
			})),
		})),
		insert: vi.fn(() => ({ values: H.insertValues })),
	}),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "usage-id"),
}));

vi.mock("@cap/database/schema", () => ({
	aiUsageEvents: {},
	organizations: {},
	users: {},
}));

vi.mock("@cap/utils", () => ({
	priceForMicros: H.priceForMicros,
}));

vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (value: string) => value } },
	User: { UserId: { make: (value: string) => value } },
	Video: { VideoId: { make: (value: string) => value } },
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	sql: vi.fn(() => "sql"),
}));

import { withCostGuard } from "@/lib/ai-cost-guard";

describe("withCostGuard — mispriced fallback model (A2)", () => {
	beforeEach(() => {
		H.insertValues.mockClear();
		H.priceForMicros.mockClear();
	});

	it("prices and records the model that ACTUALLY produced the result, not the requested literal", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "transcription",
			model: "gemini-3-flash-preview", // requested/primary model
			fn: async () => ({
				transcriptVtt: "WEBVTT\n\n",
				inputTokens: 100,
				outputTokens: 50,
				audioInTokens: 80,
				modelUsed: "gemini-2.5-flash", // what actually ran after overload fallback
			}),
		});

		expect(H.priceForMicros).toHaveBeenCalledWith(
			"gemini-2.5-flash",
			expect.objectContaining({ audioInTokens: 80, outputTokens: 50 }),
		);
		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gemini-2.5-flash" }),
		);
	});

	it("falls back to options.model when the fn result carries no modelUsed (back-compat for other callers)", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "transcription",
			model: "gemini-3-flash-preview",
			fn: async () => ({
				transcriptVtt: "WEBVTT\n\n",
				inputTokens: 100,
				outputTokens: 50,
				audioInTokens: 80,
				// no modelUsed field at all
			}),
		});

		expect(H.priceForMicros).toHaveBeenCalledWith(
			"gemini-3-flash-preview",
			expect.any(Object),
		);
		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ model: "gemini-3-flash-preview" }),
		);
	});
});

// The provider-reported cost path (OpenRouter). The owner reads the recorded
// number, so it must be the vendor's own charge and not our estimate of it.
describe("withCostGuard — a provider-reported cost outranks the pricing table", () => {
	beforeEach(() => {
		H.insertValues.mockClear();
		H.priceForMicros.mockClear();
	});

	it("records the reported microdollars and never consults the token pricing table", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "transcription",
			model: "openrouter/google/gemini-3-flash-preview",
			fn: async () => ({
				transcriptVtt: "WEBVTT\n\n",
				inputTokens: 4321,
				outputTokens: 765,
				audioInTokens: 0,
				costUsdMicros: 12_900,
			}),
		});

		expect(H.priceForMicros).not.toHaveBeenCalled();
		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "openrouter/google/gemini-3-flash-preview",
				costUsdMicros: 12_900,
			}),
		);
	});

	it("a malformed reported cost falls back to the pricing table rather than recording $0", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "summary",
			model: "openrouter/google/gemini-3-flash-preview",
			fn: async () => ({
				content: "{}",
				inputTokens: 100,
				outputTokens: 50,
				costUsdMicros: Number.NaN,
			}),
		});

		expect(H.priceForMicros).toHaveBeenCalled();
		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ costUsdMicros: 12_345 }),
		);
	});

	// round-18 #5 — the hole `??` could not catch. Missing/NaN/negative already
	// fell back to the table; EXACT ZERO was accepted, so a paid call recorded
	// costUsdMicros = 0, monthly/per-video spend stayed flat, and the
	// $100/month + $20/video backstops could never trip on a retry loop.
	it("an exact ZERO reported cost on a PAID call falls back to the pricing table (a paid call is never free)", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "summary",
			model: "openrouter/google/gemini-3-flash-preview",
			fn: async () => ({
				content: "{}",
				inputTokens: 100,
				outputTokens: 50,
				costUsdMicros: 0,
			}),
		});

		expect(H.priceForMicros).toHaveBeenCalled();
		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ costUsdMicros: 12_345 }),
		);
	});

	it("a FREE call still records $0 even if a cost was reported", async () => {
		await withCostGuard({
			orgId: "org-1",
			userId: "user-1",
			operation: "summary",
			model: "gemini-3.5-flash",
			free: true,
			fn: async () => ({
				content: "{}",
				inputTokens: 100,
				outputTokens: 50,
				costUsdMicros: 99_999,
			}),
		});

		expect(H.insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ costUsdMicros: 0 }),
		);
	});
});
