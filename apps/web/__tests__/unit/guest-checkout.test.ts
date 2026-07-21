import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
	}),
}));

const mockStripe = {
	checkout: {
		sessions: {
			create: vi.fn(),
		},
	},
};

const VALID_PRICE_ID = "price_1Q3esrFJxA1XpeSsFwp486RN";

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
	isValidStripePriceId: (priceId: string) => priceId === VALID_PRICE_ID,
}));

function makeRequest(body: Record<string, unknown>) {
	return new Request("https://cap.test/api/settings/billing/guest-checkout", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as import("next/server").NextRequest;
}

describe("POST /api/settings/billing/guest-checkout", () => {
	let POST: typeof import("@/app/api/settings/billing/guest-checkout/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import(
			"@/app/api/settings/billing/guest-checkout/route"
		);
		POST = mod.POST;
	});

	it("returns 400 when priceId is missing", async () => {
		const res = await POST(makeRequest({ quantity: 1 }));
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("priceId is required");
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("returns 400 when priceId is not a string", async () => {
		const res = await POST(makeRequest({ priceId: 12345, quantity: 1 }));
		expect(res.status).toBe(400);
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("returns 400 when priceId is not in the allowlist", async () => {
		const res = await POST(
			makeRequest({ priceId: "price_not_allowed", quantity: 1 }),
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBe("priceId is required");
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("creates a checkout session when priceId is allow-listed", async () => {
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		const res = await POST(
			makeRequest({ priceId: VALID_PRICE_ID, quantity: 1 }),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.url).toBe("https://checkout.stripe.com/test");
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [{ price: VALID_PRICE_ID, quantity: 1 }],
			}),
		);
	});

	it("returns 500 when Stripe throws", async () => {
		mockStripe.checkout.sessions.create.mockRejectedValue(
			new Error("Stripe error"),
		);

		const res = await POST(
			makeRequest({ priceId: VALID_PRICE_ID, quantity: 1 }),
		);
		expect(res.status).toBe(500);
	});
});
