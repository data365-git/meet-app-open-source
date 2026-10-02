/**
 * The owner's free-quota meter (lib/free-quota-meter.ts, admin badge
 * 2026-10-02). Three properties that each correspond to a real failure mode:
 *
 *  1. PT-day math is DST-correct (Intl, never hand-coded offsets) - a
 *     fall-back day is 25 wall-clock hours long, so "next PT midnight"
 *     must be FOUND, not added.
 *  2. Only a 429 whose body names a PerDay quota means "kunlik limit
 *     tugadi" - PerMinute 429s reset in seconds and 503s are outages.
 *  3. Recording is invisible to the AI path: no-op for a non-free key,
 *     never throws even when the DB rejects, and warns once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const env: { GEMINI_API_KEY_FREE?: string } = {};
const dbState = {
  impl: () => {
    throw new Error("db impl not configured");
  },
};

vi.mock("@cap/env", () => ({ serverEnv: () => env }));

vi.mock("@cap/database", () => ({
  db: () => dbState.impl(),
}));

vi.mock("@cap/database/schema", () => ({
  aiFreeQuotaUsage: {
    dayPt: "dayPt",
    model: "model",
    requests: "requests",
    dailyExhaustedAt: "dailyExhaustedAt",
    updatedAt: "updatedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (field: unknown, value: unknown) => ({ field, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
}));

async function freshModule() {
  vi.resetModules();
  return import("../../lib/free-quota-meter");
}

beforeEach(() => {
  delete env.GEMINI_API_KEY_FREE;
});

describe("ptDay / nextPtMidnight (Pacific day, DST-correct)", () => {
  it("ptDay maps an instant to the Pacific calendar day", async () => {
    const { ptDay } = await freshModule();
    // 2026-10-02 01:00 UTC = 2026-10-01 18:00 PDT
    expect(ptDay(new Date("2026-10-02T01:00:00Z"))).toBe("2026-10-01");
    // 2026-10-02 07:00 UTC = midnight PDT -> new PT day
    expect(ptDay(new Date("2026-10-02T07:00:00Z"))).toBe("2026-10-02");
  });

  it("the fall-back night 2026-11-01 (PDT->PST) still lands on one PT day", async () => {
    const { ptDay } = await freshModule();
    // DST change: 2026-11-01 09:00 UTC = 01:00 PST (clock fell back)
    expect(ptDay(new Date("2026-11-01T08:59:59Z"))).toBe("2026-11-01");
    expect(ptDay(new Date("2026-11-01T09:00:00Z"))).toBe("2026-11-01");
  });

  it("nextPtMidnight is 24h away on a normal day, 25h on the fall-back day", async () => {
    const { nextPtMidnight } = await freshModule();
    // 2026-10-02: PDT midnight = 07:00 UTC (24h day)
    expect(nextPtMidnight(new Date("2026-10-02T07:00:00Z")).getTime()).toBe(
      Date.parse("2026-10-03T07:00:00Z"),
    );
    // PT day 2026-11-01 starts 00:00 PDT (07:00 UTC) and ends 00:00 PST
    // (08:00 UTC) -> 25 wall-clock hours.
    expect(nextPtMidnight(new Date("2026-11-01T07:00:00Z")).getTime()).toBe(
      Date.parse("2026-11-02T08:00:00Z"),
    );
  });

  it("around PT midnight: the last ms of the old day, then exactly midnight", async () => {
    const { ptDay, nextPtMidnight } = await freshModule();
    const lastMs = new Date("2026-10-02T06:59:59.999Z");
    expect(ptDay(lastMs)).toBe("2026-10-01");
    expect(nextPtMidnight(lastMs).getTime()).toBe(
      Date.parse("2026-10-02T07:00:00Z"),
    );
    // Exactly midnight -> the NEXT midnight, not `now` itself.
    expect(nextPtMidnight(new Date("2026-10-02T07:00:00Z")).getTime()).toBe(
      Date.parse("2026-10-03T07:00:00Z"),
    );
  });

  it("spring-forward day: PT day 2026-03-08 is only 23 hours", async () => {
    const { nextPtMidnight } = await freshModule();
    expect(nextPtMidnight(new Date("2026-03-08T08:00:00Z")).getTime()).toBe(
      Date.parse("2026-03-09T07:00:00Z"),
    );
  });
});

describe("isDailyQuotaExhausted", () => {
  it("true only for a 429 whose body names a PerDay quota", async () => {
    const { isDailyQuotaExhausted } = await freshModule();
    expect(
      isDailyQuotaExhausted(
        429,
        '{"error":{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}',
      ),
    ).toBe(true);
  });

  it("PerMinute 429 is NOT daily exhaustion", async () => {
    const { isDailyQuotaExhausted } = await freshModule();
    expect(
      isDailyQuotaExhausted(
        429,
        '{"error":{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}}',
      ),
    ).toBe(false);
  });

  it("503 is not quota at all", async () => {
    const { isDailyQuotaExhausted } = await freshModule();
    expect(isDailyQuotaExhausted(503, "PerDay overloaded")).toBe(false);
  });
});

describe("recordFreeGeminiCall", () => {
  it("no-op for a key that is not the free key (DB never touched)", async () => {
    env.GEMINI_API_KEY_FREE = "free-key";
    const insert = vi.fn();
    dbState.impl = () => ({ insert }) as never;
    const { recordFreeGeminiCall } = await freshModule();

    expect(() =>
      recordFreeGeminiCall({
        apiKey: "some-other-key",
        model: "gemini-2.5-flash",
        status: 200,
      }),
    ).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("no-op when no free key is configured", async () => {
    const insert = vi.fn();
    dbState.impl = () => ({ insert }) as never;
    const { recordFreeGeminiCall } = await freshModule();

    expect(() =>
      recordFreeGeminiCall({
        apiKey: "free-key",
        model: "gemini-2.5-flash",
        status: 200,
      }),
    ).not.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("free key + 200: counted WITHOUT dailyExhaustedAt", async () => {
    env.GEMINI_API_KEY_FREE = "free-key";
    let capturedSet: Record<string, unknown> | undefined;
    const values = vi.fn((row: Record<string, unknown>) => ({
      onDuplicateKeyUpdate: (arg: { set: Record<string, unknown> }) => {
        capturedSet = arg.set;
        return Promise.resolve();
      },
      row,
    }));
    const insert = vi.fn(() => ({ values }));
    dbState.impl = () => ({ insert }) as never;
    const { recordFreeGeminiCall } = await freshModule();

    recordFreeGeminiCall({
      apiKey: "free-key",
      model: "gemini-2.5-flash",
      status: 200,
    });
    expect(insert).toHaveBeenCalled();
    const row = values.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(row?.requests).toBe(1);
    expect(row?.dailyExhaustedAt).toBeUndefined();
    expect(capturedSet?.dailyExhaustedAt).toBeUndefined();
    expect(capturedSet?.requests).toBeDefined();
  });

  it("free key + 429 PerDay: dailyExhaustedAt set on insert AND update", async () => {
    env.GEMINI_API_KEY_FREE = "free-key";
    let capturedSet: Record<string, unknown> | undefined;
    const values = vi.fn((row: Record<string, unknown>) => ({
      onDuplicateKeyUpdate: (arg: { set: Record<string, unknown> }) => {
        capturedSet = arg.set;
        return Promise.resolve();
      },
      row,
    }));
    const insert = vi.fn(() => ({ values }));
    dbState.impl = () => ({ insert }) as never;
    const { recordFreeGeminiCall } = await freshModule();

    recordFreeGeminiCall({
      apiKey: "free-key",
      model: "gemini-2.5-flash",
      status: 429,
      body: '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}',
    });
    expect(capturedSet?.dailyExhaustedAt).toBeInstanceOf(Date);
    const row = values.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(row?.dailyExhaustedAt).toBeInstanceOf(Date);
  });

  it("never throws and warns once when the DB write rejects", async () => {
    env.GEMINI_API_KEY_FREE = "free-key";
    const values = vi.fn(() => ({
      onDuplicateKeyUpdate: () => Promise.reject(new Error("db down")),
    }));
    const insert = vi.fn(() => ({ values }));
    dbState.impl = () => ({ insert }) as never;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { recordFreeGeminiCall } = await freshModule();

    expect(() =>
      recordFreeGeminiCall({
        apiKey: "free-key",
        model: "gemini-2.5-flash",
        status: 200,
      }),
    ).not.toThrow();

    // Let the detached promise settle before asserting the swallow.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(() =>
      recordFreeGeminiCall({
        apiKey: "free-key",
        model: "gemini-2.5-flash",
        status: 200,
      }),
    ).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("free-quota-meter");
    warn.mockRestore();
  });

  it("never throws when db() itself throws synchronously", async () => {
    env.GEMINI_API_KEY_FREE = "free-key";
    dbState.impl = () => {
      throw new Error("no pool");
    };
    const { recordFreeGeminiCall } = await freshModule();

    expect(() =>
      recordFreeGeminiCall({
        apiKey: "free-key",
        model: "gemini-2.5-flash",
        status: 200,
      }),
    ).not.toThrow();
  });
});

describe("getFreeQuotaStatus", () => {
  it("aggregates today's rows into the badge shape", async () => {
    const rows = [
      {
        dayPt: "2026-10-02",
        model: "gemini-2.5-flash",
        requests: 9,
        dailyExhaustedAt: new Date("2026-10-02T10:00:00Z"),
        updatedAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        dayPt: "2026-10-02",
        model: "gemini-embedding",
        requests: 5,
        dailyExhaustedAt: null,
        updatedAt: new Date("2026-10-02T09:00:00Z"),
      },
    ];
    const where = vi.fn(() => Promise.resolve(rows));
    const from = vi.fn(() => ({ where }));
    dbState.impl = () => ({ select: () => ({ from }) }) as never;
    const { getFreeQuotaStatus, nextPtMidnight } = await freshModule();

    const now = new Date("2026-10-02T12:00:00Z");
    const status = await getFreeQuotaStatus(now);
    expect(status.requestsToday).toBe(14);
    expect(status.exhaustedModels).toEqual(["gemini-2.5-flash"]);
    expect(status.resetAt.getTime()).toBe(nextPtMidnight(now).getTime());
    expect(status.perModel).toEqual([
      { model: "gemini-2.5-flash", requests: 9, exhausted: true },
      { model: "gemini-embedding", requests: 5, exhausted: false },
    ]);
  });
});
