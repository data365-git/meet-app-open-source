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

import {
	groupSegmentsForRefine,
	splitReadableParagraphs,
} from "@/workflows/generate-ai";

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

describe("groupSegmentsForRefine", () => {
	const seg = (start: number, text: string) => ({ start, end: start + 1, text });

	it("preserves coverage and order, and every group is non-empty", () => {
		const segments = [
			seg(0, "Short one."),
			seg(1, "A slightly longer segment here."),
			seg(2, "Tiny."),
			seg(3, "Another medium-length segment of text."),
			seg(4, "Yet another one that is a bit longer than most."),
			seg(5, "Short."),
			seg(6, "Mid-size segment text goes here."),
			seg(7, "A"),
			seg(8, "Final longer segment to round things out nicely."),
			seg(9, "Done."),
		];

		const groups = groupSegmentsForRefine(segments, 50);

		expect(groups.every((g) => g.length > 0)).toBe(true);
		expect(groups.flat()).toEqual(segments);
		for (const group of groups.flat()) {
			expect(segments).toContain(group);
		}
	});

	it("keeps each group's summed length within budget, except an oversized solo segment", () => {
		const segments = [
			seg(0, "Short one."),
			seg(1, "A slightly longer segment here."),
			seg(2, "Tiny."),
			seg(3, "Another medium-length segment of text."),
			seg(4, "Yet another one that is a bit longer than most."),
			seg(5, "Short."),
			seg(6, "Mid-size segment text goes here."),
			seg(7, "A"),
			seg(
				8,
				"This single segment is deliberately much longer than the whole budget by itself, so it must still form its own group of one.",
			),
			seg(9, "Done."),
		];
		const budget = 50;

		const groups = groupSegmentsForRefine(segments, budget);

		for (const group of groups) {
			const total = group.reduce((sum, s) => sum + s.text.length + 1, 0);
			const isOversizedSolo =
				group.length === 1 && (group[0]?.text.length ?? 0) + 1 > budget;
			if (!isOversizedSolo) {
				expect(total).toBeLessThanOrEqual(budget);
			} else {
				expect(total).toBeGreaterThan(budget);
			}
		}
	});

	it("returns [] for empty input", () => {
		expect(groupSegmentsForRefine([])).toEqual([]);
	});

	it("returns exactly one group for a small input under the default budget", () => {
		const segments = [
			seg(0, "First segment."),
			seg(1, "Second segment."),
			seg(2, "Third segment."),
			seg(3, "Fourth segment."),
		];

		const groups = groupSegmentsForRefine(segments);

		expect(groups).toHaveLength(1);
		expect(groups[0]).toEqual(segments);
	});
});
