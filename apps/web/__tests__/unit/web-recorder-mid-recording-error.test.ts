// @vitest-environment jsdom
import { Exit } from "effect";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// --- Module mocks -----------------------------------------------------
// useWebRecorder pulls in a large surface (routing, react-query, server
// actions, the Effect RPC runtime, thumbnail conversion, OPFS spooling...).
// None of that is relevant to the bug under test (a mid-recording
// MediaRecorder error being silently dropped), so every one of those is
// replaced with a minimal, inspectable stand-in. The upload primitives that
// ARE the bug's blast radius — recording-upload.ts (buffered-raw) and the
// real InstantRecordingUploader (streaming-webm) — are exercised for real.

const { toastMock, rpcClientMock, uploadRecordingMock } = vi.hoisted(() => ({
	toastMock: {
		error: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
		info: vi.fn(),
		dismiss: vi.fn(),
	},
	rpcClientMock: {
		VideoInstantCreate: vi.fn(),
		// Exit.succeed's shape is a plain tagged object; reproduce it directly
		// here since `effect`'s import can't be relied on inside vi.hoisted.
		VideoDelete: vi.fn(async () => ({ _tag: "Success", value: undefined })),
	},
	uploadRecordingMock: vi.fn(async () => {}),
}));

vi.mock("sonner", () => ({ toast: toastMock }));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ refetchQueries: vi.fn() }),
}));

vi.mock("@cap/utils", () => ({
	formatPlatformDateTime: () => "",
}));

vi.mock("@cap/web-domain", () => ({
	Folder: { FolderId: { make: (value: string) => value } },
	Organisation: { OrganisationId: { make: (value: string) => value } },
}));

vi.mock("@/lib/EffectRuntime", () => ({
	useEffectMutation: ({
		mutationFn,
	}: {
		mutationFn: (v: unknown) => unknown;
	}) => ({
		mutateAsync: mutationFn,
	}),
	useRpcClient: () => rpcClientMock,
}));

vi.mock("@/lib/Requests/ThumbnailRequest", () => ({
	ThumbnailRequest: { queryKey: (id: string) => ["thumbnail", id] },
}));

vi.mock("@/utils/upload-target", () => ({
	uploadWithTarget: vi.fn(async () => {}),
}));

vi.mock("@/actions/video/trigger-instant-recording-processing", () => ({
	triggerInstantRecordingProcessing: vi.fn(async () => {}),
}));

vi.mock("@/actions/video/upload", () => ({
	createVideoAndGetUploadUrl: vi.fn(async () => ({ uploadTarget: {} })),
}));

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-upload",
	() => ({ uploadRecording: uploadRecordingMock }),
);

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-conversion",
	() => ({
		captureThumbnail: vi.fn(async () => null),
		convertToMp4: vi.fn(async (blob: Blob) => blob),
	}),
);

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool",
	() => ({
		canUseRecordingSpool: () => false,
		deleteRecoveredRecordingSpool: vi.fn(async () => {}),
		RecordingSpool: class {},
	}),
);

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recording-spool-fallback",
	() => ({ moveRecordingSpoolToInMemoryBackup: vi.fn(async () => {}) }),
);

vi.mock(
	"@/app/(org)/dashboard/caps/components/web-recorder-dialog/recovered-recording-cache",
	() => ({
		loadRecoveredRecordingSpools: vi.fn(async () => []),
		removeRecoveredRecordingSpoolFromCache: vi.fn(),
	}),
);

vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: vi.fn(async () => {}),
}));

vi.mock("@/app/(org)/dashboard/caps/UploadingContext", () => ({
	useUploadingContext: () => ({ setUploadStatus: vi.fn() }),
}));

// --- Fake browser primitives ------------------------------------------

type FakeTrack = {
	kind: "video" | "audio";
	enabled: boolean;
	getSettings: () => MediaTrackSettings;
	addEventListener: (...args: unknown[]) => void;
	removeEventListener: (...args: unknown[]) => void;
	stop: () => void;
};

const makeVideoTrack = (): FakeTrack => ({
	kind: "video",
	enabled: true,
	getSettings: () => ({ width: 1280, height: 720, frameRate: 30 }),
	addEventListener: vi.fn(),
	removeEventListener: vi.fn(),
	stop: vi.fn(),
});

class FakeMediaStream {
	private tracks: FakeTrack[];
	constructor(tracks: FakeTrack[] = []) {
		this.tracks = tracks;
	}
	getTracks() {
		return this.tracks;
	}
	getVideoTracks() {
		return this.tracks.filter((track) => track.kind === "video");
	}
	getAudioTracks() {
		return this.tracks.filter((track) => track.kind === "audio");
	}
}

class FakeMediaRecorder {
	static isTypeSupported = vi.fn((_type: string) => false);
	static instances: FakeMediaRecorder[] = [];

	state: "inactive" | "recording" | "paused" = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onerror: ((event: { error?: DOMException }) => void) | null = null;
	onstop: (() => void) | null = null;
	mimeType: string;

	constructor(_stream: unknown, options: { mimeType: string }) {
		this.mimeType = options.mimeType;
		FakeMediaRecorder.instances.push(this);
	}

	start(_timeslice?: number) {
		this.state = "recording";
	}

	stop() {
		this.state = "inactive";
	}

	pause() {
		this.state = "paused";
	}

	resume() {
		this.state = "recording";
	}
}

const makeBlob = (size: number, type: string) =>
	new Blob([new Uint8Array(size)], { type });

const getUserMediaMock = vi.fn(
	async () => new FakeMediaStream([makeVideoTrack()]),
);

const makeJsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

class MockXMLHttpRequest {
	static nextEtag = 0;

	upload = { onprogress: null as ((event: unknown) => void) | null };
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	timeout = 0;
	private headers = new Map<string, string>();

	open() {}
	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}
	getResponseHeader(name: string) {
		return this.headers.get(name.toLowerCase()) ?? null;
	}
	send() {
		MockXMLHttpRequest.nextEtag += 1;
		this.status = 200;
		this.statusText = "OK";
		this.headers.set("etag", `"etag-${MockXMLHttpRequest.nextEtag}"`);
		this.onload?.();
	}
	abort() {
		this.onabort?.();
	}
}

// --- renderHook harness (no @testing-library/react in this repo) ------

function renderHook<T>(useHook: () => T) {
	let current: T;
	function TestComponent() {
		current = useHook();
		return null;
	}

	const container = document.createElement("div");
	document.body.appendChild(container);
	let root: Root;
	act(() => {
		root = createRoot(container);
		root.render(createElement(TestComponent));
	});

	return {
		get result() {
			return current;
		},
		unmount: () => {
			act(() => {
				root.unmount();
			});
			container.remove();
		},
	};
}

// --- Test setup ---------------------------------------------------------

import { useWebRecorder } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder";

describe("useWebRecorder — mid-recording MediaRecorder error", () => {
	beforeEach(() => {
		FakeMediaRecorder.instances = [];
		FakeMediaRecorder.isTypeSupported = vi.fn((_type: string) => false);
		MockXMLHttpRequest.nextEtag = 0;
		uploadRecordingMock.mockClear();
		toastMock.error.mockClear();
		toastMock.warning.mockClear();
		rpcClientMock.VideoInstantCreate.mockReset();

		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		vi.stubGlobal("MediaStream", FakeMediaStream);
		vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
		vi.stubGlobal("navigator", {
			userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
			mediaDevices: { getUserMedia: getUserMediaMock },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("uploads the captured bytes and surfaces an error when the recorder fails mid-recording (buffered-raw)", async () => {
		// Only an exact "video/mp4" match is supported: no webm (forces
		// buffered-raw) and fileExtension "mp4" (skips convertToMp4).
		FakeMediaRecorder.isTypeSupported = vi.fn(
			(type: string) => type === "video/mp4",
		);
		rpcClientMock.VideoInstantCreate.mockResolvedValue(
			Exit.succeed({
				id: "video-1",
				shareUrl: "https://example.test/s/video-1",
				upload: {},
			}),
		);

		const hook = renderHook(() =>
			useWebRecorder({
				organisationId: "org-1",
				folderId: null,
				selectedMicId: null,
				micEnabled: false,
				systemAudioEnabled: false,
				recordingMode: "camera",
				selectedCameraId: "camera-1",
				isProUser: true,
			}),
		);

		await act(async () => {
			await hook.result.startRecording();
		});

		const recorder = FakeMediaRecorder.instances.at(-1);
		if (!recorder) throw new Error("Recorder was not constructed");
		expect(recorder.state).toBe("recording");

		// Two chunks recorded successfully before the recorder dies.
		await act(async () => {
			recorder.ondataavailable?.({ data: makeBlob(1000, "video/mp4") });
			recorder.ondataavailable?.({ data: makeBlob(1000, "video/mp4") });
		});

		// Fatal error mid-recording (no Stop click) — the browser then auto
		// stops: fires a final chunk, then `stop`. All synchronous, per spec.
		await act(async () => {
			recorder.onerror?.({
				error: new DOMException("encoder died", "UnknownError"),
			});
			recorder.state = "inactive";
			recorder.ondataavailable?.({ data: makeBlob(500, "video/mp4") });
			recorder.onstop?.();
		});

		await act(async () => {
			await vi.waitFor(() => {
				expect(uploadRecordingMock).toHaveBeenCalledTimes(1);
			});
		});

		expect(toastMock.error).toHaveBeenCalledWith(
			expect.stringContaining("stopped unexpectedly"),
		);

		// THE ASSERTION THAT MATTERS: nothing recorded before the crash was
		// thrown away. Old code clears recordedChunksRef and never resolves
		// the stop promise, so uploadRecording is never called at all.
		const uploadedBlob = (
			uploadRecordingMock.mock.calls[0] as unknown as [Blob]
		)[0];
		expect(uploadedBlob.size).toBe(1000 + 1000 + 500);

		// A successful salvage must NOT read as failure: the cap exists and is
		// shareable, so the phase is "completed" and the share link is surfaced.
		// Reporting "error" here would withhold the link for a recording that was
		// actually saved — the user re-records and the salvaged cap is orphaned.
		// The truth (it ended early) is carried by the warning, not by the phase.
		expect(hook.result.phase).toBe("completed");
		expect(toastMock.warning).toHaveBeenCalledWith(
			expect.stringContaining("stopped unexpectedly"),
		);

		hook.unmount();
	});

	it("completes the multipart upload with the captured bytes and surfaces an error when the recorder fails mid-recording (streaming-webm)", async () => {
		FakeMediaRecorder.isTypeSupported = vi.fn((type: string) =>
			type.includes("webm"),
		);
		rpcClientMock.VideoInstantCreate.mockResolvedValue(
			Exit.succeed({
				id: "video-2",
				shareUrl: "https://example.test/s/video-2",
				upload: {},
			}),
		);

		const presignedParts: string[] = [];
		let completedParts:
			| Array<{ partNumber: number; etag: string; size: number }>
			| undefined;

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1", provider: "s3" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					presignedParts.push(body.partNumber);
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					});
				}
				if (url === "/api/upload/multipart/complete") {
					completedParts = body.parts;
					return makeJsonResponse({ success: true });
				}

				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);

		const hook = renderHook(() =>
			useWebRecorder({
				organisationId: "org-1",
				folderId: null,
				selectedMicId: null,
				micEnabled: false,
				systemAudioEnabled: false,
				recordingMode: "camera",
				selectedCameraId: "camera-1",
				isProUser: true,
			}),
		);

		await act(async () => {
			await hook.result.startRecording();
		});

		const recorder = FakeMediaRecorder.instances.at(-1);
		if (!recorder) throw new Error("Recorder was not constructed");
		expect(recorder.state).toBe("recording");

		// Two small chunks stream live before the recorder dies. They're
		// well under the 16 MiB flush threshold, so they only get uploaded
		// once finalize() force-flushes the buffer.
		await act(async () => {
			recorder.ondataavailable?.({ data: makeBlob(1000, "video/webm") });
			recorder.ondataavailable?.({ data: makeBlob(1000, "video/webm") });
		});

		await act(async () => {
			recorder.onerror?.({
				error: new DOMException("encoder died", "UnknownError"),
			});
			recorder.state = "inactive";
			recorder.ondataavailable?.({ data: makeBlob(500, "video/webm") });
			recorder.onstop?.();
		});

		await act(async () => {
			await vi.waitFor(() => {
				expect(completedParts).toBeDefined();
			});
		});

		expect(toastMock.error).toHaveBeenCalledWith(
			expect.stringContaining("stopped unexpectedly"),
		);

		// THE ASSERTION THAT MATTERS: the multipart upload was actually
		// completed with every byte captured before the crash — old code
		// never calls finalize() at all when there is no user Stop, leaving
		// the upload dangling on R2 forever.
		const totalUploadedBytes = (completedParts ?? []).reduce(
			(sum, part) => sum + part.size,
			0,
		);
		expect(totalUploadedBytes).toBe(1000 + 1000 + 500);

		// As above: salvage succeeded, so this reads as "completed" (share link
		// surfaced) with the early ending carried by the warning — never as a
		// failure screen for a recording that is safely uploaded.
		expect(hook.result.phase).toBe("completed");
		expect(toastMock.warning).toHaveBeenCalledWith(
			expect.stringContaining("stopped unexpectedly"),
		);

		hook.unmount();
	});
});
