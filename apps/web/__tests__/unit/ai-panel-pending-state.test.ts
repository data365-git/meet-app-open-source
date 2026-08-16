// @vitest-environment jsdom
import type { Video } from "@cap/web-domain";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

// Stub only the boundaries the panel does not own: translations (returns the
// key, so assertions read like the UI contract) and the design-system dropdown.
vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
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
import { buildAiStatusFacts } from "@/lib/ai-request-pending";
import {
	AiStatusRequestError,
	isAiStatusTerminal,
	MAX_TRANSIENT_AI_STATUS_FAILURES,
	nextAiStatusPollInterval,
} from "../../hooks/use-ai-status";

const VIDEO_ID = "vid_1" as Video.VideoId;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

/**
 * Renders the REAL panel with the props ShareVideo would hand it for a given
 * `/api/video/ai` poll body — the same shaping function the route uses, so the
 * poll payload (not a hand-written prop) is what drives the assertion.
 */
function renderForPollBody(body: {
	transcriptionStatus?: string | null;
	metadata?: Record<string, unknown>;
	canGenerate?: boolean;
}) {
	const facts = buildAiStatusFacts({
		transcriptionStatus: body.transcriptionStatus ?? null,
		metadata: (body.metadata ?? {}) as never,
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(GenerateAiPanel, {
				videoId: VIDEO_ID,
				canGenerate: body.canGenerate ?? true,
				transcriptionStatus: facts.transcriptionStatus,
				aiGenerationStatus: facts.aiGenerationStatus,
				aiRequestPending: facts.aiRequestPending,
				duration: 600,
			}),
		);
	});
	const text = container.textContent ?? "";
	act(() => root.unmount());
	container.remove();
	return { text, facts };
}

describe("share panel state for a pending AI request", () => {
	// NOTE on what these assert: the queued block deliberately CARRIES a start
	// button, so that a marker no redeemer ever takes cannot strand the owner on
	// a screen with no action. The thing that must never happen is the panel
	// looking untouched — i.e. the plain "not run yet" screen — after a press
	// that WAS recorded. So the discriminator is aiQueuedTitle vs aiNotRunYet,
	// not the presence of the button.
	it("shows the QUEUED state for a banked press, not the untouched start screen", () => {
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: {
				aiStartPendingUpload: "2026-08-16T09:00:00.000Z",
				aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z",
			},
		});
		expect(facts.aiRequestPending).toBe(true);
		expect(text).toContain("aiQueuedTitle");
		expect(text).not.toContain("aiNotRunYet");
	});

	it("treats the one-shot banked marker alone as pending", () => {
		// The durable aiGenerationRequestedAt is deliberately absent here so the
		// banked marker itself is what holds the state.
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: { aiStartPendingUpload: "2026-08-16T09:00:00.000Z" },
		});
		expect(facts.aiRequestPending).toBe(true);
		expect(text).toContain("aiQueuedTitle");
		expect(text).not.toContain("aiNotRunYet");
	});

	it("keeps the pending state across repeated polls while the banked marker stands", () => {
		// The poll that used to destroy the optimistic state: row still NULL.
		for (let poll = 0; poll < 3; poll++) {
			const { text } = renderForPollBody({
				transcriptionStatus: null,
				metadata: { aiStartPendingUpload: "2026-08-16T09:00:00.000Z" },
			});
			expect(text).toContain("aiQueuedTitle");
			expect(text).not.toContain("aiNotRunYet");
		}
	});

	it("NEVER claims 'queued' from aiGenerationRequestedAt alone — no redeemer reads it", () => {
		// This is the trap the first version shipped: nothing ever clears that
		// field and neither redeemer (the recover-stale-ai-jobs cron nor
		// ai-generation-request.ts) keys on it, so an unclaimed row — e.g. one an
		// operator reset to NULL — would render "queued" forever with no button.
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
		});
		expect(facts.aiRequestPending).toBe(false);
		expect(text).not.toContain("aiQueuedTitle");
		expect(text).toContain("aiStartAnalysis");
	});

	it("never shows a public share-link viewer a request they did not make", () => {
		// The panel renders for every visitor; only someone who can start the job
		// may be told one is queued (it also leaks that the owner started it).
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: { aiStartPendingUpload: "2026-08-16T09:00:00.000Z" },
			canGenerate: false,
		});
		expect(facts.aiRequestPending).toBe(true);
		expect(text).not.toContain("aiQueuedTitle");
		expect(text).toContain("aiNotAvailable");
	});

	it("shows the running panel once the workflow claims the row", () => {
		const { text, facts } = renderForPollBody({
			transcriptionStatus: "PROCESSING",
			metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
		});
		// Claimed → no longer "pending", but running, so still not the button.
		expect(facts.aiRequestPending).toBe(false);
		expect(text).not.toContain("aiStartAnalysis");
		expect(text).toContain("aiAnalysisRunning");
	});

	it("still returns the retry button when the job genuinely fails", () => {
		const { text, facts } = renderForPollBody({
			transcriptionStatus: "ERROR",
			metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
		});
		expect(facts.aiRequestPending).toBe(false);
		expect(text).toContain("aiRetry");
	});

	it("does not pin the panel to pending once the transcript is done", () => {
		// aiGenerationRequestedAt is never cleared server-side, so it must stop
		// counting the moment the row is claimed — otherwise the owner could
		// never start (or retry) analysis on this video again.
		const { facts } = renderForPollBody({
			transcriptionStatus: "COMPLETE",
			metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
		});
		expect(facts.aiRequestPending).toBe(false);
	});
});

describe("poll stop condition", () => {
	it("does not treat old content as terminal while a new run is in flight", () => {
		expect(
			isAiStatusTerminal({ hasContent: true, aiGenerationStatus: "PROCESSING" }),
		).toBe(false);
		expect(
			isAiStatusTerminal({ hasContent: true, aiGenerationStatus: "QUEUED" }),
		).toBe(false);
	});

	it("STOPS polling only when the request can NEVER succeed", () => {
		// 401/403 for a share-link viewer, 404 for a deleted video: this caller
		// will never get an answer, and an interval keyed only on `data` kept
		// firing every 4s for as long as the tab stayed open.
		for (const status of [401, 403, 404]) {
			expect(
				nextAiStatusPollInterval(
					{ status: "error", error: new AiStatusRequestError(status) },
					4000,
				),
			).toBe(false);
		}
		// Still-loading is not an error: the first tick must still be scheduled.
		expect(nextAiStatusPollInterval({ status: "pending" }, 4000)).toBe(4000);
	});

	it("SURVIVES a transient failure instead of freezing the panel", () => {
		// The mirror defect: `retry: 2` retires a query in ~2 seconds and nothing
		// re-arms it without a button press, so treating every error as fatal
		// froze the panel on "AI analysis running" after one 502 mid-transcription
		// — recoverable only by the page reload this feature exists to remove.
		for (const status of [500, 502, 503, 504]) {
			expect(
				nextAiStatusPollInterval(
					{ status: "error", error: new AiStatusRequestError(status) },
					4000,
				),
			).toBe(4000);
		}
	});

	it("BACKS OFF and finally gives up on a route that keeps failing", () => {
		// Surviving a blip must not mean hammering a broken endpoint: 3 requests
		// every 4s from every open tab amplifies load exactly during an outage.
		const at = (failureCount: number) =>
			nextAiStatusPollInterval(
				{
					status: "error",
					error: new AiStatusRequestError(500),
					failureCount,
				},
				4000,
			);
		expect(at(1)).toBe(8000);
		expect(at(2)).toBe(16000);
		expect(at(4)).toBe(60000); // capped, never longer than a minute
		expect(at(MAX_TRANSIENT_AI_STATUS_FAILURES)).toBe(false);
		expect(at(MAX_TRANSIENT_AI_STATUS_FAILURES + 5)).toBe(false);
		// A dropped connection throws a plain Error, not ours — also transient.
		expect(
			nextAiStatusPollInterval(
				{ status: "error", error: new TypeError("Failed to fetch") },
				4000,
			),
		).toBe(4000);
	});

	it("keeps polling a live run and stops on a terminal body", () => {
		const running = {
			processing: true,
			aiGenerationStatus: "PROCESSING",
			hasContent: false,
		} as never;
		const done = {
			processing: false,
			aiGenerationStatus: "COMPLETE",
			hasContent: true,
		} as never;
		expect(
			nextAiStatusPollInterval({ status: "success", data: running }, 4000),
		).toBe(4000);
		expect(
			nextAiStatusPollInterval({ status: "success", data: done }, 4000),
		).toBe(false);
	});

	it("still stops on real terminal states", () => {
		expect(
			isAiStatusTerminal({ hasContent: true, aiGenerationStatus: null }),
		).toBe(true);
		expect(
			isAiStatusTerminal({ hasContent: false, aiGenerationStatus: "ERROR" }),
		).toBe(true);
		expect(
			isAiStatusTerminal({ hasContent: false, aiGenerationStatus: "COMPLETE" }),
		).toBe(true);
	});
});
