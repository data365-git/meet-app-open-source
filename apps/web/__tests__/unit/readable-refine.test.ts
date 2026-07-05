import { describe, expect, it, vi } from "vitest";

// Mocks required only so the workflows/generate-ai module can be imported for
// its pure exports (mirrors align-chapters-to-refined.test.ts).
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/groq-client", () => ({
	GROQ_MODEL: "test-model",
	getGroqClient: vi.fn(() => null),
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));

import { splitReadableParagraphs } from "@/workflows/generate-ai";

describe("splitReadableParagraphs", () => {
	it("splits on blank lines and trims each paragraph", () => {
		const text = "First paragraph.\n\nSecond paragraph.";
		expect(splitReadableParagraphs(text)).toEqual([
			"First paragraph.",
			"Second paragraph.",
		]);
	});

	it("drops empty paragraphs from extra blank lines", () => {
		const text = "First.\n\n\n\nSecond.\n\n   \n\nThird.";
		expect(splitReadableParagraphs(text)).toEqual(["First.", "Second.", "Third."]);
	});

	it("strips a leading bullet marker", () => {
		const text = "- First point.\n\n• Second point.\n\nThird point.";
		expect(splitReadableParagraphs(text)).toEqual([
			"First point.",
			"Second point.",
			"Third point.",
		]);
	});
});
