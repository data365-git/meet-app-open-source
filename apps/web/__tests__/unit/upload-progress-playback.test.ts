import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	canRetryFailedProcessing,
	getStalledProcessingMessage,
	getUploadFailureMessage,
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
} from "@/app/s/[videoId]/_components/ProgressCircle";

describe("shouldDeferPlaybackSource", () => {
	it.each([
		{ status: "fetching" },
		{
			status: "uploading",
			lastUpdated: new Date(),
			progress: 10,
		},
	])("returns true for active upload state %#", (uploadProgress) => {
		expect(shouldDeferPlaybackSource(uploadProgress as never)).toBe(true);
	});

	it.each([
		null,
		{
			status: "processing",
			lastUpdated: new Date(),
			progress: 42,
			message: "Processing video...",
		},
		{
			status: "generating_thumbnail",
			lastUpdated: new Date(),
			progress: 90,
		},
		{
			status: "error",
			lastUpdated: new Date(),
			errorMessage: "Processing failed",
		},
		{
			status: "failed",
			lastUpdated: new Date(),
		},
	])("returns false for non-blocking state %#", (uploadProgress) => {
		expect(shouldDeferPlaybackSource(uploadProgress as never)).toBe(false);
	});

	it("allows retry only for owner-visible processing errors", () => {
		expect(
			canRetryFailedProcessing(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video processing timed out",
					hasRawFallback: false,
				},
				true,
			),
		).toBe(true);
		expect(
			canRetryFailedProcessing(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video processing timed out",
					hasRawFallback: false,
				},
				false,
			),
		).toBe(false);
		expect(
			canRetryFailedProcessing(
				{
					status: "failed",
					lastUpdated: new Date(),
				} as never,
				true,
			),
		).toBe(false);
	});

	it("uses upload-specific failure messaging", () => {
		const t = (key: string) => key;
		// Round-20: stored error text is an ops TOKEN, never viewer copy — a
		// legacy raw sentence (pre-allowlist rows) renders as the LOCALIZED
		// fallback, not verbatim untranslated English.
		expect(
			getUploadFailureMessage(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video uploaded, but processing could not start.",
					hasRawFallback: false,
				},
				true,
				t,
			),
		).toBe("progressProcessingFailed");
		// Known allowlist tokens get their own localized sentence.
		expect(
			getUploadFailureMessage(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Upload interrupted",
					hasRawFallback: false,
				},
				false,
				t,
			),
		).toBe("progressUploadInterrupted");
		expect(
			getUploadFailureMessage(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: null,
					hasRawFallback: false,
				},
				false,
				t,
			),
		).toBe("progressProcessingFailedOwner");
		expect(
			getUploadFailureMessage(
				{
					status: "failed",
					lastUpdated: new Date(),
				} as never,
				false,
				t,
			),
		).toBe("progressUploadStalled");
	});

	it("reloads playback when upload progress clears", () => {
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 80,
					message: "Finishing video...",
				},
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 90,
					message: "Still processing...",
				},
			),
		).toBe(false);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "fetching",
				},
				null,
			),
		).toBe(false);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "fetching",
				},
				null,
				{ includeFetching: true },
			),
		).toBe(true);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 80,
					message: "Finishing video...",
				},
				null,
			),
		).toBe(true);
		expect(shouldReloadPlaybackAfterUploadCompletes(null, null)).toBe(false);
	});

	it("detects processing that never actually started — and returns a KEY, not a translated sentence (round-21)", () => {
		// Threshold was deliberately raised 90s -> 5min (commit 3621e0f: 90s
		// flashed a false "processing failed" on merely-queued videos), so the
		// fixture must exceed 5 minutes.
		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 301_000),
				processingProgress: 0,
			}),
		).toBe("progressDidNotStart");

		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 30_000),
				processingProgress: 0,
			}),
		).toBeNull();
	});

	it("detects processing that stalled after starting", () => {
		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 11 * 60 * 1000),
				processingProgress: 25,
			}),
		).toBe("progressStalled");
	});

	it("RENDER-PATH pin (round-21): the stalled instruction survives to what the page shows, for the owner AND the anonymous viewer", () => {
		// This pin sits at the boundary the previous three misses sat below:
		// the stalled branch's value flowing THROUGH getUploadFailureMessage
		// with the REAL uz locale — not the helper asserted in isolation.
		const uzShare = (
			JSON.parse(
				readFileSync(
					fileURLToPath(new URL("../../messages/uz.json", import.meta.url)),
					"utf8",
				),
			) as { share: Record<string, string> }
		).share;
		const tUz = (key: string) => uzShare[key] ?? key;

		const stalledKey = getStalledProcessingMessage({
			phase: "processing",
			updatedAt: new Date(Date.now() - 301_000),
			processingProgress: 0,
		});
		expect(stalledKey).toBe("progressDidNotStart");

		const uploadProgress = {
			status: "error" as const,
			lastUpdated: new Date(),
			errorMessage: stalledKey,
			hasRawFallback: false,
		};
		// Owner (retry available) and anonymous viewer both get the localized
		// sentence WITH its instruction — never a bare "Processing failed."
		for (const canRetry of [true, false]) {
			const rendered = getUploadFailureMessage(uploadProgress, canRetry, tUz);
			expect(rendered).toBe(uzShare.progressDidNotStart);
			expect(rendered).toContain("Qayta ishlovni");
		}
	});
});
