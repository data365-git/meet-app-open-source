import { describe, expect, it } from "vitest";
import type { VideoMetadata } from "@cap/database/types";

import {
	MAX_QUOTA_RETRY_ATTEMPTS,
	shouldRetryQuotaBlocked,
	withQuotaRetryScheduled,
} from "@/app/api/cron/recover-stale-ai-jobs/stale-job-helpers";

const T0 = Date.parse("2026-07-20T12:00:00.000Z");

function quotaBlocked(extra: Partial<VideoMetadata> = {}): VideoMetadata {
	return {
		transcriptionError: {
			code: "QUOTA",
			message: "credits depleted",
			at: "2026-07-20T11:00:00.000Z",
		},
		...extra,
	} as VideoMetadata;
}

describe("shouldRetryQuotaBlocked", () => {
	it("retries a fresh QUOTA failure", () => {
		expect(shouldRetryQuotaBlocked(quotaBlocked(), T0)).toBe(true);
	});

	it("never retries a GENUINE failure — a broken video must stay dead", () => {
		const md = {
			transcriptionError: {
				code: "FAILED",
				message: "Invalid audio format",
				at: "2026-07-20T11:00:00.000Z",
			},
		} as VideoMetadata;
		expect(shouldRetryQuotaBlocked(md, T0)).toBe(false);
	});

	it("never retries a video with no recorded reason", () => {
		expect(shouldRetryQuotaBlocked({} as VideoMetadata, T0)).toBe(false);
	});

	it("waits until the backoff deadline has passed", () => {
		const md = quotaBlocked({
			quotaRetryAttempts: 1,
			quotaRetryNextAt: new Date(T0 + 60_000).toISOString(),
		});
		expect(shouldRetryQuotaBlocked(md, T0)).toBe(false);
		expect(shouldRetryQuotaBlocked(md, T0 + 61_000)).toBe(true);
	});

	it("stops once the attempt budget is spent", () => {
		const md = quotaBlocked({ quotaRetryAttempts: MAX_QUOTA_RETRY_ATTEMPTS });
		expect(shouldRetryQuotaBlocked(md, T0)).toBe(false);
	});

	it("the budget outlives a realistic top-up delay (the 2.5h bug)", () => {
		// A flat 5-attempt cap at a 30-min cadence died ~2.5h in — long before a
		// human tops the account up. The budget must still be alive a day later.
		let md = quotaBlocked();
		let now = T0;
		let retries = 0;
		while (shouldRetryQuotaBlocked(md, now)) {
			md = withQuotaRetryScheduled(md, now);
			retries++;
			now = Date.parse(md.quotaRetryNextAt as string);
		}
		expect(now - T0).toBeGreaterThan(24 * 60 * 60 * 1000);
		expect(retries).toBeLessThanOrEqual(MAX_QUOTA_RETRY_ATTEMPTS);
	});
});

describe("withQuotaRetryScheduled", () => {
	it("increments the counter and pushes the next attempt into the future", () => {
		const next = withQuotaRetryScheduled(quotaBlocked(), T0);
		expect(next.quotaRetryAttempts).toBe(1);
		expect(Date.parse(next.quotaRetryNextAt as string)).toBeGreaterThan(T0);
	});

	it("backs off further on each successive attempt", () => {
		const first = withQuotaRetryScheduled(quotaBlocked(), T0);
		const second = withQuotaRetryScheduled(first, T0);
		const firstGap = Date.parse(first.quotaRetryNextAt as string) - T0;
		const secondGap = Date.parse(second.quotaRetryNextAt as string) - T0;
		expect(secondGap).toBeGreaterThan(firstGap);
	});

	it("preserves unrelated metadata (the counter must survive the re-run)", () => {
		// validateVideo spreads the old metadata on re-entry. If a future edit
		// replaces that merge with a rewrite, quotaRetryAttempts resets to 0 and
		// the retry loop becomes UNBOUNDED — real money once credits exist.
		const md = quotaBlocked({ aiMode: "cheap", autoRecoverAttempts: 2 });
		const next = withQuotaRetryScheduled(md, T0);
		expect(next.aiMode).toBe("cheap");
		expect(next.autoRecoverAttempts).toBe(2);
	});
});
