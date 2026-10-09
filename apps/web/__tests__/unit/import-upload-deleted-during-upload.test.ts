// @vitest-environment jsdom
//
// 2026-10-09: the owner removed a card in the same second its multipart
// upload completed and still got "Video uploaded!" for a video in Trash.
// The uploader now asks the server for a POSITIVE "deleted" answer
// (isVideoDeleted) after the upload and, only on true, shows the cancelled
// message and skips the post-upload trim. Any error / false / missing action
// must behave exactly as before (a healthy upload is never "cancelled").
//
// Harness mirrors import-upload-cancel.test.ts, but drives processFile directly
// so the serverTrim argument can be passed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
	isVideoDeleted: vi.fn<(id: string) => Promise<boolean>>(async () => false),
	triggerVideoProcessing: vi.fn(async (_: unknown) => ({ success: true })),
	uploadBlobMultipart: vi.fn(async (..._args: unknown[]) => ({
		processingStarted: true,
	})),
	saveVideoEdits: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
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
			setCancelHandler: () => {},
			setQueueState: () => {},
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
	triggerVideoProcessing: mocks.triggerVideoProcessing,
	isVideoDeleted: mocks.isVideoDeleted,
}));
vi.mock("@/actions/videos/save-edits", () => ({
	saveVideoEdits: mocks.saveVideoEdits,
}));
vi.mock("@/utils/multipart-upload", () => ({
	CancelledUploadError: class CancelledUploadError extends Error {},
	MULTIPART_UPLOAD_THRESHOLD_BYTES: 1000,
	MultipartCompletionUncertainError: class MultipartCompletionUncertainError extends Error {},
	uploadBlobMultipart: mocks.uploadBlobMultipart,
}));
vi.mock("@/utils/upload-target", () => ({
	uploadWithTarget: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({
	toast: mocks.toast,
}));

import { useImportUpload } from "@/app/(org)/dashboard/import/file/useImportUpload";

type ProcessFile = ReturnType<typeof useImportUpload>["processFile"];

async function runUpload(file: File, withTrim = true): Promise<string | null> {
	let processFile: ProcessFile | undefined;
	const Harness = () => {
		processFile = useImportUpload().processFile;
		return null;
	};
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(createElement(Harness));
	});
	let result: string | null = null;
	await act(async () => {
		result = await processFile!(
			file,
			withTrim ? { inSec: 1, outSec: 5, duration: 10 } : undefined,
			{ skipStartCallback: true },
		);
		await new Promise((r) => setTimeout(r, 0));
	});
	act(() => root.unmount());
	container.remove();
	return result;
}

const multipartFile = () =>
	new File(["x".repeat(2000)], "big.mp4", { type: "video/mp4" });
const singleFile = () => new File(["x"], "small.mp4", { type: "video/mp4" });

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isVideoDeleted.mockImplementation(async () => false);
	mocks.triggerVideoProcessing.mockImplementation(async () => ({
		success: true,
	}));
	mocks.uploadBlobMultipart.mockImplementation(async () => ({
		processingStarted: true,
	}));
});

describe("import upload - card removed while the upload finishes", () => {
	it("multipart: deleted signal -> cancelled message, no success toast, no trim", async () => {
		mocks.isVideoDeleted.mockResolvedValue(true);
		const id = await runUpload(multipartFile());

		expect(id).toBeNull();
		expect(mocks.isVideoDeleted).toHaveBeenCalledWith("vid_new");
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadCancelled");
		expect(mocks.toast.success).not.toHaveBeenCalled();
		expect(mocks.saveVideoEdits).not.toHaveBeenCalled();
	});

	it("single-PUT: deleted signal -> cancelled message, no success toast, no trim", async () => {
		mocks.isVideoDeleted.mockResolvedValue(true);
		const id = await runUpload(singleFile());

		expect(id).toBeNull();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadCancelled");
		expect(mocks.toast.success).not.toHaveBeenCalled();
		expect(mocks.saveVideoEdits).not.toHaveBeenCalled();
	});

	it("single-PUT: trigger throws (message stripped in prod) but deleted signal is true -> cancelled, not 'failed to start'", async () => {
		mocks.triggerVideoProcessing.mockRejectedValue(new Error("generic"));
		mocks.isVideoDeleted.mockResolvedValue(true);
		const id = await runUpload(singleFile());

		expect(id).toBeNull();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadCancelled");
		expect(mocks.toast.error).not.toHaveBeenCalled();
	});

	it("false-positive guard: status call THROWS for a live video -> success as before", async () => {
		mocks.isVideoDeleted.mockRejectedValue(new Error("db down"));
		const id = await runUpload(multipartFile());

		expect(id).toBe("vid_new");
		expect(mocks.toast.success).toHaveBeenCalled();
		expect(mocks.toast.info).not.toHaveBeenCalledWith("uploadCancelled");
		expect(mocks.saveVideoEdits).toHaveBeenCalled();
	});

	it("false-positive guard: signal false -> success as before (single-PUT)", async () => {
		mocks.isVideoDeleted.mockResolvedValue(false);
		const id = await runUpload(singleFile());

		expect(id).toBe("vid_new");
		expect(mocks.toast.success).toHaveBeenCalled();
		expect(mocks.toast.info).not.toHaveBeenCalledWith("uploadCancelled");
	});

	it("false-positive guard: trigger throws and video is live -> the old 'failed to start' error", async () => {
		mocks.triggerVideoProcessing.mockRejectedValue(new Error("boom"));
		mocks.isVideoDeleted.mockResolvedValue(false);
		const id = await runUpload(singleFile());

		expect(id).toBeNull();
		expect(mocks.toast.error).toHaveBeenCalled();
		expect(mocks.toast.info).not.toHaveBeenCalledWith("uploadCancelled");
	});

	it("multipart: /complete rejects (404, row filtered) and video is deleted -> cancelled, no markUploadFailed, no error toast", async () => {
		mocks.uploadBlobMultipart.mockRejectedValue(new Error("404 Not Found"));
		mocks.isVideoDeleted.mockResolvedValue(true);
		const id = await runUpload(multipartFile());

		expect(id).toBeNull();
		expect(mocks.isVideoDeleted).toHaveBeenCalledWith("vid_new");
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadCancelled");
		expect(mocks.toast.error).not.toHaveBeenCalled();
		expect(mocks.markUploadFailed).not.toHaveBeenCalled();
		expect(mocks.saveVideoEdits).not.toHaveBeenCalled();
	});

	it("multipart guard: same rejection but video is live -> old error path (markUploadFailed + error toast)", async () => {
		mocks.uploadBlobMultipart.mockRejectedValue(new Error("404 Not Found"));
		mocks.isVideoDeleted.mockResolvedValue(false);
		const id = await runUpload(multipartFile());

		expect(id).toBeNull();
		expect(mocks.markUploadFailed).toHaveBeenCalledWith("vid_new");
		expect(mocks.toast.error).toHaveBeenCalled();
		expect(mocks.toast.info).not.toHaveBeenCalledWith("uploadCancelled");
	});
});
