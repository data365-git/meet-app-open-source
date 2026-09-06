import { beforeEach, describe, expect, it, vi } from "vitest";

const env: { GEMINI_API_KEY?: string; GEMINI_API_KEY_FREE?: string } = {};
vi.mock("@cap/env", () => ({ serverEnv: () => env }));

describe("isServerPaidGeminiKeyFree", () => {
	beforeEach(() => {
		delete env.GEMINI_API_KEY;
		delete env.GEMINI_API_KEY_FREE;
	});

	it("equal values -> true", async () => {
		env.GEMINI_API_KEY = "same-key";
		env.GEMINI_API_KEY_FREE = "same-key";
		const { isServerPaidGeminiKeyFree } = await import("../../lib/gemini-paid-key");
		expect(isServerPaidGeminiKeyFree()).toBe(true);
	});

	it("different values -> false", async () => {
		env.GEMINI_API_KEY = "paid-key";
		env.GEMINI_API_KEY_FREE = "free-key";
		const { isServerPaidGeminiKeyFree } = await import("../../lib/gemini-paid-key");
		expect(isServerPaidGeminiKeyFree()).toBe(false);
	});

	it("FREE undefined -> false", async () => {
		env.GEMINI_API_KEY = "paid-key";
		const { isServerPaidGeminiKeyFree } = await import("../../lib/gemini-paid-key");
		expect(isServerPaidGeminiKeyFree()).toBe(false);
	});

	it("PAID undefined -> false", async () => {
		env.GEMINI_API_KEY_FREE = "free-key";
		const { isServerPaidGeminiKeyFree } = await import("../../lib/gemini-paid-key");
		expect(isServerPaidGeminiKeyFree()).toBe(false);
	});
});
