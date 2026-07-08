import { describe, expect, it } from "vitest";
import { groupCuesIntoCards } from "@/app/s/[videoId]/_components/panels/TranscriptPanel";

// Minimal cue factory. `groupCuesIntoCards` only reads speaker/start/end/
// timestamp/id, but we build a complete shape so the literals satisfy the Cue
// type the function expects.
function cue(
	id: number,
	speaker: string | null,
	startSeconds: number,
	endSeconds: number,
) {
	return {
		id,
		startSeconds,
		endSeconds,
		text: `cue ${id}`,
		speaker,
		timestamp: `${startSeconds}s`,
	};
}

describe("groupCuesIntoCards", () => {
	it("returns no cards for an empty cue list", () => {
		expect(groupCuesIntoCards([])).toEqual([]);
	});

	it("merges consecutive same-speaker cues within gap and span bounds", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 3),
			cue(1, "Alisher", 4, 7), // gap 1s, span 7s
			cue(2, "Alisher", 8, 11), // gap 1s, span 11s
		]);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.cues.map((c) => c.id)).toEqual([0, 1, 2]);
	});

	it("uses the first cue's start and timestamp for the card", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 12, 15),
			cue(1, "Alisher", 16, 19),
		]);
		expect(cards[0]?.startSeconds).toBe(12);
		expect(cards[0]?.timestamp).toBe("12s");
	});

	it("starts a new card when the speaker changes", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 3),
			cue(1, "Dilnoza", 4, 7), // same tight gap, but different speaker
		]);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.speaker).toBe("Alisher");
		expect(cards[1]?.speaker).toBe("Dilnoza");
	});

	it("starts a new card when the inter-cue gap exceeds 6s", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 3),
			cue(1, "Alisher", 10, 13), // gap = 10 - 3 = 7s > 6s
		]);
		expect(cards).toHaveLength(2);
	});

	it("keeps cues together when the gap is exactly 6s (inclusive bound)", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 3),
			cue(1, "Alisher", 9, 12), // gap = 9 - 3 = 6s, still ≤ 6
		]);
		expect(cards).toHaveLength(1);
	});

	it("starts a new card when the accumulated span would exceed 20s", () => {
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 3),
			cue(1, "Alisher", 5, 8), // span 8s
			cue(2, "Alisher", 10, 21), // span 21s > 20s → new card
		]);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.cues.map((c) => c.id)).toEqual([0, 1]);
		expect(cards[1]?.cues.map((c) => c.id)).toEqual([2]);
	});

	it("keeps a run together when its span is exactly 20s (inclusive bound)", () => {
		// Every inter-cue gap is 2s (≤ 6s); only the accumulated span grows to
		// exactly 20s on the last cue, so the span bound (not the gap bound) is
		// what is under test. Only 2 cues, so the cue-count cap (3) isn't hit.
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 10),
			cue(1, "Alisher", 12, 20), // gap 2s, span = 20 - 0 = 20s, still ≤ 20
		]);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.cues).toHaveLength(2);
	});

	it("starts a new card once a card already holds 3 cues (max cues per card)", () => {
		// Gaps and span all stay comfortably within bounds; only the 4th
		// consecutive same-speaker cue should be forced into a new card.
		const cards = groupCuesIntoCards([
			cue(0, "Alisher", 0, 1),
			cue(1, "Alisher", 2, 3),
			cue(2, "Alisher", 4, 5),
			cue(3, "Alisher", 6, 7), // 4th cue → new card
		]);
		expect(cards).toHaveLength(2);
		expect(cards[0]?.cues.map((c) => c.id)).toEqual([0, 1, 2]);
		expect(cards[1]?.cues.map((c) => c.id)).toEqual([3]);
	});

	it("groups no-speaker cues (speaker === null) into one card", () => {
		const cards = groupCuesIntoCards([
			cue(0, null, 0, 3),
			cue(1, null, 4, 7),
		]);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.speaker).toBeNull();
	});
});
