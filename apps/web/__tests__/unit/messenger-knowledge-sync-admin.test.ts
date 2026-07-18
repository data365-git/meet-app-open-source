import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the privilege-escalation fix in apps/web/lib/messenger/supermemory.ts.
// syncCapKnowledgeBase() used to accept the CALLER-SUPPLIED email and compare it to a
// hardcoded literal ("richie@cap.so"), which anyone could self-register with (no mailbox
// verification). It must now be gated by the caller's DB-backed isAdmin boolean.

vi.mock("server-only", () => ({}));

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		SUPERMEMORY_API_KEY: undefined,
		SUPERMEMORY_KNOWLEDGE_TAG: undefined,
	})),
}));

describe("syncCapKnowledgeBase (apps/web/lib/messenger/supermemory.ts)", () => {
	let syncCapKnowledgeBase: typeof import("@/lib/messenger/supermemory").syncCapKnowledgeBase;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("@/lib/messenger/supermemory");
		syncCapKnowledgeBase = mod.syncCapKnowledgeBase;
	});

	it("rejects a non-admin caller (isAdmin: false), even one impersonating richie@cap.so's identity", async () => {
		await expect(syncCapKnowledgeBase(false)).rejects.toThrow("Unauthorized");
	});

	it("accepts an isAdmin: true caller (passes the auth gate, may still fail later for unrelated config reasons)", async () => {
		await expect(syncCapKnowledgeBase(true)).rejects.toThrow(
			"SUPERMEMORY_API_KEY is not configured",
		);
	});
});
