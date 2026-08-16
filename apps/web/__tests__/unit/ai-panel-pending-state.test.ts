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
import { isAiStatusTerminal } from "../../hooks/use-ai-status";

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
				canGenerate: true,
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
	it("does NOT show the start button for a banked press (upload still processing)", () => {
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: {
				aiStartPendingUpload: "2026-08-16T09:00:00.000Z",
				aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z",
			},
		});
		expect(facts.aiRequestPending).toBe(true);
		expect(text).not.toContain("aiStartAnalysis");
		expect(text).toContain("aiQueuedTitle");
	});

	it("treats the one-shot banked marker alone as pending", () => {
		// The durable aiGenerationRequestedAt is deliberately absent here so the
		// banked marker itself is what holds the state.
		const { text, facts } = renderForPollBody({
			transcriptionStatus: null,
			metadata: { aiStartPendingUpload: "2026-08-16T09:00:00.000Z" },
		});
		expect(facts.aiRequestPending).toBe(true);
		expect(text).not.toContain("aiStartAnalysis");
	});

	it("keeps the pending state across repeated polls that still report nothing started", () => {
		// The poll that used to destroy the optimistic state: row still NULL.
		for (let poll = 0; poll < 3; poll++) {
			const { text } = renderForPollBody({
				transcriptionStatus: null,
				metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
			});
			expect(text).not.toContain("aiStartAnalysis");
			expect(text).toContain("aiQueuedTitle");
		}
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
