// @vitest-environment jsdom
//
// Honest AI status on the recording page (owner order 2026-09-25: "pul tugasa
// pul tugadi desin - nima muammoligini va aniq statusni ko'rsatsin, yolg'on va
// bugsiz"). One assertion per state: S1 quota-retries-exhausted, S2 monthly
// budget cap (owner + public), S3 transcript gap ranges, S4 free-quota
// waiting, S5 generation budget/quota deaths, the classifier itself, and the
// generate route's 402 refusal. Each must go RED when its mapping is removed.
import type { NextRequest } from "next/server";
import type { Video } from "@cap/web-domain";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keys + values, so param-bearing messages (spent/cap, gap ranges) are
// assertable, and the design-system dropdown is a passthrough.
vi.mock("next-intl", () => ({
	useTranslations:
		() =>
		(key: string, values?: Record<string, string>) =>
			values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock("@cap/ui", () => {
	const passthrough =
		(tag: string) =>
		({ children }: { children?: unknown }) =>
			createElement(tag, null, children as never);
	return {
		DropdownMenu: passthrough("div"),
		DropdownMenuContent: passthrough("div"),
		DropdownMenuItem: passthrough("div"),
		DropdownMenuTrigger: passthrough("div"),
	};
});

import { GenerateAiPanel } from "@/app/s/[videoId]/_components/GenerateAiPanel";
import {
	classifyAiGenerationError,
	formatTranscriptGapRanges,
	transcriptionErrorMessageKey,
} from "@/app/s/[videoId]/_components/transcription-error-message";

const VIDEO_ID = "vid_1" as Video.VideoId;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

type PanelProps = Parameters<typeof GenerateAiPanel>[0];

/** Renders the REAL panel with exactly the props ShareVideo would hand it for
 * a given server state; returns the rendered text (keys + JSON'd values). */
function renderPanel(props: Partial<PanelProps>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(GenerateAiPanel, {
				videoId: VIDEO_ID,
				canGenerate: true,
				duration: 600,
				...props,
			} as PanelProps),
		);
	});
		const text = container.textContent ?? "";
	act(() => root.unmount());
	container.remove();
	return text;
}

/** Renders the REAL error-state panel, presses its Retry button (which fires
 * the generate POST against a mocked fetch), and returns the text AFTER the
 * 402 answer lands — the same path a real owner takes to the budget line. */
async function renderPanelAfterRetry(
	props: Partial<PanelProps>,
	fetchResult: { ok: false; json: () => Promise<unknown> },
) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => fetchResult),
	);
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(GenerateAiPanel, {
				videoId: VIDEO_ID,
				canGenerate: true,
				duration: 600,
				...props,
			} as PanelProps),
		);
	});
	const retryButton = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "aiRetry",
	);
	expect(retryButton).toBeDefined();
	await act(async () => {
		retryButton?.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
	const text = container.textContent ?? "";
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	return text;
}

describe("honest AI status — S1 quota retries exhausted (the promise must die with the ladder)", () => {
	it("owner sees the MANUAL-retry sentence, not the false 'we retry automatically'", () => {
		const text = renderPanel({
			transcriptionStatus: "ERROR",
			transcriptionErrorCode: "QUOTA",
			quotaRetriesExhausted: true,
		});
		expect(text).toContain("aiTranscriptionQuotaExhausted");
		expect(text).not.toContain("aiTranscriptionQuotaFailed");
		expect(text).toContain("aiRetry");
	});

	it("public viewer: no billing fact, and no auto-retry promise either", () => {
		const text = renderPanel({
			transcriptionStatus: "ERROR",
			transcriptionErrorCode: "QUOTA",
			quotaRetriesExhausted: true,
			canGenerate: false,
		});
		expect(text).toContain("aiTranscriptionQuotaExhaustedPublic");
		expect(text).not.toContain("aiTranscriptionQuotaFailedPublic");
	});

	it("message key itself: exhausted flips the key, non-exhausted keeps the old promise", () => {
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: "QUOTA",
				canGenerate: true,
				quotaRetriesExhausted: true,
			}),
		).toBe("aiTranscriptionQuotaExhausted");
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: "QUOTA",
				canGenerate: true,
			}),
		).toBe("aiTranscriptionQuotaFailed");
	});
});

describe("honest AI status — S2 monthly budget cap", () => {
	const budgetError = {
		transcriptionStatus: "COMPLETE" as const,
		aiGenerationStatus: "ERROR" as const,
		aiGenerationErrorCode: "BUDGET" as const,
	};

	it("owner with no session numbers (reload before any 402) gets the honest plain line — never a fabricated $0.00 pair", () => {
		const text = renderPanel(budgetError);
		expect(text).toContain("aiBudgetBlockedPlain");
		expect(text).not.toContain('"spent"');
		expect(text).not.toContain("$0.00");
	});

	it("public viewer sees the neutral pause line — never money numbers", () => {
		const text = renderPanel({ ...budgetError, canGenerate: false });
		expect(text).toContain("aiBudgetBlockedPublic");
		expect(text).not.toContain('"spent"');
		expect(text).not.toContain("aiBudgetBlockedPlain");
	});

	it("402 WITH spent/cap numbers: owner sees the real pair after pressing Retry", async () => {
		const text = await renderPanelAfterRetry(budgetError, {
			ok: false,
			json: async () => ({
				code: "AI_BUDGET_EXCEEDED",
				spentUsd: 14.02,
				capUsd: 100,
			}),
		});
		expect(text).toContain('"spent":"$14.02"');
		expect(text).toContain('"cap":"$100.00"');
		expect(text).not.toContain("aiBudgetBlockedPlain");
		expect(text).not.toContain("aiAnalysisFailed");
	});

	it("402 WITHOUT numbers (lookup failed server-side): plain line, never a fabricated $0.00/$0.00", async () => {
		const text = await renderPanelAfterRetry(budgetError, {
			ok: false,
			json: async () => ({ code: "AI_BUDGET_EXCEEDED" }),
		});
		expect(text).toContain("aiBudgetBlockedPlain");
		expect(text).not.toContain('"spent"');
		expect(text).not.toContain("$0.00");
	});
});

describe("honest AI status — S3 transcript gaps", () => {
	it("formats the real production gaps as h:mm:ss ranges", () => {
		expect(
			formatTranscriptGapRanges([
				{ startSec: 6161, endSec: 6421 },
				{ startSec: 6731, endSec: 7131 },
			]),
		).toBe("1:42:41-1:47:01, 1:52:11-1:58:51");
	});

	it("caps the list at 4 ranges with an ellipsis (no wall of numbers)", () => {
		const gaps = Array.from({ length: 6 }, (_, i) => ({
			startSec: i * 60,
			endSec: i * 60 + 30,
		}));
		const out = formatTranscriptGapRanges(gaps);
		expect(out.endsWith(", …")).toBe(true);
		expect(out.split("-").length).toBeLessThan(12); // 4 ranges, not 6
	});
});

describe("honest AI status — S4 free-quota waiting", () => {
	it("a parked run says it is waiting and will continue on its own", () => {
		const text = renderPanel({
			transcriptionStatus: "PROCESSING",
			aiGenerationStatus: null,
			aiQuotaWaiting: true,
		});
		expect(text).toContain("aiQuotaQueueWaiting");
	});

	it("a normal run does NOT claim to be waiting", () => {
		const text = renderPanel({
			transcriptionStatus: "PROCESSING",
			aiGenerationStatus: null,
		});
		expect(text).not.toContain("aiQuotaQueueWaiting");
	});
});

describe("honest AI status — S5 generation-stage death reasons", () => {
	it("QUOTA: summary died on the provider balance — top-up + retry sentence", () => {
		const text = renderPanel({
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: "ERROR",
			aiGenerationErrorCode: "QUOTA",
		});
		expect(text).toContain("aiSummaryQuotaFailed");
		expect(text).not.toContain("aiAnalysisFailed");
	});

	it("QUOTA + public viewer: the neutral summary-unavailable line — never the transcription-quota text (whose transcript-is-missing / auto-retry claims would both be lies here)", () => {
		const text = renderPanel({
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: "ERROR",
			aiGenerationErrorCode: "QUOTA",
			canGenerate: false,
		});
		expect(text).toContain("aiSummaryUnavailablePublic");
		expect(text).not.toContain("aiTranscriptionQuotaFailedPublic");
		expect(text).not.toContain("aiAnalysisFailed");
	});

	it("OTHER: keeps the pre-existing generic text (unchanged behaviour)", () => {
		const text = renderPanel({
			transcriptionStatus: "COMPLETE",
			aiGenerationStatus: "ERROR",
			aiGenerationErrorCode: "OTHER",
		});
		expect(text).toContain("aiAnalysisFailed");
	});

	it("the classifier: BUDGET vs QUOTA vs OTHER, no second quota copy", () => {
		expect(classifyAiGenerationError("AI budget exceeded")).toBe("BUDGET");
		expect(
			classifyAiGenerationError(
				'OpenRouter completion failed (HTTP 402): {"error":{"message":"This request requires at least $0.50 in balance for audio"}}',
			),
		).toBe("QUOTA");
		expect(classifyAiGenerationError("429 RESOURCE_EXHAUSTED: quota")).toBe(
			"QUOTA",
		);
		expect(classifyAiGenerationError("Invalid audio format")).toBe("OTHER");
		expect(classifyAiGenerationError(null)).toBe("OTHER");
	});
});

// ─── Route: budget refusal is 402 with a machine code, not 500 raw English ───

const currentUser = vi.hoisted(() => ({
	value: { id: "user-1" } as { id: string; isAdmin?: boolean },
}));
const videoRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const updateWhereMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const updateSetMock = vi.hoisted(() =>
	vi.fn(() => ({ where: updateWhereMock })),
);
const transcribeVideoMock = vi.hoisted(() => vi.fn());
const startAiGenerationMock = vi.hoisted(() => vi.fn());

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(() => currentUser.value),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve(videoRows.value)),
				})),
			})),
		})),
		update: vi.fn(() => ({ set: updateSetMock })),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id" },
	organizations: { id: "organizations.id", ownerId: "organizations.ownerId" },
	organizationMembers: {
		organizationId: "organizationMembers.organizationId",
		userId: "organizationMembers.userId",
		role: "organizationMembers.role",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));
vi.mock("@cap/web-domain", () => ({ Video: {} }));
vi.mock("@/lib/permissions/roles", () => ({
	getEffectiveOrganizationRole: vi.fn(() => "admin"),
}));
vi.mock("@/lib/ai-cost-guard", () => ({
	currentBillingMonth: () => "2026-09",
	getAiBudgetCapsMicros: vi.fn(async () => ({
		budgetCapUserMicros: null,
		budgetCapOrgMicros: 1_000_000, // $1 org cap
	})),
	getMonthlySpendMicros: vi.fn(async () => 1_402_000), // $1.402 spent
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: startAiGenerationMock,
}));

describe("POST /api/videos/[videoId]/generate — budget refusal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = { id: "user-1", isAdmin: true };
		updateSetMock.mockReturnValue({ where: updateWhereMock });
		updateWhereMock.mockResolvedValue(undefined);
	});

	it("answers HTTP 402 {code:'AI_BUDGET_EXCEEDED'} with the spent/cap numbers", async () => {
		// Fresh video, nothing run yet: the POST falls through to transcribeVideo,
		// which refuses on the monthly cap.
		videoRows.value = [
			{
				id: "video-1",
				ownerId: "user-1",
				orgId: "org-1",
				transcriptionStatus: null,
				metadata: {},
			},
		];
		transcribeVideoMock.mockResolvedValue({
			success: false,
			message: "AI budget exceeded",
		});

		const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
		const response = await POST(new Request("http://localhost") as NextRequest, {
			params: Promise.resolve({ videoId: "video-1" }),
		});
		const body = await response.json();

		expect(response.status).toBe(402);
		expect(body.code).toBe("AI_BUDGET_EXCEEDED");
		expect(body.spentUsd).toBeCloseTo(1.402, 3);
		expect(body.capUsd).toBe(1);
	});

	it("a non-budget failure stays HTTP 500 with the raw message (unchanged)", async () => {
		videoRows.value = [
			{
				id: "video-2",
				ownerId: "user-1",
				orgId: "org-1",
				transcriptionStatus: null,
				metadata: {},
			},
		];
		transcribeVideoMock.mockResolvedValue({
			success: false,
			message: "No usable AI key configured",
		});

		const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
		const response = await POST(new Request("http://localhost") as NextRequest, {
			params: Promise.resolve({ videoId: "video-2" }),
		});

		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body.code).toBeUndefined();
	});
});
