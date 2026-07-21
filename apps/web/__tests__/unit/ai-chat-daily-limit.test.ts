import { describe, expect, it } from "vitest";
import {
	DAILY_CHAT_LIMIT,
	GUEST_VIDEO_DAILY_CHAT_LIMIT,
	isOverDailyChatLimit,
	isOverGuestVideoDailyLimit,
} from "@/lib/ai-chat-limit";

describe("isOverDailyChatLimit", () => {
	it("is not over the limit for counts 0 through 20", () => {
		for (let count = 0; count <= DAILY_CHAT_LIMIT; count++) {
			expect(isOverDailyChatLimit(count)).toBe(false);
		}
	});

	it("is not over the limit exactly at the boundary (20)", () => {
		expect(isOverDailyChatLimit(20)).toBe(false);
	});

	it("is over the limit once count exceeds 20", () => {
		expect(isOverDailyChatLimit(21)).toBe(true);
		expect(isOverDailyChatLimit(22)).toBe(true);
	});
});

describe("isOverGuestVideoDailyLimit (A3 per-video guest total backstop)", () => {
	it("is not over the limit for counts 0 through the cap (200)", () => {
		for (let count = 0; count <= GUEST_VIDEO_DAILY_CHAT_LIMIT; count++) {
			expect(isOverGuestVideoDailyLimit(count)).toBe(false);
		}
	});

	it("is over the limit once the video-wide guest total exceeds the cap", () => {
		expect(
			isOverGuestVideoDailyLimit(GUEST_VIDEO_DAILY_CHAT_LIMIT + 1),
		).toBe(true);
		expect(
			isOverGuestVideoDailyLimit(GUEST_VIDEO_DAILY_CHAT_LIMIT + 2),
		).toBe(true);
	});

	it("blocks a cookie-clearing abuser: a brand-new guest client (own per-client count is only 1) is still blocked once the video-wide guest total is over the cap", () => {
		const freshGuestOwnCount = 1; // first message on a brand-new cookie
		expect(isOverDailyChatLimit(freshGuestOwnCount)).toBe(false); // per-client cap alone would let this request through
		const videoWideGuestTotal = GUEST_VIDEO_DAILY_CHAT_LIMIT + 1; // many prior cookie resets added up on this video
		expect(isOverGuestVideoDailyLimit(videoWideGuestTotal)).toBe(true); // the per-video backstop still blocks it
	});

	it("allows a guest while the video-wide total is under the cap, even at the per-client boundary", () => {
		const ownCount = DAILY_CHAT_LIMIT; // exactly at the per-client boundary, still allowed
		expect(isOverDailyChatLimit(ownCount)).toBe(false);
		const videoWideGuestTotal = GUEST_VIDEO_DAILY_CHAT_LIMIT; // exactly at the per-video cap boundary
		expect(isOverGuestVideoDailyLimit(videoWideGuestTotal)).toBe(false);
	});
});
