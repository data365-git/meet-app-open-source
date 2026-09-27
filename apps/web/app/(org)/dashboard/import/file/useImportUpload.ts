"use client";

import { buildEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { Folder, type Video } from "@cap/web-domain";
import { useStore } from "@tanstack/react-store";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { cancelUpload } from "@/actions/video/cancel-upload";
import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { markUploadFailed } from "@/actions/video/mark-upload-failed";
import { triggerVideoProcessing } from "@/actions/video/trigger-processing";
import { saveVideoEdits } from "@/actions/videos/save-edits";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { sendProgressUpdate } from "@/app/(org)/dashboard/caps/components/sendProgressUpdate";
import {
	type UploadStatus,
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";
import {
	CancelledUploadError,
	MULTIPART_UPLOAD_THRESHOLD_BYTES,
	MultipartCompletionUncertainError,
	uploadBlobMultipart,
} from "@/utils/multipart-upload";
import { uploadWithTarget } from "@/utils/upload-target";
import {
	capBatch,
	MAX_BATCH_FILES,
	queueAfterStart,
	runUploadQueue,
} from "./upload-queue";

export const IMPORT_FILE_ACCEPT =
	"video/*,audio/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V,.mp3,.MP3,.wav,.WAV,.m4a,.M4A,.aac,.AAC,.ogg,.OGG,.oga,.opus,.flac,.FLAC";

// Rolling-window speed estimate: bytesPerSecond/secondsRemaining are derived
// only from samples spanning roughly the last SPEED_WINDOW_MS. Using the
// whole upload's average would let a slow start (or a network hiccup) poison
// the ETA for the rest of a multi-hour upload.
export const SPEED_WINDOW_MS = 8000;

export interface ProgressSample {
	time: number;
	loaded: number;
}

/** Pure, no React — testable without mounting anything. */
export function computeBytesPerSecond(
	samples: ProgressSample[],
	windowMs: number = SPEED_WINDOW_MS,
): number | undefined {
	if (samples.length === 0) return undefined;
	const latest = samples[samples.length - 1];
	if (!latest) return undefined;
	const windowStart = latest.time - windowMs;
	const windowed = samples.filter((s) => s.time >= windowStart);
	if (windowed.length < 2) return undefined;
	const first = windowed[0];
	if (!first) return undefined;
	const elapsedSeconds = (latest.time - first.time) / 1000;
	if (elapsedSeconds <= 0) return undefined;
	const speed = (latest.loaded - first.loaded) / elapsedSeconds;
	return speed > 0 ? speed : undefined;
}

/** Pure, no React. Never returns Infinity/NaN — undefined when unknown. */
export function computeSecondsRemaining(
	loaded: number,
	total: number,
	bytesPerSecond: number | undefined,
): number | undefined {
	if (!bytesPerSecond || bytesPerSecond <= 0) return undefined;
	const remainingBytes = total - loaded;
	if (remainingBytes <= 0) return 0;
	return remainingBytes / bytesPerSecond;
}

/**
 * Module-scope factory for the rolling sample window kept per upload attempt.
 * A fresh instance per upload keeps concurrent uploads (and repeated retries
 * of the same file) from bleeding samples into each other.
 */
function createSpeedTracker() {
	let samples: ProgressSample[] = [];
	return {
		record(loaded: number, time: number = Date.now()) {
			samples.push({ time, loaded });
			// Bound memory; SPEED_WINDOW_MS worth of ticks never gets close to this.
			if (samples.length > 60) samples = samples.slice(-60);
			const bytesPerSecond = computeBytesPerSecond(samples);
			return { bytesPerSecond };
		},
	};
}

function isAudioFile(file: File) {
	return (
		file.type.startsWith("audio/") ||
		/\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(file.name)
	);
}

async function uploadVideoForServerProcessing(
	file: File,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
	signal: AbortSignal,
	cancelMessages: {
		cancelled: string;
		cancelRefused: string;
		cancelFailed: string;
	},
	opts?: { suppressSuccessToast?: boolean },
) {
	// Hoisted so the outer catch can reference it for orphan cleanup.
	let createdVideoId:
		| Awaited<ReturnType<typeof createVideoForServerProcessing>>["id"]
		| undefined;

	try {
		setUploadStatus({ status: "parsing" });

		let duration: number | undefined;
		let resolution: string | undefined;

		try {
			const parser = await import("@remotion/media-parser");
			const metadata = await parser.parseMedia({
				src: file,
				fields: {
					durationInSeconds: true,
					dimensions: true,
				},
			});

			duration = metadata.durationInSeconds
				? Math.round(metadata.durationInSeconds)
				: undefined;
			resolution = metadata.dimensions
				? `${metadata.dimensions.width}x${metadata.dimensions.height}`
				: undefined;
		} catch (parseError) {
			console.warn(
				"Failed to parse video metadata, continuing without it:",
				parseError,
			);
		}

		setUploadStatus({ status: "creating" });
		const videoData = await createVideoForServerProcessing({
			duration,
			resolution,
			folderId,
			orgId,
			isAudio: isAudioFile(file),
			mimeType: file.type || undefined,
			// The owner picked this file and knows it by this name. Without it the
			// recording was titled from a template ("data365 Upload - <date>") and
			// his own filename was discarded at the door.
			fileName: file.name,
		});

		const uploadId = videoData.id;
		createdVideoId = videoData.id;

		setUploadStatus({
			status: "uploadingVideo",
			capId: uploadId,
			progress: 0,
			thumbnailUrl: undefined,
		});

		const createProgressTracker = () => {
			const uploadState = {
				videoId: uploadId,
				uploaded: 0,
				total: 0,
				pendingTask: undefined as ReturnType<typeof setTimeout> | undefined,
				lastUpdateTime: Date.now(),
			};

			const scheduleProgressUpdate = (uploaded: number, total: number) => {
				uploadState.uploaded = uploaded;
				uploadState.total = total;
				uploadState.lastUpdateTime = Date.now();

				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}

				const shouldSendImmediately = uploaded >= total;

				if (!shouldSendImmediately) {
					uploadState.pendingTask = setTimeout(() => {
						if (uploadState.videoId) {
							sendProgressUpdate(
								uploadState.videoId,
								uploadState.uploaded,
								uploadState.total,
							);
						}
						uploadState.pendingTask = undefined;
					}, 2000);
				}
			};

			const cleanup = () => {
				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}
			};

			const getTotal = () => uploadState.total;
			const didFinishSending = () =>
				uploadState.total > 0 && uploadState.uploaded >= uploadState.total;

			return { scheduleProgressUpdate, cleanup, getTotal, didFinishSending };
		};

		const progressTracker = createProgressTracker();
		const speedTracker = createSpeedTracker();

		// Large files route through multipart (16MB parts, parallel, per-part
		// retry + stall timeout — utils/multipart-upload.ts, shared with the web
		// recorder) instead of one un-chunked PUT: a dropped connection mid-upload
		// then only costs a 16MB part retry, not the whole file. The multipart
		// key uses the "raw-upload." naming convention so the server's /complete
		// route auto-starts processing (same contract the extension/web-recorder
		// raw uploads already use) — triggerVideoProcessing is only needed for
		// the single-PUT path below, which never touches that route.
		const useMultipart = file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES;

		if (useMultipart) {
			let processingStarted = true;
			try {
				const completion = await uploadBlobMultipart({
					videoId: uploadId,
					blob: file,
					contentType:
						file.type || (isAudioFile(file) ? "audio/mpeg" : "video/mp4"),
					subpath: "raw-upload.mp4",
					durationInSecs: duration,
					signal,
					onProgress: (loaded, total) => {
						const percent = total > 0 ? (loaded / total) * 100 : 0;
						const { bytesPerSecond } = speedTracker.record(loaded);
						setUploadStatus({
							status: "uploadingVideo",
							capId: uploadId,
							progress: percent,
							thumbnailUrl: undefined,
							loadedBytes: loaded,
							totalBytes: total,
							bytesPerSecond,
							secondsRemaining: computeSecondsRemaining(
								loaded,
								total,
								bytesPerSecond,
							),
						});

						progressTracker.scheduleProgressUpdate(loaded, total);
					},
				});
				processingStarted = completion.processingStarted;
			} catch (uploadError) {
				progressTracker.cleanup();
				// (H3) The complete request can succeed on the server while its
				// response is lost in transit. The bytes are safely stored either
				// way, so this is not a hard failure — tell the user to check
				// rather than silently marking the upload failed and re-uploading.
				if (uploadError instanceof MultipartCompletionUncertainError) {
					console.warn(
						"Multipart completion uncertain; the file may already be safely stored",
						uploadError,
					);
					toast.warning(
						"Upload confirmation was interrupted. Check the video before assuming it failed.",
					);
				} else {
					throw uploadError;
				}
			}
			progressTracker.cleanup();
			await sendProgressUpdate(uploadId, file.size, file.size);

			setUploadStatus({
				status: "serverProcessing",
				capId: uploadId,
			});

			if (!processingStarted) {
				toast.warning(
					"Video uploaded. Processing did not start yet, but the original file is available.",
				);
			}
		} else {
			try {
				await uploadWithTarget({
					target: videoData.uploadTarget,
					body: file,
					fileName: file.name,
					signal,
					onProgress: ({ loaded, total }) => {
						const percent = (loaded / total) * 100;
						const { bytesPerSecond } = speedTracker.record(loaded);
						setUploadStatus({
							status: "uploadingVideo",
							capId: uploadId,
							progress: percent,
							thumbnailUrl: undefined,
							loadedBytes: loaded,
							totalBytes: total,
							bytesPerSecond,
							secondsRemaining: computeSecondsRemaining(
								loaded,
								total,
								bytesPerSecond,
							),
						});

						progressTracker.scheduleProgressUpdate(loaded, total);
					},
				});
			} catch (uploadError) {
				if (!progressTracker.didFinishSending()) {
					progressTracker.cleanup();
					throw uploadError;
				}

				console.warn(
					"Upload request failed after all bytes were sent; verifying object before processing:",
					uploadError,
				);
			}
			progressTracker.cleanup();
			const total = progressTracker.getTotal() || file.size || 1;
			await sendProgressUpdate(uploadId, total, total);

			setUploadStatus({
				status: "serverProcessing",
				capId: uploadId,
			});

			try {
				await triggerVideoProcessing({
					videoId: uploadId,
					rawFileKey: videoData.rawFileKey,
					bucketId: videoData.bucketId,
				});
			} catch (triggerError) {
				console.error("Failed to trigger processing:", triggerError);
				toast.error("Failed to start video processing. Please try again.");
				setUploadStatus(undefined);
				return null;
			}
		}

		setUploadStatus(undefined);
		// Inside a multi-file batch each file already reports through the batch
		// progress ("File 2/5") and the one summary toast at the end; a
		// per-file "Video uploaded!" would fire N times over it.
		if (!opts?.suppressSuccessToast) {
			toast.success(
				"Video uploaded! Processing will continue in the background.",
			);
		}
		return uploadId;
	} catch (err) {
		// Owner order 2026-09-11: a cancelled upload is not a failure — no error
		// toast, no markUploadFailed (that would leave a permanent "error" row
		// behind for something the user asked to go away entirely). Discard the
		// row and whatever bytes were already sent via the same permanent-erase
		// path the account-deletion and Trash flows already use.
		// Any failure once the signal is aborted is the cancel, not a new error:
		// a request that carries no signal (e.g. initiate) can still reject with
		// "Failed to fetch" after the user pressed Cancel.
		if (err instanceof CancelledUploadError || signal.aborted) {
			let outcome: "cancelled" | "refused" | "failed" = "cancelled";
			if (createdVideoId) {
				try {
					const result = await cancelUpload(createdVideoId);
					if (!result.ok) {
						outcome = "refused";
						console.error("cancelUpload failed:", result.error);
					}
				} catch (cleanupErr) {
					outcome = "failed";
					console.error("Failed to cancel upload:", cleanupErr);
				}
			}
			if (outcome === "cancelled") {
				toast.info(cancelMessages.cancelled);
			} else if (outcome === "refused") {
				toast.error(cancelMessages.cancelRefused);
			} else {
				toast.error(cancelMessages.cancelFailed);
			}
			setUploadStatus(undefined);
			return null;
		}

		console.error("Video upload failed", err);

		// Mark the orphaned upload row as errored so it doesn't stay stuck at
		// "uploading" indefinitely. Wrapped so a cleanup failure never swallows
		// the original error path.
		if (createdVideoId) {
			try {
				await markUploadFailed(createdVideoId);
			} catch (cleanupErr) {
				console.error("Failed to mark upload as failed:", cleanupErr);
			}
		}

		if (err instanceof Error && err.message === "upgrade_required") {
			toast.error(
				"Video duration exceeds the limit for free accounts. Please upgrade to Pro.",
			);
		} else {
			toast.error("Failed to upload video. Please try again.");
		}
	}

	setUploadStatus(undefined);
	return null;
}

/**
 * Shared import-upload machinery used by both the standalone /dashboard/import/file
 * page and the one-step "Import file" button on /dashboard/caps.
 *
 * `onUploadStarted` lets each caller decide navigation after the upload kicks off
 * (the file page always redirects; the Caps page stays put unless a folderId is set).
 */
export function useImportUpload({
	folderId,
	onUploadStarted,
}: {
	folderId?: string;
	onUploadStarted?: () => void;
} = {}) {
	const { user, activeOrganization } = useDashboardContext();
	const router = useRouter();
	const inputRef = useRef<HTMLInputElement>(null);
	const t = useTranslations("library");
	const { uploadingStore, setUploadStatus, setCancelHandler, setQueueState } =
		useUploadingContext();
	// Busy = a single upload is running (uploadStatus) OR a multi-file batch
	// is running (batchTotal). Checking only batchTotal let a single upload
	// and a batch run in parallel, sharing one cancel handler between them.
	const isUploading = useStore(
		uploadingStore,
		(s) => !!s.uploadStatus || !!s.batchTotal,
	);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(
		buildEnv.NEXT_PUBLIC_IS_CAP ? !user?.isPro : false,
	);
	const [pendingFile, setPendingFile] = useState<File | null>(null);

	const processFile = useCallback(
		async (
			file: File,
			serverTrim?: { inSec: number; outSec: number; duration: number },
			opts?: { skipStartCallback?: boolean; inBatch?: boolean },
		): Promise<string | null> => {
			if (!user || !activeOrganization) return null;

			// Every upload passes through here, so the busy guard lives here too:
			// a drop (ImportFilePage) bypasses openFilePicker, and a second upload
			// would steal the running one's cancel handler. Batch items are the
			// running batch itself, so they pass.
			if (
				!opts?.inBatch &&
				(uploadingStore.state.uploadStatus || uploadingStore.state.batchTotal)
			) {
				toast.info(t("uploadBatchBusy"));
				return null;
			}

			if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
				setUpgradeModalOpen(true);
				return null;
			}

			// Owned by this call, not by the upload function: `processFile` is the
			// one place that knows an upload attempt has started and ended, so it
			// registers/clears the Cancel control around the whole call rather
			// than the upload function reaching back out to the context itself.
			const abortController = new AbortController();
			setCancelHandler(() => abortController.abort());

			let createdId: string | null;
			try {
				createdId = await uploadVideoForServerProcessing(
					file,
					folderId ? Folder.FolderId.make(folderId) : undefined,
					activeOrganization.organization.id,
					setUploadStatus,
					abortController.signal,
					{
						cancelled: t("uploadCancelled"),
						cancelRefused: t("cancelUploadRefused"),
						cancelFailed: t("cancelUploadFailed"),
					},
					{ suppressSuccessToast: opts?.inBatch },
				);
			} finally {
				setCancelHandler(undefined);
			}
			if (createdId) {
				if (serverTrim) {
					const trimId = createdId as Video.VideoId;
					const editSpec = {
						version: 1 as const,
						sourceDuration: serverTrim.duration,
						keepRanges: [{ start: serverTrim.inSec, end: serverTrim.outSec }],
					};
					// The just-uploaded video's videoUploads row is still being cleared
					// by background processing, and saveVideoEdits refuses while an
					// upload/processing phase is active. Retry (in the background, so the
					// redirect isn't blocked) until that row clears, then the trim runs.
					void (async () => {
						for (let attempt = 0; attempt < 6; attempt++) {
							try {
								const res = await saveVideoEdits(trimId, editSpec);
								if (res.ok) return;
							} catch (err) {
								console.error("Server trim attempt failed:", err);
							}
							await new Promise((r) => setTimeout(r, 1500));
						}
						toast.error(
							"Trim didn't start on the server; the full video was uploaded instead.",
						);
					})();
				}
				// In a multi-file batch (processFiles) the navigation happens once,
				// right after the FIRST file starts — not once per file.
				if (!opts?.skipStartCallback) {
					if (onUploadStarted) {
						onUploadStarted();
					} else {
						router.push(
							folderId ? `/dashboard/folder/${folderId}` : "/dashboard/caps",
						);
					}
				}
			}
			// The uploaded video's id (runUploadQueue counts this as
			// success), or null when the upload was cancelled or failed (its
			// own path already toasted the reason).
			return createdId ?? null;
		},
		[
			user,
			activeOrganization,
			setUploadStatus,
			router,
			folderId,
			onUploadStarted,
			t,
			uploadingStore,
		],
	);

	/**
	 * Owner order 2026-09-26: "bir vaqtda bir nechta fayl yuklash", limit 20,
	 * UPLOAD ONLY (AI analysis stays per-recording, one by one). Files upload
	 * strictly sequentially via runUploadQueue. Exactly 1 file behaves as
	 * today; 2+ files skip the pre-upload trimmer (trimming N files one by
	 * one before anything uploads was not what was ordered). The batch state
	 * lives in the UploadingContext Store so the loop survives the page that
	 * started it unmounting (the file page navigates away after the first
	 * file starts).
	 */
	const processFiles = useCallback(
		async (files: File[]) => {
			if (!user || !activeOrganization) return;

			if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
				setUpgradeModalOpen(true);
				return;
			}

			if (uploadingStore.state.batchTotal || uploadingStore.state.uploadStatus) {
				toast.info(t("uploadBatchBusy"));
				return;
			}

			const { taken, dropped } = capBatch(files);
			if (dropped > 0) {
				toast.info(t("uploadBatchLimited", { max: MAX_BATCH_FILES }));
			}

			// One file: exactly today's single-file path (no batch state at all).
			if (taken.length === 1 && taken[0]) {
				void processFile(taken[0]);
				return;
			}

			const items = taken.map((file, index) => ({
				id: `batch-${Date.now()}-${index}`,
				file,
			}));

			setQueueState({
				queue: items.slice(1).map(({ id, file }) => ({ id, name: file.name })),
				batchTotal: items.length,
				batchIndex: 1,
			});

			// The item currently uploading is NOT in `queue`; isRemoved must not
			// mistake it for a removed one, so it is seeded with the first item
			// (runUploadQueue checks isRemoved before onStart for each item).
			let currentId = items[0]?.id;
			let navigated = false;

			try {
				const summary = await runUploadQueue({
					items,
					upload: (file) =>
						processFile(file, undefined, {
							skipStartCallback: true,
							// The batch shows its own progress and ends with one
							// summary toast; no per-file "Video uploaded!" on top.
							inBatch: true,
						}),
					isRemoved: (id) =>
						id !== currentId &&
						!(uploadingStore.state.queue ?? []).some(
							(entry) => entry.id === id,
						),
					onStart: (index, id) => {
						currentId = id;
						// Shrink the LIVE queue (never rebuild it from `items`: that
						// would put back a file the user already removed with ✕).
						setQueueState({
							queue: queueAfterStart(uploadingStore.state.queue, id),
							batchIndex: index + 1,
						});
						// Navigate ONCE, right after the first file starts.
						if (!navigated) {
							navigated = true;
							if (onUploadStarted) {
								onUploadStarted();
							} else {
								router.push(
									folderId
										? `/dashboard/folder/${folderId}`
										: "/dashboard/caps",
								);
							}
						}
					},
				});

				// From the user's point of view a file removed from the queue was
				// never uploaded, so it counts as "not uploaded" in the summary.
				const notUploaded = summary.notUploaded + summary.removed;
				if (notUploaded > 0) {
					toast.info(
						t("uploadBatchSummaryNotUploaded", {
							total: items.length,
							uploaded: summary.uploaded,
							notUploaded,
						}),
					);
				} else {
					toast.success(
						t("uploadBatchSummary", {
							total: items.length,
							uploaded: summary.uploaded,
						}),
					);
				}
			} finally {
				currentId = undefined;
				setQueueState({
					queue: undefined,
					batchTotal: undefined,
					batchIndex: undefined,
				});
			}
		},
		[
			user,
			activeOrganization,
			uploadingStore,
			setQueueState,
			processFile,
			router,
			folderId,
			onUploadStarted,
			t,
		],
	);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		// Copy the FileList BEFORE clearing the input: in a real browser
		// input.value = "" empties the LIVE FileList, so reading it after the
		// clear saw an empty list and nothing ever uploaded.
		const files = Array.from(e.target.files ?? []);
		if (files.length > 1) {
			if (inputRef.current) inputRef.current.value = "";
			void processFiles(files);
			return;
		}
		const file = files[0];
		if (!file) return;
		setPendingFile(file);
		if (inputRef.current) inputRef.current.value = "";
	};

	const openFilePicker = () => {
		if (!user) return;

		// Refuse ANY new pick (single or multi) while something is already
		// uploading: a second pick would run in parallel with the first and
		// both would fight over the one cancel handler in the store.
		if (uploadingStore.state.uploadStatus || uploadingStore.state.batchTotal) {
			toast.info(t("uploadBatchBusy"));
			return;
		}

		if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
			setUpgradeModalOpen(true);
			return;
		}

		inputRef.current?.click();
	};

	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);
	const progressPercent =
		uploadStatus && "progress" in uploadStatus
			? Math.round(uploadStatus.progress)
			: null;
	const statusLabel = uploadStatus
		? uploadStatus.status === "parsing"
			? "Analyzing video..."
			: uploadStatus.status === "creating"
				? "Preparing upload..."
				: uploadStatus.status === "uploadingVideo"
					? `Uploading... ${progressPercent ?? 0}%`
					: uploadStatus.status === "serverProcessing"
						? "Processing on server..."
						: "Working..."
		: null;

	return {
		inputRef,
		isUploading,
		upgradeModalOpen,
		setUpgradeModalOpen,
		pendingFile,
		setPendingFile,
		processFile,
		processFiles,
		handleFileChange,
		openFilePicker,
		progressPercent,
		statusLabel,
	};
}
