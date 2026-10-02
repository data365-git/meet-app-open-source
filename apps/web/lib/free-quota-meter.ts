import { serverEnv } from "@cap/env";
import { db } from "@cap/database";
import { aiFreeQuotaUsage } from "@cap/database/schema";
import { eq, sql } from "drizzle-orm";

/**
 * The owner's free-quota meter (admin dashboard badge, 2026-10-02).
 *
 * Google exposes NO "remaining quota" API for the Gemini free tier, so this
 * module counts OUR OWN requests: every Gemini HTTP call made with the FREE
 * key (`serverEnv().GEMINI_API_KEY_FREE`) fires one detached, never-awaited
 * record call. The two hard rules:
 *   1. recording must NEVER slow down or break an AI call —
 *      `recordFreeGeminiCall` returns void synchronously, never throws, and
 *      swallows every failure (one console.warn, once);
 *   2. we never report a "remaining N" number — only a count and whether a
 *      PerDay 429 says the daily limit is gone until PT midnight.
 *
 * Gemini daily quotas (RPD) reset at midnight America/Los_Angeles, so a
 * "day" here is a Pacific-time calendar day, computed via Intl (DST-correct,
 * no hand-coded offsets).
 */

const PT_TIME_ZONE = "America/Los_Angeles";

// en-CA yields ISO-like "YYYY-MM-DD".
const ptDayFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: PT_TIME_ZONE,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/** The Pacific-time calendar day ("YYYY-MM-DD") that `now` falls in. */
export function ptDay(now: Date): string {
	return ptDayFormatter.format(now);
}

/**
 * The next instant PT midnight happens after `now` (DST-correct: found by
 * searching for the PT-day change, never by adding 24h — a fall-back day is
 * 25 wall-clock hours long). If `now` is exactly midnight, the NEXT midnight
 * (24h-ish later) is returned.
 */
export function nextPtMidnight(now: Date): Date {
	const day = ptDay(now);
	// Coarse jumps of 1h until the PT day changes, then binary-search the
	// boundary to 1 ms. Max span is ~25h, so this stays tiny.
	let lo = now.getTime();
	let hi = lo + 3_600_000;
	while (ptDay(new Date(hi)) === day) {
		lo = hi;
		hi += 3_600_000;
	}
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (ptDay(new Date(mid)) === day) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return new Date(hi);
}

/**
 * True only for the DAILY quota wall: HTTP 429 whose body names a PerDay
 * quota (e.g. quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`).
 * PerMinute 429s reset in seconds — those are NOT "kunlik limit tugadi" —
 * and 503s are outages, not quota at all.
 */
export function isDailyQuotaExhausted(status: number, body: string): boolean {
	return status === 429 && /PerDay/i.test(body ?? "");
}

export type FreeQuotaStatus = {
	/** Our own count of free-key Gemini requests made today (PT day). */
	requestsToday: number;
	/** Models whose daily quota a 429 PerDay body has declared exhausted. */
	exhaustedModels: string[];
	/** When the PT day (and with it every daily quota) resets. */
	resetAt: Date;
	perModel: Array<{ model: string; requests: number; exhausted: boolean }>;
};

let recorderWarned = false;

/**
 * Fire-and-forget recorder for ONE Gemini HTTP attempt. Call it as soon as
 * the response status is known; never await it. No-op unless `apiKey` IS the
 * configured free key (the paid key can hold the same value — then it IS a
 * free call and is counted, exactly like isServerPaidGeminiKeyFree says).
 * `body` is only needed on errors, and only the text the caller already has:
 * never consume a stream the caller needs. Must never throw, sync or async.
 */
export function recordFreeGeminiCall(input: {
	apiKey: string | undefined;
	model: string;
	status: number;
	body?: string;
}): void {
	try {
		const freeKey = serverEnv().GEMINI_API_KEY_FREE;
		if (!input.apiKey || !freeKey || input.apiKey !== freeKey) return;

		const dayPt = ptDay(new Date());
		const model = input.model.slice(0, 96);
		const exhausted = isDailyQuotaExhausted(input.status, input.body ?? "");
		const now = new Date();

		const write = db()
			.insert(aiFreeQuotaUsage)
			.values({
				dayPt,
				model,
				requests: 1,
				updatedAt: now,
				...(exhausted ? { dailyExhaustedAt: now } : {}),
			})
			.onDuplicateKeyUpdate({
				set: {
					requests: sql`${aiFreeQuotaUsage.requests} + 1`,
					updatedAt: now,
					...(exhausted ? { dailyExhaustedAt: now } : {}),
				},
			});

		// Detached on purpose: the AI path must never wait on, or see, this.
		void write.catch((error) => {
			if (!recorderWarned) {
				recorderWarned = true;
				console.warn(
					"[free-quota-meter] recording free Gemini usage failed (not warned again this process)",
					error,
				);
			}
		});
	} catch {
		// Even env/db access blowing up must stay invisible to the AI path.
	}
}

/** Today's (PT day) free-quota picture for the admin badge. */
export async function getFreeQuotaStatus(
	now: Date = new Date(),
): Promise<FreeQuotaStatus> {
	const dayPt = ptDay(now);
	const rows = await db()
		.select()
		.from(aiFreeQuotaUsage)
		.where(eq(aiFreeQuotaUsage.dayPt, dayPt));

	return {
		requestsToday: rows.reduce((sum, row) => sum + row.requests, 0),
		exhaustedModels: rows
			.filter((row) => row.dailyExhaustedAt !== null)
			.map((row) => row.model),
		resetAt: nextPtMidnight(now),
		perModel: rows.map((row) => ({
			model: row.model,
			requests: row.requests,
			exhausted: row.dailyExhaustedAt !== null,
		})),
	};
}
