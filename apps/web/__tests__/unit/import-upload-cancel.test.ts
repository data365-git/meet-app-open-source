// @vitest-environment jsdom
//
// Review fix 2026-09-25: a cancel must stay a cancel even when the request
// in flight carries no abort signal. initiateMultipartUpload is a plain fetch,
// so a Cancel pressed during it lets that fetch fail with "Failed to fetch"
// instead of CancelledUploadError - which used to surface as "Failed to upload
// video" and leave an 'error' row via markUploadFailed.
//
// Harness mirrors upload-cap-button-fast-path.test.ts.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
	cancelHandler: undefined as (() => void) | undefined,
	cancelUpload: vi.fn(async () => ({ ok: true })),
	markUploadFailed: vi.fn(async () => {}),
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: false },
}));
vi.mock("@cap/web-domain", () => ({
	Folder: { FolderId: { make: (value: string) => value } },
}));
vi.mock("@cap/ui", () => ({
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children?: unknown;
		onClick?: () => void;
		disabled?: boolean;
	}) =>
		createElement(
			"button",
			{ onClick, disabled, type: "button" },
			children as never,
		),
}));
vi.mock("@/components/UpgradeModal", () => ({
	UpgradeModal: () => null,
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
vi.mock("@/app/(org)/dashboard/caps/UploadingContext", async () => {
	const { Store } = await import("@tanstack/store");
	const store = new Store<{ uploadStatus?: unknown }>({});
	return {
		useUploadingContext: () => ({
			uploadingStore: store,
			setUploadStatus: (status: unknown) => {
				store.setState((s) => ({ ...s, uploadStatus: status }));
			},
			setCancelHandler: (handler: (() => void) | undefined) => {
				mocks.cancelHandler = handler;
			},
		}),
	};
});
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));
vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: vi.fn(async () => ({
		id: "vid_new",
		uploadTarget: { url: "https://example.test/put", method: "PUT" as const },
		rawFileKey: "raw-key",
		bucketId: "bucket_1",
	})),
}));
vi.mock("@/actions/video/cancel-upload", () => ({
	cancelUpload: mocks.cancelUpload,
}));
vi.mock("@/actions/video/mark-upload-failed", () => ({
	markUploadFailed: mocks.markUploadFailed,
}));
vi.mock("@/actions/video/trigger-processing", () => ({
	triggerVideoProcessing: vi.fn(async () => {}),
	isVideoDeleted: vi.fn(async () => false),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	saveVideoEdits: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/utils/multipart-upload", () => ({
	CancelledUploadError: class CancelledUploadError extends Error {},
	// Every file goes multipart, the path whose initiate carries no signal.
	MULTIPART_UPLOAD_THRESHOLD_BYTES: 0,
	MultipartCompletionUncertainError: class MultipartCompletionUncertainError extends Error {},
	// The user presses Cancel while initiate is in flight; initiate then fails
	// as a plain network error, not as CancelledUploadError.
	uploadBlobMultipart: vi.fn(async () => {
		mocks.cancelHandler?.();
		throw new TypeError("Failed to fetch");
	}),
}));
vi.mock("@/utils/upload-target", () => ({
	uploadWithTarget: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({
	toast: mocks.toast,
}));

import { UploadCapButton } from "@/app/(org)/dashboard/caps/components/UploadCapButton";

async function renderAndPickFile() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(createElement(UploadCapButton, { size: "sm" }));
	});
	act(() => {
		container
			.querySelector("button")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	const input = container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement;
	const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	});
	act(() => root.unmount());
	container.remove();
}

describe("import upload — cancel during a request with no abort signal", () => {
	it("treats a 'Failed to fetch' after Cancel as the cancel: erases, no error toast, no 'error' row", async () => {
		await renderAndPickFile();

		expect(mocks.cancelUpload).toHaveBeenCalledWith("vid_new");
		expect(mocks.markUploadFailed).not.toHaveBeenCalled();
		expect(mocks.toast.error).not.toHaveBeenCalled();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadCancelled");
	});
});
