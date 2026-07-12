"use client";

import { AudioLines } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/app/lib/utils";
import {
	MediaPlayerPlay,
	MediaPlayerPlaybackSpeed,
	MediaPlayerTime,
	MediaPlayerVolume,
} from "./video/media-player";
import { SegmentedProgressBar } from "./video/SegmentedProgressBar";

interface Chapter {
	startSec: number;
	title: string;
}

interface AudioPlayerChromeProps {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	videoName?: string;
	duration: number;
	chapters?: Chapter[];
}

/**
 * Dedicated audio transport for `metadata.isAudio` content (T4a). The
 * underlying element is still the same <video> that powers playback
 * elsewhere in the app (videoRef, DockableVideo, resume-position, etc. all
 * depend on it) — this just renders a calm, audio-native face on top of it
 * instead of the video-oriented gradient overlay, reusing the same
 * media-chrome atoms (play, time, speed, volume) so behavior stays
 * consistent. No fullscreen/PiP/captions — those are video-only concepts.
 */
export function AudioPlayerChrome({
	videoRef,
	videoName,
	duration,
	chapters = [],
}: AudioPlayerChromeProps) {
	const [isPlaying, setIsPlaying] = useState(false);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		const sync = () => setIsPlaying(!video.paused && !video.ended);
		video.addEventListener("play", sync);
		video.addEventListener("pause", sync);
		video.addEventListener("ended", sync);
		sync();
		return () => {
			video.removeEventListener("play", sync);
			video.removeEventListener("pause", sync);
			video.removeEventListener("ended", sync);
		};
	}, [videoRef.current]);

	return (
		<div className="absolute inset-0 z-[5] flex flex-col justify-between gap-3 rounded-xl bg-[linear-gradient(135deg,var(--brand)_0%,#003c74_100%)] p-4 sm:gap-4 sm:p-6">
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
				<div className="flex size-14 items-center justify-center rounded-full bg-white/10 sm:size-20">
					<AudioLines className="size-7 text-white/85 sm:size-10" />
				</div>
				{videoName && (
					<p className="line-clamp-2 max-w-[85%] text-center text-sm font-semibold text-white sm:text-lg">
						{videoName}
					</p>
				)}
				<AudioLevelBars playing={isPlaying} />
			</div>

			<div className="flex flex-col gap-1.5">
				<SegmentedProgressBar
					chapters={chapters}
					duration={duration}
					videoRef={videoRef}
				/>
				<div className="flex items-center gap-2">
					<MediaPlayerPlay className="size-8 text-white hover:bg-white/15" />
					<MediaPlayerTime fallbackDuration={duration} />
					<div className="flex-1" />
					<MediaPlayerPlaybackSpeed className="text-white hover:bg-white/15" />
					<MediaPlayerVolume expandable />
				</div>
			</div>
		</div>
	);
}

/** Purely decorative "level bar" — no real audio analysis, just a calm
 * breathing animation while playing (kept simple on purpose). */
function AudioLevelBars({ playing }: { playing: boolean }) {
	const heights = ["h-2", "h-4", "h-5", "h-3", "h-2"];
	return (
		<div className="flex items-end gap-1" aria-hidden="true">
			{heights.map((h, i) => (
				<span
					key={h}
					className={cn(
						"w-1 rounded-full bg-white/70",
						h,
						playing && "animate-pulse",
					)}
					style={playing ? { animationDelay: `${i * 120}ms` } : undefined}
				/>
			))}
		</div>
	);
}
