"use client";

import { LogoSpinner } from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import { useStore } from "@tanstack/react-store";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { type UploadStatus, useUploadingContext } from "../UploadingContext";

const { circumference } = getProgressCircleConfig();

const MB = 1024 * 1024;
const GB = MB * 1024;
const REMAINING_CAP_SECONDS = 6 * 3600;

/** Pure, no React — MB below 1024 MB, GB (one decimal) above. */
export function formatBytes(bytes: number): string {
	const safeBytes = Math.max(0, bytes);
	if (safeBytes >= GB) return `${(safeBytes / GB).toFixed(1)} GB`;
	return `${Math.round(safeBytes / MB)} MB`;
}

export type RemainingTimeParts =
	| { kind: "capped" }
	| { kind: "hoursMinutes"; hours: number; minutes: number }
	| { kind: "minutes"; minutes: number }
	| { kind: "lessThanMinute" };

/** Pure, no React. hours+minutes above an hour, minutes above a minute, else "less than a minute". */
export function getRemainingTimeParts(seconds: number): RemainingTimeParts {
	if (seconds > REMAINING_CAP_SECONDS) return { kind: "capped" };
	if (seconds >= 3600) {
		const totalMinutes = Math.floor(seconds / 60);
		return {
			kind: "hoursMinutes",
			hours: Math.floor(totalMinutes / 60),
			minutes: totalMinutes % 60,
		};
	}
	if (seconds >= 60) return { kind: "minutes", minutes: Math.floor(seconds / 60) };
	return { kind: "lessThanMinute" };
}

function formatRemainingTime(
	t: ReturnType<typeof useTranslations>,
	parts: RemainingTimeParts,
): string {
	switch (parts.kind) {
		case "capped":
			return t("uploadTimeRemainingCapped");
		case "hoursMinutes":
			return t("uploadTimeRemainingHoursMinutes", {
				hours: parts.hours,
				minutes: parts.minutes,
			});
		case "minutes":
			return t("uploadTimeRemainingMinutes", { minutes: parts.minutes });
		case "lessThanMinute":
			return t("uploadTimeRemainingLessThanMinute");
	}
}

export const UploadPlaceholderCard = () => {
	const t = useTranslations("library");
	const { uploadingStore } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);
	// Owner order 2026-09-11: undefined once server processing has genuinely
	// started (or once nothing is uploading at all) — never a stale handle
	// pointing at a call that already finished.
	const cancelHandler = useStore(uploadingStore, (s) => s.cancelHandler);
	const [confirmingCancel, setConfirmingCancel] = useState(false);
	// The percentage was always computed — useImportUpload pushes it on every
	// onProgress tick — but it only ever reached the 16px ring, and a ring that
	// creeps 1% every few seconds is indistinguishable from a frozen one on a
	// phone. That is what made the owner re-upload a file that was uploading
	// fine (2026-08-17: one file, four uploads in 35 minutes). Print the number;
	// the ring stays as the at-a-glance shape.
	//
	// A status that carries no progress ("parsing"/"creating"/"serverProcessing")
	// used to render a determinate ring frozen at 0 — the exact look of a hung
	// upload. Those now get an indeterminate spinner instead: honest motion, no
	// invented number.
	const percent =
		uploadStatus &&
		(uploadStatus.status === "converting" ||
			uploadStatus.status === "uploadingThumbnail" ||
			uploadStatus.status === "uploadingVideo")
			? uploadStatus.progress
			: null;
	const strokeDashoffset = calculateStrokeDashoffset(percent ?? 0, circumference);

	// Speed/ETA piggyback on the same three progress-carrying statuses. Only
	// rendered when both byte counts are known — never a placeholder, never a
	// guess (see useImportUpload.ts: fewer than 2 samples -> undefined).
	const bytesInfo =
		uploadStatus &&
		(uploadStatus.status === "converting" ||
			uploadStatus.status === "uploadingThumbnail" ||
			uploadStatus.status === "uploadingVideo") &&
		uploadStatus.loadedBytes !== undefined &&
		uploadStatus.totalBytes !== undefined
			? { loaded: uploadStatus.loadedBytes, total: uploadStatus.totalBytes }
			: null;
	const remainingLabel =
		uploadStatus &&
		(uploadStatus.status === "converting" ||
			uploadStatus.status === "uploadingThumbnail" ||
			uploadStatus.status === "uploadingVideo") &&
		uploadStatus.secondsRemaining !== undefined
			? formatRemainingTime(t, getRemainingTimeParts(uploadStatus.secondsRemaining))
			: null;

	// Once every byte is sent, the rest (/complete, progress POST) is moments
	// from "serverProcessing"; a cancel confirmed in that window would delete
	// nothing yet claim it did, so the control goes away as soon as the bytes
	// are all out.
	const allBytesSent =
		uploadStatus?.status === "uploadingVideo" &&
		uploadStatus.loadedBytes !== undefined &&
		uploadStatus.totalBytes !== undefined &&
		uploadStatus.loadedBytes >= uploadStatus.totalBytes;
	const canCancel =
		!!cancelHandler &&
		!!uploadStatus &&
		uploadStatus.status !== "serverProcessing" &&
		!allBytesSent;

	// A confirm left open after cancelling stopped being possible would claim
	// a deletion that cannot happen; close it. Keyed on canCancel only, so
	// ordinary phase changes (parsing -> creating -> uploading) keep it open.
	useEffect(() => {
		if (!canCancel) setConfirmingCancel(false);
	}, [canCancel]);

	if (!uploadStatus) return null;
	return (
		<>
			<div className="flex flex-col gap-4 w-full h-full rounded-xl bg-gray-1 border-gray-3 border-[1px]">
				<div className="overflow-hidden relative w-full bg-black rounded-t-xl border-b border-gray-3 aspect-[16/10] group">
					{uploadStatus.status === "uploadingVideo" ? (
						<img
							src={uploadStatus.thumbnailUrl}
							alt="Uploading thumbnail"
							className="object-cover w-full h-full"
						/>
					) : (
						<div className="flex justify-center items-center w-full h-full">
							<LogoSpinner className="w-8 h-8 animate-spin" />
						</div>
					)}

					<div className="absolute inset-0 transition-all duration-300 bg-black/60"></div>

					{/* Owner order 2026-09-11: cancel a wrong or hung upload without
				    waiting for it to finish or time out on its own. Hidden once
				    server processing has genuinely started (cancelUpload would
				    correctly refuse at that point anyway — this just avoids
				    offering a control that no longer does anything). */}
					{canCancel && (
						<button
							type="button"
							onClick={() => setConfirmingCancel(true)}
							aria-label={t("cancelUploadButton")}
							title={t("cancelUploadButton")}
							className="flex absolute top-0 right-0 justify-center items-center w-11 h-11 text-white group/cancel"
						>
							{/* 44px touch target around the same 28px disc. */}
							<span className="flex justify-center items-center w-7 h-7 rounded-full transition-colors bg-black/50 group-hover/cancel:bg-black/80">
								<svg
									className="w-4 h-4"
									viewBox="0 0 20 20"
									fill="none"
									aria-hidden="true"
								>
									<path
										d="M5 5L15 15M15 5L5 15"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
									/>
								</svg>
							</span>
						</button>
					)}

					<div className="flex absolute right-3 bottom-3 left-3 gap-2 items-end">
						<div className="flex overflow-hidden flex-col flex-1 min-w-0">
							<span className="text-sm font-semibold text-white truncate">
								{getFriendlyStatus(uploadStatus.status)}
								{percent !== null && ` ${Math.round(percent)}%`}
							</span>
							{bytesInfo && (
								<span className="text-xs text-white/80 truncate">
									{formatBytes(bytesInfo.loaded)} / {formatBytes(bytesInfo.total)}
									{remainingLabel && ` · ${remainingLabel}`}
								</span>
							)}
						</div>
						{percent === null ? (
							<svg
								className="w-4 h-4 animate-spin"
								viewBox="0 0 20 20"
								aria-hidden="true"
							>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									className="text-white/30"
								/>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									strokeLinecap="round"
									className="text-white"
									strokeDasharray="12.5 37.5"
								/>
							</svg>
						) : (
							<svg className="w-4 h-4 transform -rotate-90" viewBox="0 0 20 20">
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									className="text-white/30"
								/>
								<circle
									cx="10"
									cy="10"
									r="8"
									stroke="currentColor"
									strokeWidth="3"
									fill="none"
									strokeLinecap="round"
									className="text-white transition-all duration-200 ease-out"
									style={{
										strokeDasharray: `${circumference} ${circumference}`,
										strokeDashoffset: `${strokeDashoffset}`,
									}}
								/>
							</svg>
						)}
					</div>
				</div>
				<div className="flex flex-col flex-grow gap-3 px-4 pb-4 w-full">
					<div>
						<div className="h-[1.25rem] mb-1">
							<div className="h-4 rounded animate-pulse bg-gray-3"></div>
						</div>
						<div className="mb-1 h-[1.25rem]">
							<div className="w-24 h-3 rounded animate-pulse bg-gray-3"></div>
						</div>
						<div className="mb-1 h-[1.5rem]">
							<div className="w-20 h-3 rounded animate-pulse bg-gray-3"></div>
						</div>
					</div>
					<div className="flex gap-4 items-center text-sm text-gray-10">
						<div className="w-16 h-3 rounded animate-pulse bg-gray-3"></div>
					</div>
				</div>
			</div>
			<ConfirmationDialog
				open={confirmingCancel}
				title={t("cancelUploadConfirmTitle")}
				description={t("cancelUploadConfirmDescription")}
				confirmLabel={t("cancelUploadConfirmAction")}
				cancelLabel={t("cancelUploadConfirmCancel")}
				confirmVariant="destructive"
				onConfirm={() => {
					setConfirmingCancel(false);
					if (canCancel) cancelHandler?.();
				}}
				onCancel={() => setConfirmingCancel(false)}
			/>
		</>
	);
};

function getFriendlyStatus(status: UploadStatus["status"]) {
	switch (status) {
		case "parsing":
			return "Parsing";
		case "creating":
			return "Creating";
		case "converting":
			return "Converting";
		case "uploadingThumbnail":
		case "uploadingVideo":
			return "Uploading";
		default:
			return "Processing...";
	}
}
