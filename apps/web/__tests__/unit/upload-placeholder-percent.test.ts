// @vitest-environment jsdom
//
// Pins the qa-fixes change to UploadPlaceholderCard: a determinate progress
// (converting/uploadingThumbnail/uploadingVideo) now prints the rounded
// percent next to the status word instead of only moving a 16px ring nobody
// could see change; a status with no progress (parsing/creating/
// serverProcessing) renders an indeterminate spinner instead of a
// determinate ring frozen at 0 (which looked identical to a hung upload).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("@cap/ui", () => ({
	LogoSpinner: ({ className }: { className?: string }) =>
		createElement("div", { className, "data-testid": "logo-spinner" }),
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
	getProgressCircleConfig: () => ({ circumference: 50.26 }),
	calculateStrokeDashoffset: (percent: number, circumference: number) =>
		circumference - (percent / 100) * circumference,
}));

vi.mock("../../app/(org)/dashboard/caps/UploadingContext", async () => {
	const { Store } = await import("@tanstack/store");
	const uploadingStore = new Store<{ uploadStatus?: any }>({
		uploadStatus: undefined,
	});
	const setUploadStatus = (state: any) => {
		uploadingStore.setState(() => ({ uploadStatus: state }));
	};
	return {
		useUploadingContext: () => ({ uploadingStore, setUploadStatus }),
		__uploadingStore: uploadingStore,
		__setUploadStatus: setUploadStatus,
	};
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
	if (root) {
		act(() => {
			root?.unmount();
		});
	}
	if (container) container.remove();
	container = null;
	root = null;
	vi.resetModules();
});

async function renderWithStatus(status: any) {
	const { UploadPlaceholderCard } = await import(
		"../../app/(org)/dashboard/caps/components/UploadPlaceholderCard"
	);
	const ctx = (await import(
		"../../app/(org)/dashboard/caps/UploadingContext"
	)) as any;
	act(() => {
		ctx.__setUploadStatus(status);
	});

	if (root) {
		act(() => {
			root?.unmount();
		});
	}
	if (container) container.remove();

	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(createElement(UploadPlaceholderCard));
	});
	return container;
}

describe("UploadPlaceholderCard percent display", () => {
	it("shows the rounded percent for uploadingVideo", async () => {
		const el = await renderWithStatus({
			status: "uploadingVideo",
			capId: "cap_1",
			progress: 47.4,
			thumbnailUrl: undefined,
		});
		expect(el.textContent).toContain("Uploading 47%");
	});

	it("shows the rounded percent for converting and uploadingThumbnail", async () => {
		const el1 = await renderWithStatus({
			status: "converting",
			capId: "cap_1",
			progress: 8,
		});
		expect(el1.textContent).toContain("Converting 8%");

		const el2 = await renderWithStatus({
			status: "uploadingThumbnail",
			capId: "cap_1",
			progress: 96,
		});
		expect(el2.textContent).toContain("Uploading 96%");
	});

	it("renders the determinate ring (not the indeterminate spinner) when a real percentage exists", async () => {
		const el = await renderWithStatus({
			status: "converting",
			capId: "cap_1",
			progress: 50,
		});
		expect(el.querySelector("svg.animate-spin")).toBeNull();
		expect(el.querySelector("svg")).not.toBeNull();
	});

	it("shows an indeterminate spinner with no percent for serverProcessing", async () => {
		const el = await renderWithStatus({
			status: "serverProcessing",
			capId: "cap_1",
		});
		expect(el.textContent).toContain("Processing...");
		expect(el.textContent).not.toContain("%");
		expect(el.querySelector("svg.animate-spin")).not.toBeNull();
	});

	it("shows an indeterminate spinner with no percent for parsing and creating", async () => {
		const el1 = await renderWithStatus({ status: "parsing" });
		expect(el1.textContent).not.toContain("%");
		expect(el1.querySelector("svg.animate-spin")).not.toBeNull();

		const el2 = await renderWithStatus({ status: "creating" });
		expect(el2.textContent).not.toContain("%");
		expect(el2.querySelector("svg.animate-spin")).not.toBeNull();
	});
});
