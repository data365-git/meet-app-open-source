import { describe, expect, it } from "vitest";

import {
	BACKLOG_DEGRADE_ABOVE_BYTES,
	BACKLOG_RESTORE_BELOW_BYTES,
	CAPTURE_TIERS,
	type CaptureTierName,
	captureTierFor,
	chooseCaptureTier,
} from "./recording-quality";

// ── What these tests protect ───────────────────────────────────────────────
//
// A throttled soak run at 800 kbit/s failed with upload-never-completed (8 of
// ~17 parts shipped during a 6-minute recording). The fix is to reduce what the
// capture PRODUCES while the link is behind, and restore it when it recovers.
//
// The dangerous half of that fix is the flapping: a backlog sitting on a single
// threshold would flip the tier every few seconds, and every flip restarts the
// MediaRecorder. So the thresholds are asserted here, on a pure function, rather
// than watched on a live recording.

const MID_BAND = Math.round(
	(BACKLOG_DEGRADE_ABOVE_BYTES + BACKLOG_RESTORE_BELOW_BYTES) / 2,
);

describe("capture tiers", () => {
	it("is ordered best-first and every step actually costs fewer bits", () => {
		expect(CAPTURE_TIERS.map((t) => t.name)).toEqual([
			"full",
			"reduced",
			"minimal",
		]);
		for (let i = 1; i < CAPTURE_TIERS.length; i++) {
			const worse = CAPTURE_TIERS[i];
			const better = CAPTURE_TIERS[i - 1];
			expect(worse.videoBitsPerSecond).toBeLessThan(
				better.videoBitsPerSecond,
			);
			expect(worse.maxWidth).toBeLessThan(better.maxWidth);
			expect(worse.maxHeight).toBeLessThan(better.maxHeight);
			expect(worse.frameRate).toBeLessThan(better.frameRate);
		}
	});

	it("never degrades the audio leg — voice is what must survive", () => {
		const audio = CAPTURE_TIERS.map((t) => t.audioBitsPerSecond);
		expect(new Set(audio).size).toBe(1);
	});

	it("reaches a bitrate the 800 kbit/s link that failed the soak can carry", () => {
		const floor = CAPTURE_TIERS[CAPTURE_TIERS.length - 1];
		expect(floor.videoBitsPerSecond + floor.audioBitsPerSecond).toBeLessThanOrEqual(
			1_000_000,
		);
	});

	it("looks up tier settings by name and falls back to the best tier", () => {
		expect(captureTierFor("reduced").maxHeight).toBe(720);
		expect(captureTierFor("minimal").name).toBe("minimal");
		expect(captureTierFor("nonsense-tier").name).toBe("full");
	});
});

describe("chooseCaptureTier", () => {
	it("degrades one step when the backlog is above the high-water mark", () => {
		expect(chooseCaptureTier("full", BACKLOG_DEGRADE_ABOVE_BYTES + 1)).toBe(
			"reduced",
		);
		expect(chooseCaptureTier("reduced", BACKLOG_DEGRADE_ABOVE_BYTES + 1)).toBe(
			"minimal",
		);
	});

	it("moves only ONE step per call, however huge the backlog", () => {
		expect(chooseCaptureTier("full", BACKLOG_DEGRADE_ABOVE_BYTES * 100)).toBe(
			"reduced",
		);
	});

	it("stops at the floor instead of inventing a tier below it", () => {
		expect(chooseCaptureTier("minimal", BACKLOG_DEGRADE_ABOVE_BYTES * 100)).toBe(
			"minimal",
		);
	});

	it("restores one step when the backlog is below the low-water mark", () => {
		expect(chooseCaptureTier("minimal", BACKLOG_RESTORE_BELOW_BYTES - 1)).toBe(
			"reduced",
		);
		expect(chooseCaptureTier("reduced", 0)).toBe("full");
	});

	it("stops at the ceiling instead of climbing past full quality", () => {
		expect(chooseCaptureTier("full", 0)).toBe("full");
	});

	// ── HYSTERESIS: the whole point of two marks ──────────────────────────────
	it("has a real gap between the degrade and restore marks", () => {
		expect(BACKLOG_RESTORE_BELOW_BYTES).toBeLessThan(
			BACKLOG_DEGRADE_ABOVE_BYTES,
		);
	});

	it("holds the tier anywhere inside the band, from either direction", () => {
		for (const backlog of [
			BACKLOG_RESTORE_BELOW_BYTES,
			MID_BAND,
			BACKLOG_DEGRADE_ABOVE_BYTES,
		]) {
			expect(chooseCaptureTier("full", backlog)).toBe("full");
			expect(chooseCaptureTier("reduced", backlog)).toBe("reduced");
			expect(chooseCaptureTier("minimal", backlog)).toBe("minimal");
		}
	});

	it("cannot flap: a backlog hovering at the degrade mark settles instead of oscillating", () => {
		// Simulates the failure mode a single threshold would produce — a backlog
		// wobbling either side of the high-water mark, sampled every few seconds.
		const wobble = [
			BACKLOG_DEGRADE_ABOVE_BYTES + 1,
			BACKLOG_DEGRADE_ABOVE_BYTES - 1,
			BACKLOG_DEGRADE_ABOVE_BYTES + 1,
			BACKLOG_DEGRADE_ABOVE_BYTES - 1,
			BACKLOG_DEGRADE_ABOVE_BYTES + 1,
			BACKLOG_DEGRADE_ABOVE_BYTES - 1,
		];
		let tier: CaptureTierName = "full";
		const seen: CaptureTierName[] = [];
		for (const backlog of wobble) {
			tier = chooseCaptureTier(tier, backlog);
			seen.push(tier);
		}
		// It walks DOWN as the mark keeps being exceeded, and never walks back up
		// while the backlog stays above the restore mark.
		expect(seen).toEqual([
			"reduced",
			"reduced",
			"minimal",
			"minimal",
			"minimal",
			"minimal",
		]);
	});

	it("recovers only after the link genuinely drains below the restore mark", () => {
		let tier: CaptureTierName = "minimal";
		// Draining, but still inside the band: no restore yet.
		tier = chooseCaptureTier(tier, MID_BAND);
		expect(tier).toBe("minimal");
		// Now genuinely drained.
		tier = chooseCaptureTier(tier, 0);
		expect(tier).toBe("reduced");
		tier = chooseCaptureTier(tier, 0);
		expect(tier).toBe("full");
		tier = chooseCaptureTier(tier, 0);
		expect(tier).toBe("full");
	});

	it("treats a negative backlog as empty rather than as trouble", () => {
		expect(chooseCaptureTier("reduced", -1)).toBe("full");
	});

	it("holds the current tier when the backlog is not a usable number", () => {
		expect(chooseCaptureTier("reduced", Number.NaN)).toBe("reduced");
		expect(chooseCaptureTier("reduced", Number.POSITIVE_INFINITY)).toBe(
			"reduced",
		);
	});

	it("starts from the best tier when handed an unknown current tier", () => {
		expect(chooseCaptureTier("bogus", 0)).toBe("full");
		expect(chooseCaptureTier("bogus", BACKLOG_DEGRADE_ABOVE_BYTES + 1)).toBe(
			"reduced",
		);
	});

	it("is pure: repeated calls with the same input give the same answer", () => {
		for (let i = 0; i < 5; i++) {
			expect(chooseCaptureTier("full", MID_BAND)).toBe("full");
		}
	});
});
