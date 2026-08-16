// @vitest-environment jsdom
//
// Pins for the two upload-flow defects fixed together on qa-fixes:
//   Task 1 - an upload started from inside a folder must land IN that folder,
//            not root.
//   Task 2 - pressing "Upload" must open the OS file picker immediately and
//            start the upload as soon as a file is chosen (no intermediate
//            /dashboard/import screen, no PreUploadTrimmer step).
//
// The two must work TOGETHER: this test proves the fast path (Task 2) still
// carries folderId (Task 1) all the way to createVideoForServerProcessing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createVideoMock, routerPushMock } = vi.hoisted(() => ({
	createVideoMock: vi.fn(async (_args: { folderId?: string }) => ({
		id: "vid_new",
		uploadTarget: { url: "https://example.test/put", method: "PUT" as const },
		rawFileKey: "raw-key",
		bucketId: "bucket_1",
	})),
	routerPushMock: vi.fn(),
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
	useRouter: () => ({ push: routerPushMock }),
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
		}),
	};
});

vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));

vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: createVideoMock,
}));
vi.mock("@/actions/video/mark-upload-failed", () => ({
	markUploadFailed: vi.fn(async () => {}),
}));
vi.mock("@/actions/video/trigger-processing", () => ({
	triggerVideoProcessing: vi.fn(async () => {}),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	saveVideoEdits: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/utils/multipart-upload", () => ({
	MULTIPART_UPLOAD_THRESHOLD_BYTES: 50 * 1024 * 1024,
	MultipartCompletionUncertainError: class MultipartCompletionUncertainError extends Error {},
	uploadBlobMultipart: vi.fn(async () => ({ processingStarted: true })),
}));
vi.mock("@/utils/upload-target", () => ({
	uploadWithTarget: vi.fn(
		async ({ onProgress }: { onProgress?: (p: unknown) => void }) => {
			onProgress?.({ loaded: 1, total: 1 });
		},
	),
}));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { UploadCapButton } from "@/app/(org)/dashboard/caps/components/UploadCapButton";

function makeFile() {
	return new File(["x"], "clip.mp4", { type: "video/mp4" });
}

async function renderAndPickFile(folderId?: string) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(createElement(UploadCapButton, { size: "sm", folderId }));
	});

	const button = container.querySelector("button");
	expect(button).not.toBeNull();
	act(() => {
		button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});

	const input = container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement;
	expect(input).not.toBeNull();

	const file = makeFile();
	Object.defineProperty(input, "files", { value: [file], configurable: true });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
		// Let the async processFile() chain (parseMedia -> createVideo -> upload)
		// settle before assertions.
		await new Promise((r) => setTimeout(r, 0));
		await new Promise((r) => setTimeout(r, 0));
	});

	act(() => root.unmount());
	container.remove();
}

afterEach(() => {
	createVideoMock.mockClear();
	routerPushMock.mockClear();
});

describe("UploadCapButton one-click upload (folder-aware)", () => {
	it("uploads straight into the folder the user is looking at (Task 1 x Task 2)", async () => {
		await renderAndPickFile("fld_target");

		expect(createVideoMock).toHaveBeenCalledTimes(1);
		const call = createVideoMock.mock.calls[0]?.[0] as
			| { folderId?: unknown }
			| undefined;
		expect(call?.folderId).toBe("fld_target");
	});

	it("never navigates to the intermediate /dashboard/import screen (Task 2: one click)", async () => {
		await renderAndPickFile("fld_target");

		expect(routerPushMock).not.toHaveBeenCalled();
	});

	it("uploads to root when opened outside a folder (no folderId)", async () => {
		await renderAndPickFile(undefined);

		expect(createVideoMock).toHaveBeenCalledTimes(1);
		const call = createVideoMock.mock.calls[0]?.[0] as
			| { folderId?: unknown }
			| undefined;
		expect(call?.folderId).toBeUndefined();
	});
});
