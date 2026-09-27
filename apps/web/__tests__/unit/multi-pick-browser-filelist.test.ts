// @vitest-environment jsdom
//
// Must-fix #1 (blind review 2026-09-27): in a real browser, setting
// input.value = "" empties the LIVE FileList (length 2 -> 0). Both change
// handlers used to read the FileList AFTER the clear, so a real pick uploaded
// nothing ("0 tadan 0 tasi"). These tests give the fake input a `files` getter
// backed by an array that is emptied when `value` is set to "" - exactly like
// the browser - so the bug is visible (plain arrays, like the old tests
// injected, could never see it).
//
// Also pins must-fix #4 (a pick is refused while an upload or batch is
// running) and #5 (no per-file "Video uploaded!" toast inside a batch).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
	createVideo: vi.fn(async (_args: { fileName?: string }) => ({
		id: "vid_new",
		uploadTarget: { url: "https://example.test/put", method: "PUT" as const },
		rawFileKey: "raw-key",
		bucketId: "bucket_1",
	})),
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
	const store = new Store<Record<string, unknown>>({});
	return {
		useUploadingContext: () => ({
			uploadingStore: store,
			setUploadStatus: (status: unknown) => {
				store.setState((s) => ({ ...s, uploadStatus: status }));
			},
			setCancelHandler: (handler: (() => void) | undefined) => {
				store.setState((s) => ({ ...s, cancelHandler: handler }));
			},
			setQueueState: (partial: Record<string, unknown>) => {
				store.setState((s) => ({ ...s, ...partial }));
			},
			removeFromQueue: (id: string) => {
				store.setState((s) => ({
					...s,
					queue: ((s.queue as { id: string }[] | undefined) ?? []).filter(
						(entry) => entry.id !== id,
					),
				}));
			},
		}),
	};
});
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));
vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: mocks.createVideo,
}));
vi.mock("@/actions/video/cancel-upload", () => ({
	cancelUpload: vi.fn(async () => ({ ok: true })),
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
	CancelledUploadError: class CancelledUploadError extends Error {},
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
	toast: mocks.toast,
}));

import { UploadCapButton } from "@/app/(org)/dashboard/caps/components/UploadCapButton";
import { useUploadingContext } from "@/app/(org)/dashboard/caps/UploadingContext";
import { useImportUpload } from "@/app/(org)/dashboard/import/file/useImportUpload";

function makeFile(name: string) {
	return new File(["x"], name, { type: "video/mp4" });
}

/**
 * A fake file input that behaves like a real browser one: the `files` getter
 * is backed by a live array that EMPTIES when value is set to "".
 */
function browserLikeFiles(input: HTMLInputElement, files: File[]) {
	// Same array object every read, EMPTIED IN PLACE on value = "" — a real
	// FileList is live: a reference saved before the clear still sees length 0.
	const backing = [...files];
	Object.defineProperty(input, "files", {
		configurable: true,
		get: () => backing,
	});
	const valueDesc = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	);
	Object.defineProperty(input, "value", {
		configurable: true,
		get: valueDesc?.get,
		set(v: string) {
			if (v === "") backing.length = 0;
			valueDesc?.set?.call(input, v);
		},
	});
}

async function flushUploads(expectedCalls: number) {
	const deadline = Date.now() + 5000;
	while (mocks.createVideo.mock.calls.length < expectedCalls) {
		if (Date.now() > deadline) break;
		await new Promise((r) => setTimeout(r, 10));
	}
}

function mountButton() {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(createElement(UploadCapButton, { size: "sm" }));
	});
	const input = container.querySelector(
		'input[type="file"]',
	) as HTMLInputElement;
	const unmount = () => {
		act(() => root.unmount());
		container.remove();
	};
	return { input, unmount };
}

afterEach(() => {
	mocks.createVideo.mockClear();
	mocks.toast.success.mockClear();
	mocks.toast.info.mockClear();
});

describe("UploadCapButton handler with a browser-like FileList (must-fix #1)", () => {
	it("uploads the 1 picked file even though the clear empties the live FileList", async () => {
		const { input, unmount } = mountButton();
		browserLikeFiles(input, [makeFile("one.mp4")]);
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await flushUploads(1);
		});

		expect(input.value).toBe("");
		expect(mocks.createVideo).toHaveBeenCalledTimes(1);
		unmount();
	});

	it("uploads all 3 picked files (sequential batch), not 0", async () => {
		const { input, unmount } = mountButton();
		browserLikeFiles(input, [
			makeFile("one.mp4"),
			makeFile("two.mp4"),
			makeFile("three.mp4"),
		]);
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await flushUploads(3);
		});

		expect(mocks.createVideo).toHaveBeenCalledTimes(3);
		const names = mocks.createVideo.mock.calls.map(
			(call) => (call[0] as { fileName?: string }).fileName,
		);
		expect(names).toEqual(["one.mp4", "two.mp4", "three.mp4"]);
		unmount();
	});

	// Must-fix #5: the batch ends with one summary toast; the per-file
	// "Video uploaded!" must not fire for each of the 3 files.
	it("fires no per-file Video-uploaded toast inside the batch", async () => {
		const { input, unmount } = mountButton();
		browserLikeFiles(input, [
			makeFile("one.mp4"),
			makeFile("two.mp4"),
			makeFile("three.mp4"),
		]);
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await flushUploads(3);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		expect(mocks.toast.success).not.toHaveBeenCalledWith(
			"Video uploaded! Processing will continue in the background.",
		);
		unmount();
	});

	it("keeps the single-file Video-uploaded toast on the single-file path", async () => {
		const { input, unmount } = mountButton();
		browserLikeFiles(input, [makeFile("one.mp4")]);
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await flushUploads(1);
		});
		await act(async () => {
			await new Promise((r) => setTimeout(r, 20));
		});

		expect(mocks.toast.success).toHaveBeenCalledWith(
			"Video uploaded! Processing will continue in the background.",
		);
		unmount();
	});

	// Must-fix #4: no new pick (single or multi) while an upload or batch is
	// already running - they would share one cancel handler.
	it("refuses to open the picker while a single upload or a batch is running", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root: Root = createRoot(container);
		let picker: (() => void) | undefined;
		let store:
			| {
					state: Record<string, unknown>;
					setState: (
						fn: (s: Record<string, unknown>) => Record<string, unknown>,
					) => void;
			  }
			| undefined;
		function Probe() {
			const { inputRef, openFilePicker } = useImportUpload();
			const { uploadingStore } = useUploadingContext();
			picker = openFilePicker;
			store = uploadingStore as unknown as typeof store;
			return createElement("input", { type: "file", ref: inputRef });
		}
		act(() => {
			root.render(createElement(Probe));
		});
		const input = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const clickSpy = vi.spyOn(input, "click");

		act(() => {
			store?.setState((s) => ({ ...s, uploadStatus: { status: "parsing" } }));
		});
		act(() => {
			picker?.();
		});
		expect(clickSpy).not.toHaveBeenCalled();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadBatchBusy");

		// Same refusal when a BATCH is running instead of a single upload.
		clickSpy.mockClear();
		mocks.toast.info.mockClear();
		act(() => {
			store?.setState((s) => ({
				...s,
				uploadStatus: undefined,
				batchTotal: 3,
			}));
		});
		act(() => {
			picker?.();
		});
		expect(clickSpy).not.toHaveBeenCalled();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadBatchBusy");

		act(() => root.unmount());
		container.remove();
	});
});

describe("useImportUpload handleFileChange with a browser-like FileList (must-fix #1)", () => {
	it("hands 3 files to the batch even though the clear empties the live FileList", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root: Root = createRoot(container);
		let handler: ((e: { target: HTMLInputElement }) => void) | undefined;
		let store: {
			state: Record<string, unknown>;
			setState: (
				fn: (s: Record<string, unknown>) => Record<string, unknown>,
			) => void;
		} | undefined;
		function Probe() {
			const { handleFileChange, inputRef } = useImportUpload();
			const { uploadingStore } = useUploadingContext();
			handler = handleFileChange as typeof handler;
			store = uploadingStore as unknown as typeof store;
			return createElement("input", { type: "file", ref: inputRef });
		}
		act(() => {
			root.render(createElement(Probe));
		});
		// The mock's store is module-level, so the previous test's busy state
		// is still in it - clear every field before this test picks files.
		act(() => {
			store?.setState((s) => ({
				...s,
				uploadStatus: undefined,
				cancelHandler: undefined,
				queue: undefined,
				batchTotal: undefined,
				batchIndex: undefined,
			}));
		});
		const input = container.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		browserLikeFiles(input, [
			makeFile("a.mp4"),
			makeFile("b.mp4"),
			makeFile("c.mp4"),
		]);
		await act(async () => {
			handler?.({ target: input });
			await flushUploads(3);
		});

		expect(mocks.createVideo).toHaveBeenCalledTimes(3);
		act(() => root.unmount());
		container.remove();
	});
});
// Blind re-review finding 1 (2026-09-27): a DROP on the import page calls
// processFile directly, bypassing openFilePicker. The busy guard must live in
// processFile itself, while the running batch's own items still pass.
describe("processFile busy guard (drop path)", () => {
	it("refuses a direct upload while a batch runs, but lets batch items through", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root: Root = createRoot(container);
		let api: ReturnType<typeof useImportUpload> | undefined;
		let store:
			| {
					state: Record<string, unknown>;
					setState: (
						fn: (s: Record<string, unknown>) => Record<string, unknown>,
					) => void;
			  }
			| undefined;
		function Probe() {
			api = useImportUpload();
			store = useUploadingContext().uploadingStore as unknown as typeof store;
			return null;
		}
		act(() => {
			root.render(createElement(Probe));
		});
		act(() => {
			store?.setState((s) => ({ ...s, uploadStatus: undefined, batchTotal: 2 }));
		});

		let refused: string | null | undefined;
		await act(async () => {
			refused = await api?.processFile(makeFile("dropped.mp4"));
		});
		expect(refused).toBeNull();
		expect(mocks.createVideo).not.toHaveBeenCalled();
		expect(mocks.toast.info).toHaveBeenCalledWith("uploadBatchBusy");

		await act(async () => {
			await api?.processFile(makeFile("batch-item.mp4"), undefined, {
				skipStartCallback: true,
				inBatch: true,
			});
		});
		expect(mocks.createVideo).toHaveBeenCalledTimes(1);

		act(() => {
			store?.setState((s) => ({ ...s, uploadStatus: undefined, batchTotal: undefined }));
		});
		act(() => root.unmount());
		container.remove();
	});
});
