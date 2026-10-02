import { getOpenRouterBalanceKey } from "@/lib/openrouter-key";

/**
 * The admin badge's OpenRouter balance (exact dollars, straight from the
 * vendor: GET https://openrouter.ai/api/v1/credits -> balance =
 * total_credits - total_usage). Hard rules: 5-minute in-memory cache, 3 s
 * timeout, `null` on ANY failure or missing key, and the key is never logged
 * or returned — only a number (or null) leaves this module.
 */

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

let cache: { value: number | null; at: number } | null = null;

/** Test seam: clears the in-memory cache between test cases. */
export function resetOpenRouterBalanceCache(): void {
	cache = null;
}

export async function getOpenRouterBalance(
	fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
	const now = Date.now();
	if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

	const key = getOpenRouterBalanceKey();
	if (!key) {
		cache = { value: null, at: now };
		return null;
	}

	const settle = (value: number | null) => {
		cache = { value, at: Date.now() };
		return value;
	};

	try {
		const res = await fetchImpl(CREDITS_URL, {
			headers: { Authorization: `Bearer ${key}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			cache: "no-store",
		});
		if (!res.ok) return settle(null);

		const json = (await res.json()) as {
			data?: { total_credits?: unknown; total_usage?: unknown };
		};
		const credits = Number(json?.data?.total_credits);
		const usage = Number(json?.data?.total_usage);
		if (!Number.isFinite(credits) || !Number.isFinite(usage)) {
			return settle(null);
		}
		return settle(Math.round((credits - usage) * 100) / 100);
	} catch {
		return settle(null);
	}
}
