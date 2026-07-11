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

import { readTask } from "@/workflows/generate-ai";

describe("readTask category (T8)", () => {
	it("preserves a valid category from the controlled vocab", () => {
		const task = readTask({
			title: "Send the invoice",
			assignee: "Alice",
			priority: "high",
			deadline: "2024-07-05",
			done: false,
			category: "Moliya",
		});
		expect(task?.category).toBe("Moliya");
	});

	it("falls back to Boshqa when the category is missing", () => {
		const task = readTask({ title: "Untitled action item" });
		expect(task?.category).toBe("Boshqa");
	});

	it("falls back to Boshqa when the category is outside the controlled vocab", () => {
		const task = readTask({
			title: "Something the model invented",
			category: "Random Made-Up Category",
		});
		expect(task?.category).toBe("Boshqa");
	});

	it("still drops tasks with no usable title regardless of category", () => {
		const task = readTask({ title: "", category: "Texnik" });
		expect(task).toBeNull();
	});
});
