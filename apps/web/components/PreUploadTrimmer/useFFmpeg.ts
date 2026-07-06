"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { useCallback, useRef, useState } from "react";

export type TrimMode = "lossless" | "precise";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

export function useFFmpeg() {
	const ffmpegRef = useRef<FFmpeg | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [loading, setLoading] = useState(false);
	const [progress, setProgress] = useState(0);

	const load = useCallback(async () => {
		if (ffmpegRef.current && loaded) return ffmpegRef.current;
		setLoading(true);
		const ffmpeg = new FFmpeg();
		ffmpeg.on("progress", ({ progress: p }) => setProgress(p));
		await ffmpeg.load({
			coreURL: await toBlobURL(
				`${CORE_BASE}/ffmpeg-core.js`,
				"text/javascript",
			),
			wasmURL: await toBlobURL(
				`${CORE_BASE}/ffmpeg-core.wasm`,
				"application/wasm",
			),
		});
		ffmpegRef.current = ffmpeg;
		setLoaded(true);
		setLoading(false);
		return ffmpeg;
	}, [loaded]);

	const trim = useCallback(
		async (
			file: File,
			inSec: number,
			outSec: number,
			mode: TrimMode,
			kind: "video" | "audio" = "video",
		): Promise<File> => {
			const ffmpeg = await load();
			const ext = file.name.split(".").pop() ?? "mp4";
			const inputName = `input.${ext}`;
			const outputName = "output.mp4";
			const audioOutputName = "output.m4a";
			setProgress(0);
			await ffmpeg.writeFile(inputName, await fetchFile(file));
			const duration = Math.max(0.1, outSec - inSec);
			const args =
				kind === "audio"
					? [
							"-ss",
							String(inSec),
							"-i",
							inputName,
							"-t",
							String(duration),
							"-map",
							"0:a:0",
							"-c:a",
							"aac",
							"-b:a",
							"192k",
							"-movflags",
							"+faststart",
							audioOutputName,
						]
					: mode === "lossless"
					? [
							"-ss",
							String(inSec),
							"-i",
							inputName,
							"-t",
							String(duration),
							"-map",
							"0:v:0",
							"-map",
							"0:a?",
							"-c",
							"copy",
							"-avoid_negative_ts",
							"make_zero",
							"-movflags",
							"+faststart",
							outputName,
						]
					: [
							"-i",
							inputName,
							"-ss",
							String(inSec),
							"-t",
							String(duration),
							"-map",
							"0:v:0",
							"-map",
							"0:a?",
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-crf",
							"18",
							"-c:a",
							"aac",
							"-b:a",
							"128k",
							"-movflags",
							"+faststart",
							outputName,
						];
			await ffmpeg.exec(args);
			if (kind === "audio") {
				const data = await ffmpeg.readFile(audioOutputName);
				await ffmpeg.deleteFile(inputName).catch(() => {});
				await ffmpeg.deleteFile(audioOutputName).catch(() => {});
				const bytes = data as Uint8Array;
				const trimmedName = file.name.replace(/(\.[^.]+)?$/, "-trimmed.m4a");
				return new File([bytes], trimmedName, {
					type: "audio/mp4",
				});
			}
			const data = await ffmpeg.readFile(outputName);
			await ffmpeg.deleteFile(inputName).catch(() => {});
			await ffmpeg.deleteFile(outputName).catch(() => {});
			const bytes = data as Uint8Array;
			const trimmedName = file.name.replace(/(\.[^.]+)?$/, "-trimmed.mp4");
			return new File([bytes], trimmedName, {
				type: "video/mp4",
			});
		},
		[load],
	);

	return { load, trim, loaded, loading, progress };
}
