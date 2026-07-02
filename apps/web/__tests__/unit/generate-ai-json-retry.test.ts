import { describe, expect, it, vi } from "vitest";

// Mocks required only so the workflows/generate-ai module can be imported for
// its pure exports (mirrors align-chapters-to-refined.test.ts).
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/groq-client", () => ({
	GROQ_MODEL: "test-model",
	getGroqClient: vi.fn(() => null),
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));

import { parseJsonWithRetry } from "../../workflows/generate-ai";

function attemptSeq(contents: string[]) {
	let calls = 0;
	return {
		fetch: async (_attempt: number) => {
			const content = contents[calls] ?? "{}";
			calls++;
			return { content, inputTokens: 10, outputTokens: 5, model: "m" };
		},
		calls: () => calls,
	};
}

describe("parseJsonWithRetry", () => {
	it("parses on the first attempt without retrying", async () => {
		const seq = attemptSeq(['{"a":1}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 1 });
		expect(seq.calls()).toBe(1);
		expect(out.inputTokens).toBe(10);
	});

	it("retries ONCE on a malformed first response and succeeds", async () => {
		const seq = attemptSeq(['{"a": TRUNC', '{"a":2}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 2 });
		expect(seq.calls()).toBe(2);
		// tokens from BOTH attempts are accumulated (both were paid for)
		expect(out.inputTokens).toBe(20);
		expect(out.outputTokens).toBe(10);
	});

	it("returns parsed:null after two failures (no third attempt)", async () => {
		const seq = attemptSeq(["not json", "still not json", '{"never":1}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toBeNull();
		expect(seq.calls()).toBe(2);
	});

	it("strips markdown code fences before parsing", async () => {
		const seq = attemptSeq(['```json\n{"a":3}\n```']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 3 });
	});
});
