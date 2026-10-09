// @vitest-environment jsdom
//
// Real incident: a 1.22 GB upload moved ~128 KB/s (true finish ~2h40m away)
// while the card showed only "Uploading" and a 16px ring — indistinguishable
// from frozen. The owner deleted and re-uploaded the same file 5 seconds
// later. This pins the number that would have told him: speed + time
// remaining, computed from a short rolling window (never the whole-upload
// average, which a slow start would poison for hours), and formatters that
// never show a placeholder or a guess when the window can't tell yet.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
	computeBytesPerSecond,
	computeSecondsRemaining,
	type ProgressSample,
} from "@/app/(org)/dashboard/import/file/useImportUpload";

// useImportUpload.ts pulls in server actions (and transitively "server-only")
// at module top-level. Mocked the same way as
// upload-cap-button-fast-path.test.ts so importing its pure functions here
// doesn't drag a server-only module into this jsdom test.
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: false },
}));
vi.mock("@cap/web-domain", () => ({
	Folder: { FolderId: { make: (value: string) => value } },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => ({
		user: { id: "user_1", isPro: true },
		activeOrganization: { organization: { id: "org_1" } },
	}),
}));
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));
vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: vi.fn(),
}));
vi.mock("@/actions/video/cancel-upload", () => ({
	cancelUpload: vi.fn(),
}));
vi.mock("@/actions/video/mark-upload-failed", () => ({
	markUploadFailed: vi.fn(),
}));
vi.mock("@/actions/video/trigger-processing", () => ({
	triggerVideoProcessing: vi.fn(),
	isVideoDeleted: vi.fn(async () => false),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	saveVideoEdits: vi.fn(),
}));
vi.mock("@/utils/multipart-upload", () => ({
	CancelledUploadError: class CancelledUploadError extends Error {},
	MULTIPART_UPLOAD_THRESHOLD_BYTES: 50 * 1024 * 1024,
	MultipartCompletionUncertainError: class MultipartCompletionUncertainError extends Error {},
	uploadBlobMultipart: vi.fn(),
}));
vi.mock("@/utils/upload-target", () => ({
	uploadWithTarget: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string, values?: Record<string, unknown>) => {
		if (!values) return key;
		return `${key}:${JSON.stringify(values)}`;
	},
}));

vi.mock("@cap/ui", () => ({
	LogoSpinner: () => null,
	// ConfirmationDialog (the upload-cancel confirm, 2026-09-11) pulls these;
	// passthroughs are enough - these tests never open the dialog.
	Button: ({ children }: { children?: unknown }) => children ?? null,
	Dialog: ({ children }: { children?: unknown }) => children ?? null,
	DialogContent: ({ children }: { children?: unknown }) => children ?? null,
	DialogFooter: ({ children }: { children?: unknown }) => children ?? null,
	DialogHeader: ({ children }: { children?: unknown }) => children ?? null,
	DialogTitle: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock("@cap/utils", () => ({
	getProgressCircleConfig: () => ({ circumference: 50.27 }),
	calculateStrokeDashoffset: (percent: number, circumference: number) =>
		circumference - (percent / 100) * circumference,
}));

const { uploadStatusRef } = vi.hoisted(() => ({
	uploadStatusRef: { current: undefined as unknown },
}));

vi.mock("@/app/(org)/dashboard/caps/UploadingContext", async () => {
	const { Store } = await import("@tanstack/store");
	return {
		useUploadingContext: () => ({
			// Fresh Store per call, seeded from whatever the test set right
			// before rendering — static-markup rendering never re-renders, so
			// this snapshot-at-call-time is all it needs.
			uploadingStore: new Store({ uploadStatus: uploadStatusRef.current }),
			setUploadStatus: () => {},
			setCancelHandler: () => {},
		}),
	};
});

describe("computeBytesPerSecond (rolling window)", () => {
	it("yields the window's rate for a rising byte series", () => {
		const samples: ProgressSample[] = [
			{ time: 0, loaded: 0 },
			{ time: 2000, loaded: 2_000_000 },
			{ time: 4000, loaded: 4_000_000 },
			{ time: 6000, loaded: 6_000_000 },
		];
		// Full span 0->6000ms, 0->6,000,000 bytes = 1,000,000 B/s.
		expect(computeBytesPerSecond(samples, 8000)).toBeCloseTo(1_000_000, 0);
	});

	it("does not let a long-past slow sample drag down the window's rate", () => {
		const samples: ProgressSample[] = [
			// Slow start, far outside an 8s window from the latest sample.
			{ time: 0, loaded: 0 },
			{ time: 1000, loaded: 1_000 },
			// Then fast, all within the last 8s.
			{ time: 100_000, loaded: 50_000_000 },
			{ time: 104_000, loaded: 54_000_000 },
			{ time: 108_000, loaded: 58_000_000 },
		];
		const speed = computeBytesPerSecond(samples, 8000);
		// Windowed: 100_000->108_000ms, 50,000,000->58,000,000 bytes = 1,000,000 B/s.
		// The whole-series average would be roughly 58M / 108s =~ 537k B/s — much lower.
		expect(speed).toBeCloseTo(1_000_000, 0);
	});

	it("returns undefined for fewer than 2 samples", () => {
		expect(computeBytesPerSecond([])).toBeUndefined();
		expect(computeBytesPerSecond([{ time: 0, loaded: 0 }])).toBeUndefined();
	});

	it("returns undefined instead of Infinity when elapsed time is zero", () => {
		const samples: ProgressSample[] = [
			{ time: 5000, loaded: 1_000 },
			{ time: 5000, loaded: 2_000 },
		];
		const speed = computeBytesPerSecond(samples, 8000);
		expect(speed).toBeUndefined();
		expect(speed).not.toBe(Infinity);
	});
});

describe("computeSecondsRemaining", () => {
	it("returns undefined, not Infinity or NaN, when speed is unknown", () => {
		expect(computeSecondsRemaining(0, 100, undefined)).toBeUndefined();
		expect(computeSecondsRemaining(0, 100, 0)).toBeUndefined();
	});

	it("divides remaining bytes by speed", () => {
		expect(computeSecondsRemaining(0, 1000, 100)).toBe(10);
	});
});

describe("formatBytes boundaries", async () => {
	const { formatBytes } = await import(
		"@/app/(org)/dashboard/caps/components/UploadPlaceholderCard"
	);

	it("stays in MB just below 1024 MB", () => {
		expect(formatBytes(1023 * 1024 * 1024)).toBe("1023 MB");
	});

	it("switches to GB (one decimal) at 1.0 GB", () => {
		expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
	});
});

describe("getRemainingTimeParts boundaries", async () => {
	const { getRemainingTimeParts } = await import(
		"@/app/(org)/dashboard/caps/components/UploadPlaceholderCard"
	);

	it("59s is less than a minute", () => {
		expect(getRemainingTimeParts(59)).toEqual({ kind: "lessThanMinute" });
	});

	it("61s is minutes-only", () => {
		expect(getRemainingTimeParts(61)).toEqual({ kind: "minutes", minutes: 1 });
	});

	it("3601s is hours+minutes", () => {
		expect(getRemainingTimeParts(3601)).toEqual({
			kind: "hoursMinutes",
			hours: 1,
			minutes: 0,
		});
	});

	it("7h is capped rather than a silly number", () => {
		expect(getRemainingTimeParts(7 * 3600)).toEqual({ kind: "capped" });
	});
});

describe("UploadPlaceholderCard rendering", async () => {
	const { UploadPlaceholderCard } = await import(
		"@/app/(org)/dashboard/caps/components/UploadPlaceholderCard"
	);

	function renderWithStatus(uploadStatus: unknown) {
		uploadStatusRef.current = uploadStatus;
		return renderToStaticMarkup(createElement(UploadPlaceholderCard));
	}

	it("renders MB and remaining-time text when both are present", () => {
		const html = renderWithStatus({
			status: "uploadingVideo",
			capId: "cap_1",
			progress: 47,
			thumbnailUrl: undefined,
			loadedBytes: 520 * 1024 * 1024,
			totalBytes: Math.round(1.22 * 1024 * 1024 * 1024),
			bytesPerSecond: 5_000_000,
			secondsRemaining: 130 * 60,
		});
		expect(html).toContain("520 MB");
		expect(html).toContain("1.2 GB");
		expect(html).toContain("uploadTimeRemainingHoursMinutes");
	});

	it("renders neither line when byte counts are undefined", () => {
		const html = renderWithStatus({
			status: "parsing",
		});
		expect(html).not.toContain("MB");
		expect(html).not.toContain("GB");
		expect(html).not.toContain("uploadTimeRemaining");
	});
});
