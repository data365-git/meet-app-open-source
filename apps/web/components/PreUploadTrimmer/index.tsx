"use client";

import { Button } from "@cap/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Timeline } from "./Timeline";
import { shouldUploadOriginal } from "./trim-utils";
import { type TrimMode, useFFmpeg } from "./useFFmpeg";

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

// Above this size, ffmpeg-wasm OOMs on mobile → trim on server instead.
const MAX_CLIENT_TRIM_BYTES = 100 * 1024 * 1024; // ~100MB

type Props = {
	file: File;
	onConfirm: (
		file: File,
		serverTrim?: { inSec: number; outSec: number; duration: number },
	) => void;
	onCancel: () => void;
};

export function PreUploadTrimmer({ file, onConfirm, onCancel }: Props) {
	const videoRef = useRef<HTMLVideoElement>(null);
	const [duration, setDuration] = useState(0);
	const [currentSec, setCurrentSec] = useState(0);
	const [inSec, setInSec] = useState(0);
	const [outSec, setOutSec] = useState(0);
	const [mode, setMode] = useState<TrimMode>("lossless");
	const [trimming, setTrimming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { trim, loading: ffmpegLoading, progress } = useFFmpeg();

	const videoUrl = useMemo(() => URL.createObjectURL(file), [file]);
	useEffect(() => () => URL.revokeObjectURL(videoUrl), [videoUrl]);

	const onLoadedMetadata = () => {
		const v = videoRef.current;
		if (!v) return;
		setDuration(v.duration);
		setOutSec(v.duration);
	};

	const onTimeUpdate = useCallback(() => {
		const v = videoRef.current;
		if (!v) return;
		const t = v.currentTime;
		setCurrentSec(t);
		if (t >= outSec) {
			v.pause();
			v.currentTime = inSec;
		} else if (t < inSec) {
			v.currentTime = inSec;
		}
	}, [inSec, outSec]);

	const seek = (s: number) => {
		const v = videoRef.current;
		if (!v) return;
		v.currentTime = s;
		setCurrentSec(s);
	};

	const togglePlay = useCallback(() => {
		const v = videoRef.current;
		if (!v) return;
		if (v.paused) v.play().catch(() => {});
		else v.pause();
	}, []);

	const uploadingOriginal = shouldUploadOriginal({
		inSec,
		outSec,
		duration,
		fileType: file.type,
		fileName: file.name,
	});
	const serverTrimLarge = !uploadingOriginal && file.size > MAX_CLIENT_TRIM_BYTES;

	const handleConfirm = useCallback(async () => {
		setError(null);
		// No real trim on an already-MP4 source → upload the file as-is and skip
		// the heavy in-browser ffmpeg pass (fast, and never OOMs a big/mobile tab).
		if (
			shouldUploadOriginal({
				inSec,
				outSec,
				duration,
				fileType: file.type,
				fileName: file.name,
			})
		) {
			onConfirm(file);
			return;
		}
		if (file.size > MAX_CLIENT_TRIM_BYTES) {
			onConfirm(file, { inSec, outSec, duration });
			return;
		}
		setTrimming(true);
		try {
			const trimmedFile = await trim(file, inSec, outSec, mode);
			onConfirm(trimmedFile);
		} catch (e) {
			console.error("Trim failed:", e);
			setError(e instanceof Error ? e.message : "Trim failed");
			setTrimming(false);
		}
	}, [trim, file, inSec, outSec, mode, duration, onConfirm]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement) return;
			if (e.key === "i" || e.key === "I")
				setInSec(Math.min(currentSec, outSec - 0.5));
			else if (e.key === "o" || e.key === "O")
				setOutSec(Math.max(currentSec, inSec + 0.5));
			else if (e.key === " ") {
				e.preventDefault();
				togglePlay();
			} else if (e.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [currentSec, inSec, outSec, onCancel, togglePlay]);

	const trimmedDuration = outSec - inSec;
	const originalBytes = file.size;
	const estTrimmedBytes =
		duration > 0
			? Math.round(originalBytes * (trimmedDuration / duration))
			: originalBytes;

	return (
		<div className="fixed inset-0 z-[100] flex items-stretch justify-center bg-black/70 p-0 sm:items-center sm:p-4">
			<div className="flex h-[100dvh] w-full max-w-3xl flex-col overflow-hidden bg-gray-1 sm:h-auto sm:max-h-[90vh] sm:rounded-xl">
				<div className="shrink-0 p-4 border-b border-gray-4 flex justify-between items-center">
					<h2 className="text-lg font-semibold text-gray-12">
						Trim before upload
					</h2>
					<button
						type="button"
						onClick={onCancel}
						className="text-gray-10 hover:text-gray-12"
						aria-label="Close"
					>
						✕
					</button>
				</div>
				<div className="flex-1 min-h-0 space-y-4 overflow-auto p-4 pb-28 sm:pb-4">
					<video
						ref={videoRef}
						src={videoUrl}
						className="w-full max-h-[38dvh] bg-black rounded sm:max-h-[50vh]"
						onLoadedMetadata={onLoadedMetadata}
						onTimeUpdate={onTimeUpdate}
						onClick={togglePlay}
						controls={false}
					>
						<track kind="captions" />
					</video>
					<Timeline
						duration={duration}
						inSec={inSec}
						outSec={outSec}
						currentSec={currentSec}
						onInChange={setInSec}
						onOutChange={setOutSec}
						onSeek={seek}
					/>
					<div className="flex items-center gap-4 text-sm">
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								checked={mode === "lossless"}
								onChange={() => setMode("lossless")}
							/>
							<span>Fast trim, same quality</span>
						</label>
						<label className="flex items-center gap-2 cursor-pointer">
							<input
								type="radio"
								checked={mode === "precise"}
								onChange={() => setMode("precise")}
							/>
							<span>Precise trim, slower</span>
						</label>
					</div>
					<div className="text-xs text-gray-10">
						Original: {Math.floor(duration / 60)}:
						{String(Math.floor(duration % 60)).padStart(2, "0")} (
						{fmtBytes(originalBytes)})
						{trimmedDuration > 0 && trimmedDuration < duration && (
							<>
								{" → "}
								After trim: {Math.floor(trimmedDuration / 60)}:
								{String(Math.floor(trimmedDuration % 60)).padStart(2, "0")} (~
								{fmtBytes(estTrimmedBytes)})
								{originalBytes > estTrimmedBytes && (
									<> — save ~{fmtBytes(originalBytes - estTrimmedBytes)}</>
								)}
							</>
						)}
					</div>
					<p className="hidden text-[11px] text-gray-9 sm:block">
						Shortcuts: <kbd>I</kbd> set in, <kbd>O</kbd> set out,{" "}
						<kbd>Space</kbd> play, <kbd>Esc</kbd> cancel
					</p>
					{trimming && (
						<div className="text-xs text-gray-10">
							{ffmpegLoading
								? "Loading trimmer…"
								: `Trimming… ${Math.round(progress * 100)}%`}
						</div>
					)}
					{error && <div className="text-xs text-red-600">{error}</div>}
				</div>
				<div className="sticky bottom-0 z-10 flex shrink-0 flex-col gap-2 border-t border-gray-4 bg-gray-1 p-4 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] sm:flex-row sm:justify-end">
					<Button
						type="button"
						variant="gray"
						onClick={onCancel}
						disabled={trimming}
						className="w-full sm:w-auto"
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="dark"
						onClick={handleConfirm}
						disabled={trimming || trimmedDuration < 0.5}
						className="w-full sm:w-auto"
					>
						{trimming
							? "Working…"
							: uploadingOriginal
								? "Upload video"
								: serverTrimLarge
									? "Upload & trim on server"
									: "Upload trimmed video"}
					</Button>
				</div>
			</div>
		</div>
	);
}
