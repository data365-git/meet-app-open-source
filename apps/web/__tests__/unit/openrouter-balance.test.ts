/**
 * The admin badge's OpenRouter balance (lib/openrouter-balance.ts):
 * balance = total_credits - total_usage, exact to the cent; null on ANY
 * failure (401, timeout, missing key, malformed body) - never a number we
 * invented. Cached 5 minutes so the dashboard cannot hammer the vendor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const keyState = { value: undefined as string | undefined };

vi.mock("@/lib/openrouter-key", () => ({
  getOpenRouterBalanceKey: () => keyState.value,
}));

import {
  getOpenRouterBalance,
  resetOpenRouterBalanceCache,
} from "@/lib/openrouter-balance";

beforeEach(() => {
  keyState.value = "sk-or-test";
  resetOpenRouterBalanceCache();
});

describe("getOpenRouterBalance", () => {
  it("parses credits minus usage and rounds to cents", async () => {
    expect(
      await getOpenRouterBalance(async () =>
        new Response(
          JSON.stringify({ data: { total_credits: 60, total_usage: 51.27 } }),
          { status: 200 },
        ),
      ),
    ).toBe(8.73);
  });

  it("returns null on 401 (bad key must never render as $0)", async () => {
    expect(
      await getOpenRouterBalance(async () =>
        new Response("unauthorized", { status: 401 }),
      ),
    ).toBeNull();
  });

  it("returns null when fetch rejects (timeout/network)", async () => {
    expect(
      await getOpenRouterBalance(async () => {
        throw new Error("AbortError: timed out");
      }),
    ).toBeNull();
  });

  it("returns null when the key is missing", async () => {
    keyState.value = undefined;
    const fetchSpy = vi.fn();
    expect(await getOpenRouterBalance(fetchSpy as never)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null on a malformed body", async () => {
    expect(
      await getOpenRouterBalance(async () =>
        new Response("<html>proxy error</html>", { status: 200 }),
      ),
    ).toBeNull();
  });

  it("caches for 5 minutes (second call does not fetch)", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { total_credits: 60, total_usage: 51.27 } }),
        { status: 200 },
      ),
    );
    expect(await getOpenRouterBalance(fetchSpy as never)).toBe(8.73);
    expect(await getOpenRouterBalance(fetchSpy as never)).toBe(8.73);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends the key as a Bearer header and nothing else leaks", async () => {
    let seenHeaders: Headers | undefined;
    await getOpenRouterBalance(async (_url, init) => {
      seenHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({ data: { total_credits: 1, total_usage: 0 } }),
        { status: 200 },
      );
    });
    expect(seenHeaders?.get("Authorization")).toBe("Bearer sk-or-test");
  });
});
