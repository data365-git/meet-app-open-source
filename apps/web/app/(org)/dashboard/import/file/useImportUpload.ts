"use client";

import { buildEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { Folder, type Video } from "@cap/web-domain";
import { useStore } from "@tanstack/react-store";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
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
	MULTIPART_UPLOAD_THRESHOLD_BYTES,
	MultipartCompletionUncertainError,
	uploadBlobMultipart,
} from "@/utils/multipart-upload";
import { uploadWithTarget } from "@/utils/upload-target";

export const IMPORT_FILE_ACCEPT =
	"video/*,audio/*,.mov,.MOV,.mp4,.MP4,.avi,.AVI,.mkv,.MKV,.webm,.WEBM,.m4v,.M4V,.mp3,.MP3,.wav,.WAV,.m4a,.M4A,.aac,.AAC,.ogg,.OGG,.oga,.opus,.flac,.FLAC";

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
					onProgress: (loaded, total) => {
						const percent = total > 0 ? (loaded / total) * 100 : 0;
						setUploadStatus({
							status: "uploadingVideo",
							capId: uploadId,
							progress: percent,
							thumbnailUrl: undefined,
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
					onProgress: ({ loaded, total }) => {
						const percent = (loaded / total) * 100;
						setUploadStatus({
							status: "uploadingVideo",
							capId: uploadId,
							progress: percent,
							thumbnailUrl: undefined,
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
		toast.success(
			"Video uploaded! Processing will continue in the background.",
		);
		return uploadId;
	} catch (err) {
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
	const { uploadingStore, setUploadStatus } = useUploadingContext();
	const isUploading = useStore(uploadingStore, (s) => !!s.uploadStatus);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(
		buildEnv.NEXT_PUBLIC_IS_CAP ? !user?.isPro : false,
	);
	const [pendingFile, setPendingFile] = useState<File | null>(null);

	const processFile = useCallback(
		async (
			file: File,
			serverTrim?: { inSec: number; outSec: number; duration: number },
		) => {
			if (!user || !activeOrganization) return;

			if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP) {
				setUpgradeModalOpen(true);
				return;
			}

			const createdId = await uploadVideoForServerProcessing(
				file,
				folderId ? Folder.FolderId.make(folderId) : undefined,
				activeOrganization.organization.id,
				setUploadStatus,
			);
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
				if (onUploadStarted) {
					onUploadStarted();
				} else {
					router.push(
						folderId ? `/dashboard/folder/${folderId}` : "/dashboard/caps",
					);
				}
			}
		},
		[
			user,
			activeOrganization,
			setUploadStatus,
			router,
			folderId,
			onUploadStarted,
		],
	);

	const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		setPendingFile(file);
		if (inputRef.current) inputRef.current.value = "";
	};

	const openFilePicker = () => {
		if (!user) return;

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
		handleFileChange,
		openFilePicker,
		progressPercent,
		statusLabel,
	};
}
