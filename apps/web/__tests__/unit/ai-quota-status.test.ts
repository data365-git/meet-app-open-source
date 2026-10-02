/**
 * The admin badge text (app/(org)/dashboard/_components/AiQuotaStatus.tsx).
 * The line is pure text so it can be pinned exactly: "ishlayapti" while the
 * free key works, "kunlik limit tugadi" after a PerDay 429, reset time in
 * TASHKENT time (12:00 during PDT, 13:00 during PST, "ertaga " when the
 * reset lands on a later Tashkent day), and "-" when OpenRouter is unknown.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/free-quota-meter", () => ({
  getFreeQuotaStatus: vi.fn(),
}));
vi.mock("@/lib/openrouter-balance", () => ({
  getOpenRouterBalance: vi.fn(),
}));

import {
  buildAiQuotaStatusText,
  formatResetAtTashkent,
} from "../../app/(org)/dashboard/_components/AiQuotaStatus";

describe("formatResetAtTashkent", () => {
  it("PT midnight during PDT is 12:00 in Tashkent (same Tashkent day: no prefix)", () => {
    // now 2026-10-02 02:00 UTC = 07:00 Tashkent Oct 2; reset Oct 2 12:00 Tashkent
    expect(
      formatResetAtTashkent(
        new Date("2026-10-02T07:00:00Z"),
        new Date("2026-10-02T02:00:00Z"),
      ),
    ).toBe("12:00");
  });

  it("PT midnight after the fall-back (PST) is 13:00 in Tashkent", () => {
    // now 2026-11-02 02:00 UTC = 07:00 Tashkent Nov 2; reset Nov 2 13:00 Tashkent
    expect(
      formatResetAtTashkent(
        new Date("2026-11-02T08:00:00Z"),
        new Date("2026-11-02T02:00:00Z"),
      ),
    ).toBe("13:00");
  });

  it('prefixed "ertaga " when the reset is a later Tashkent day', () => {
    // now 2026-10-02 18:30 UTC = 23:30 Tashkent Oct 2; reset Oct 3 12:00 Tashkent
    expect(
      formatResetAtTashkent(
        new Date("2026-10-03T07:00:00Z"),
        new Date("2026-10-02T18:30:00Z"),
      ),
    ).toBe("ertaga 12:00");
  });
});

describe("buildAiQuotaStatusText", () => {
  // 07:00 Tashkent on Oct 2: the PDT-day reset (12:00 Tashkent) is still
  // the SAME Tashkent day, so no "ertaga" prefix on the primary line.
  const now = new Date("2026-10-02T02:00:00Z");
  const resetAt = new Date("2026-10-02T07:00:00Z");

  it("ok: working, today's own count, reset time, balance", () => {
    expect(
      buildAiQuotaStatusText({
        requestsToday: 14,
        exhausted: false,
        resetAt,
        balance: 8.73,
        now,
      }),
    ).toEqual({
      status: "ishlayapti",
      detail: "bugun 14 so'rov · yangilanadi 12:00",
      balance: "$8.73",
    });
  });

  it("exhausted: status word and reset-at wording, balance kept", () => {
    expect(
      buildAiQuotaStatusText({
        requestsToday: 250,
        exhausted: true,
        resetAt,
        balance: 8.73,
        now,
      }),
    ).toEqual({
      status: "kunlik limit tugadi",
      detail: "12:00 da tiklanadi",
      balance: "$8.73",
    });
  });

  it("evening now -> reset gets the ertaga prefix", () => {
    expect(
      buildAiQuotaStatusText({
        requestsToday: 14,
        exhausted: false,
        resetAt: new Date("2026-10-03T07:00:00Z"),
        balance: 8.73,
        now: new Date("2026-10-02T12:00:00Z"),
      }),
    ).toMatchObject({ detail: "bugun 14 so'rov · yangilanadi ertaga 12:00" });
  });

  it("null balance renders as a dash, never as $0 or NaN", () => {
    expect(
      buildAiQuotaStatusText({
        requestsToday: 0,
        exhausted: false,
        resetAt,
        balance: null,
        now,
      }),
    ).toMatchObject({ balance: "—" });
  });
});
