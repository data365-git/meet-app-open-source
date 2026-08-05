import { describe, expect, it } from "vitest";

import {
	BACKLOG_DEGRADE_ABOVE_BYTES,
	BACKLOG_RESTORE_BELOW_BYTES,
	CAPTURE_TIERS,
	type CaptureTierName,
	captureTierChangeNotice,
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

	// The caps are the ONLY part of a tier that takes effect on a running
	// recording (videoBitsPerSecond is fixed when the MediaRecorder is built and
	// the recorder is never rebuilt mid-run). So the floor's ability to rescue a
	// struggling upload lives entirely in this number, and e2e-audio-proof/
	// run-tier-bitrate-proof.mjs measures what it is worth in real bytes.
	//
	// This is the cheap guard that stops the table drifting back under the bar
	// the expensive harness proved: that harness needs a headed desktop and ~3
	// minutes, so it is not what a routine `vitest run` would catch a regression
	// with. 8x pixel-rate is the structural headroom behind a measured 3x+ of
	// actual bytes — encoders never give back the full ratio, so the arithmetic
	// bar has to sit above the byte bar.
	it("leaves the floor with enough pixel-rate headroom to rescue a slow link", () => {
		const pixelRate = (t: (typeof CAPTURE_TIERS)[number]) =>
			t.maxWidth * t.maxHeight * t.frameRate;
		const best = CAPTURE_TIERS[0];
		const floor = CAPTURE_TIERS[CAPTURE_TIERS.length - 1];
		expect(pixelRate(best) / pixelRate(floor)).toBeGreaterThanOrEqual(8);
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

// ── The user-facing half: told plainly, told truthfully, never falsely ──────
//
// These assert the two failure modes that matter. (1) Silence on a real drop:
// the recording goes blurry and the user is left guessing. (2) A false alarm:
// a message for a hiccup that resolved itself, which is worse than silence
// because it teaches people to ignore the message that mattered. The second is
// structural — the notice is derived from the tier move, and the hysteresis
// band means a short backlog produces no move — so it is asserted by walking a
// real backlog through chooseCaptureTier, not by trusting the wording.
describe("captureTierChangeNotice", () => {
	it("says nothing at all when the tier did not move", () => {
		expect(captureTierChangeNotice("full", "full")).toBeNull();
		expect(captureTierChangeNotice("reduced", "reduced")).toBeNull();
		expect(captureTierChangeNotice("minimal", "minimal")).toBeNull();
	});

	it("produces NO message for a brief backlog that recovers inside the hysteresis window", () => {
		// A backlog that rises to just under the high-water mark and drains again.
		// Every step is fed through the real decision function, so this is the
		// actual production path, not a re-statement of the rule.
		let tier: CaptureTierName = "full";
		const notices: unknown[] = [];
		for (const backlog of [
			0,
			BACKLOG_RESTORE_BELOW_BYTES + 1,
			BACKLOG_DEGRADE_ABOVE_BYTES - 1,
			BACKLOG_DEGRADE_ABOVE_BYTES,
			BACKLOG_RESTORE_BELOW_BYTES + 1,
			0,
		]) {
			const next = chooseCaptureTier(tier, backlog);
			const notice = captureTierChangeNotice(tier, next);
			if (notice) notices.push(notice);
			tier = next;
		}
		expect(tier).toBe("full");
		expect(notices).toEqual([]);
	});

	it("tells the user plainly when quality drops, and why", () => {
		const notice = captureTierChangeNotice("full", "reduced");
		expect(notice).not.toBeNull();
		if (!notice) throw new Error("expected a notice");
		expect(notice.title).toBe("Recording quality reduced");
		// The observation the signal actually supports: the link is behind the
		// recording. Not "your internet is slow" — the backlog cannot tell a slow
		// wifi from a slow server.
		expect(notice.message).toContain("connection is slower than the recording");
		expect(notice.message).toContain("finish uploading");
		expect(notice.restored).toBe(false);
	});

	it("states the quality it actually switched to, taken from the tier table", () => {
		const notice = captureTierChangeNotice("reduced", "minimal");
		if (!notice) throw new Error("expected a notice");
		const minimal = captureTierFor("minimal");
		expect(notice.message).toContain(`${minimal.maxHeight}p`);
		expect(notice.message).toContain(`${minimal.frameRate} fps`);
	});

	it("never claims audio was reduced — no tier touches it", () => {
		const audioRates = new Set(CAPTURE_TIERS.map((t) => t.audioBitsPerSecond));
		expect(audioRates.size).toBe(1);
		const notice = captureTierChangeNotice("full", "reduced");
		if (!notice) throw new Error("expected a notice");
		expect(notice.message).toContain("Audio is unchanged");
	});

	it("does not promise an outcome it cannot know", () => {
		for (const [from, to] of [
			["full", "reduced"],
			["reduced", "minimal"],
			["minimal", "reduced"],
			["reduced", "full"],
		] as const) {
			const notice = captureTierChangeNotice(from, to);
			if (!notice) throw new Error("expected a notice");
			// No promises about time or certainty of completion, and no diagnosis
			// of a cause the backlog cannot identify.
			expect(notice.message).not.toMatch(
				/will (finish|complete|upload)|guarantee|your (internet|wifi|network)|minutes? (left|remaining)/i,
			);
		}
	});

	it("tells the user when quality is restored", () => {
		const notice = captureTierChangeNotice("reduced", "full");
		if (!notice) throw new Error("expected a notice");
		expect(notice.title).toBe("Recording quality restored");
		expect(notice.message).toContain("back to full");
		expect(notice.restored).toBe(true);
	});

	it("does not claim FULL restoration on a partial step back up", () => {
		const notice = captureTierChangeNotice("minimal", "reduced");
		if (!notice) throw new Error("expected a notice");
		expect(notice.restored).toBe(false);
		expect(notice.title).toBe("Recording quality partly restored");
		const reduced = captureTierFor("reduced");
		expect(notice.message).toContain(`${reduced.maxHeight}p`);
	});

	it("replaces the previous notice instead of stacking a new one", () => {
		const ids = (
			[
				["full", "reduced"],
				["reduced", "minimal"],
				["minimal", "reduced"],
				["reduced", "full"],
			] as const
		).map(([from, to]) => captureTierChangeNotice(from, to)?.id);
		expect(new Set(ids).size).toBe(1);
	});

	it("says nothing for an unknown tier name rather than inventing an event", () => {
		expect(captureTierChangeNotice("bogus", "full")).toBeNull();
		expect(captureTierChangeNotice("full", "bogus")).toBeNull();
	});
});
