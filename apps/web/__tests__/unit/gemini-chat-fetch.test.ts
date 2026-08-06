import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiChatFetcher } from "@/lib/gemini-chat-fetch";

// Both assertions below correspond to a defect a blind review found in the
// first version of this code, so each is RED against that version:
//   - the free chain was re-walked on every retry round (up to 10 wasted free
//     calls per question, against the quota the feature exists to save);
//   - the final response was drained here, so the caller could never read the
//     real Gemini error and every outage reported as a bare status code.

const PAID = "paid-key";
const FREE = "free-key";

function ok(body = "stream") {
	return new Response(body, { status: 200 });
}
function quota() {
	return new Response(JSON.stringify({ error: "quota exceeded" }), {
		status: 429,
	});
}

let calls: string[];

beforeEach(() => {
	calls = [];
});

/** Records the model each call hit, and answers from a scripted queue. */
function scriptedFetch(responses: Response[]) {
	let i = 0;
	return vi.fn(async (url: string | URL | Request) => {
		const href = String(url);
		const model = href.match(/models\/([^:]+):/)?.[1] ?? "unknown";
		const key = href.match(/key=([^&]+)/)?.[1] ?? "unknown";
		calls.push(`${model}@${key}`);
		const res = responses[i++];
		if (!res) throw new Error("scriptedFetch ran out of responses");
		return res;
	}) as unknown as typeof fetch;
}

describe("createGeminiChatFetcher", () => {
	it("uses the free key first and reports the call as free", async () => {
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			fetchImpl: scriptedFetch([ok()]),
		});

		const res = await f.fetch({ method: "POST" });

		expect(res.status).toBe(200);
		expect(f.usedFreeKey()).toBe(true);
		expect(calls).toEqual([`gemini-3.5-flash@${FREE}`]);
	});

	it("tries the second free model when the first is out of quota", async () => {
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			fetchImpl: scriptedFetch([quota(), ok()]),
		});

		await f.fetch({ method: "POST" });

		expect(f.usedFreeKey()).toBe(true);
		expect(calls).toEqual([
			`gemini-3.5-flash@${FREE}`,
			`gemini-3-flash-preview@${FREE}`,
		]);
	});

	it("falls back to the paid key and stops calling it free", async () => {
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			fetchImpl: scriptedFetch([quota(), quota(), ok()]),
		});

		await f.fetch({ method: "POST" });

		expect(f.usedFreeKey()).toBe(false);
		expect(calls[2]).toBe(`gemini-2.5-flash@${PAID}`);
	});

	it("never re-walks the free chain on a retry — the whole point of the latch", async () => {
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			// free, free, paid(fail), then two more retry rounds
			fetchImpl: scriptedFetch([quota(), quota(), quota(), quota(), ok()]),
		});

		await f.fetch({ method: "POST" }); // round 1: free, free, paid
		await f.fetch({ method: "POST" }); // round 2: paid only
		await f.fetch({ method: "POST" }); // round 3: paid only

		expect(calls).toEqual([
			`gemini-3.5-flash@${FREE}`,
			`gemini-3-flash-preview@${FREE}`,
			`gemini-2.5-flash@${PAID}`,
			`gemini-2.5-flash@${PAID}`,
			`gemini-2.5-flash@${PAID}`,
		]);
		// Exactly two free calls, no matter how many times the caller retries.
		expect(calls.filter((c) => c.endsWith(FREE))).toHaveLength(2);
	});

	it("returns the paid response UNREAD so the caller can report the real error", async () => {
		const realError = JSON.stringify({ error: { message: "malformed request" } });
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			fetchImpl: scriptedFetch([
				quota(),
				quota(),
				new Response(realError, { status: 400 }),
			]),
		});

		const res = await f.fetch({ method: "POST" });

		expect(res.bodyUsed).toBe(false);
		await expect(res.text()).resolves.toContain("malformed request");
	});

	it("goes straight to paid when there is no free key", async () => {
		const f = createGeminiChatFetcher({
			paidKey: PAID,
			fetchImpl: scriptedFetch([ok()]),
		});

		await f.fetch({ method: "POST" });

		expect(f.usedFreeKey()).toBe(false);
		expect(calls).toEqual([`gemini-2.5-flash@${PAID}`]);
	});

	it("falls through to paid when the free key throws at the network level", async () => {
		const impl = vi.fn(async (url: string | URL | Request) => {
			const href = String(url);
			calls.push(href.includes(FREE) ? "free" : "paid");
			if (href.includes(FREE)) throw new Error("ECONNRESET");
			return ok();
		}) as unknown as typeof fetch;

		const f = createGeminiChatFetcher({
			paidKey: PAID,
			freeKey: FREE,
			fetchImpl: impl,
		});

		const res = await f.fetch({ method: "POST" });

		expect(res.status).toBe(200);
		expect(f.usedFreeKey()).toBe(false);
		expect(calls).toEqual(["free", "free", "paid"]);
	});
});
