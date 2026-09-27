"use client";

import { faArrowLeft, faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Link from "next/link";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { PreUploadTrimmer } from "@/components/PreUploadTrimmer";
import { UpgradeModal } from "@/components/UpgradeModal";
import { IMPORT_FILE_ACCEPT, useImportUpload } from "./useImportUpload";

export const ImportFilePage = ({ folderId }: { folderId?: string }) => {
	const {
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
	} = useImportUpload({ folderId });
	const [isDragOver, setIsDragOver] = useState(false);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setIsDragOver(false);
			const file = e.dataTransfer.files[0];
			if (!file) return;

			const isMedia =
				file.type.startsWith("video/") ||
				file.type.startsWith("audio/") ||
				/\.(mov|mp4|avi|mkv|webm|m4v|mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i.test(
					file.name,
				);
			if (!isMedia) {
				toast.error("Please drop a video or audio file.");
				return;
			}
			setPendingFile(file);
		},
		[setPendingFile],
	);

	return (
		<div className="flex flex-col w-full h-full">
			<div className="mb-8">
				<Link
					href="/dashboard/import"
					className="inline-flex gap-2 items-center text-sm text-gray-10 hover:text-gray-12 transition-colors mb-4"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Back to Import
				</Link>
				<h1 className="text-2xl font-medium text-gray-12">Upload File</h1>
				<p className="mt-1 text-sm text-gray-10">
					Upload a video or audio file from your device.
				</p>
			</div>

			<button
				type="button"
				disabled={isUploading}
				onClick={openFilePicker}
				onDragOver={(e) => {
					e.preventDefault();
					if (!isUploading) setIsDragOver(true);
				}}
				onDragLeave={() => setIsDragOver(false)}
				onDrop={handleDrop}
				className={`relative flex flex-col items-center justify-center w-full max-w-2xl rounded-xl border-2 border-dashed transition-all duration-200 py-16 px-8 ${
					isUploading
						? "border-gray-4 bg-gray-2 cursor-not-allowed"
						: isDragOver
							? "border-blue-10 bg-blue-3"
							: "border-gray-4 bg-gray-1 hover:border-gray-6 hover:bg-gray-2"
				}`}
			>
				{isUploading ? (
					<span className="flex flex-col items-center gap-4">
						<span className="flex items-center justify-center size-16 rounded-full bg-gray-3">
							<span className="size-6 border-2 border-gray-8 border-t-blue-10 rounded-full animate-spin" />
						</span>
						<span className="flex flex-col items-center gap-1">
							<span className="text-sm font-medium text-gray-12">
								{statusLabel}
							</span>
							{progressPercent !== null && (
								<span className="w-48 h-1.5 rounded-full bg-gray-4 mt-2 overflow-hidden">
									<span
										className="h-full rounded-full bg-blue-10 transition-all duration-300"
										style={{ width: `${progressPercent}%` }}
									/>
								</span>
							)}
						</span>
					</span>
				) : (
					<span className="flex flex-col items-center gap-4">
						<span className="flex items-center justify-center size-16 rounded-full bg-gray-3 text-gray-10">
							<FontAwesomeIcon className="size-6" icon={faUpload} />
						</span>
						<span className="flex flex-col items-center gap-1">
							<span className="text-sm font-medium text-gray-12">
								Drag and drop your video or audio here
							</span>
							<span className="text-xs text-gray-10">
								Video (MP4, MOV, MKV, WebM) or audio (MP3, WAV, M4A) — any size
							</span>
						</span>
						<span className="inline-flex items-center justify-center mt-2 h-8 px-3 rounded-full bg-gray-12 text-sm font-medium text-gray-1">
							Browse Files
						</span>
					</span>
				)}
			</button>

			<input
				ref={inputRef}
				type="file"
				accept={IMPORT_FILE_ACCEPT}
				multiple
				onChange={handleFileChange}
				className="hidden"
			/>

			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>

			{pendingFile && (
				<PreUploadTrimmer
					file={pendingFile}
					onConfirm={(trimmed, serverTrim) => {
						setPendingFile(null);
						void processFile(trimmed, serverTrim);
					}}
					onCancel={() => setPendingFile(null)}
				/>
			)}
		</div>
	);
};
