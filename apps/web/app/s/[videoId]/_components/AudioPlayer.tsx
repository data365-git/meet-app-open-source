"use client";

import { AudioLines } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/app/lib/utils";
import {
	MediaPlayerPlay,
	MediaPlayerPlaybackSpeed,
	MediaPlayerPlaybackSpeedDial,
	MediaPlayerTime,
	MediaPlayerVolume,
} from "./video/media-player";
import { SegmentedProgressBar } from "./video/SegmentedProgressBar";
import { SkipButton, useSkipStep } from "./video/SkipControls";

const DOUBLE_TAP_MS = 300;
const FLASH_MS = 600;

type TapSide = "left" | "right";

interface Chapter {
	startSec: number;
	title: string;
}

interface AudioPlayerChromeProps {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	videoName?: string;
	duration: number;
	chapters?: Chapter[];
	defaultPlaybackSpeed?: number;
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
	defaultPlaybackSpeed,
}: AudioPlayerChromeProps) {
	const [skipSeconds, setSkipSeconds] = useSkipStep();
	// Invisible double-tap-to-skip supplements the visible controls on touch.
	// These gesture zones stay out of keyboard and screen-reader navigation.
	const lastTapRef = useRef<{ side: TapSide; time: number } | null>(null);
	const [flashSide, setFlashSide] = useState<TapSide | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		};
	}, []);

	const handleTap = useCallback(
		(side: TapSide) => {
			const now = Date.now();
			const last = lastTapRef.current;
			if (last && last.side === side && now - last.time < DOUBLE_TAP_MS) {
				lastTapRef.current = null;
				const v = videoRef.current;
				if (v && Number.isFinite(v.duration)) {
					const delta = side === "left" ? -skipSeconds : skipSeconds;
					v.currentTime = Math.min(
						Math.max(0, v.currentTime + delta),
						v.duration,
					);
				}
				setFlashSide(side);
				if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
				flashTimerRef.current = setTimeout(() => setFlashSide(null), FLASH_MS);
			} else {
				lastTapRef.current = { side, time: now };
			}
		},
		[videoRef, skipSeconds],
	);

	// Visible selectable skip controls flank Play; touch double-tap uses the
	// same persisted step.
	return (
		<div className="absolute inset-0 z-[5] flex flex-col justify-between gap-3 rounded-xl bg-[linear-gradient(135deg,var(--brand)_0%,#003c74_100%)] p-4 sm:gap-4 sm:p-6">
			{/* Hidden: only mounted to apply the default playback speed via the
			 * same mount effect the video player's speed dial uses (never shown). */}
			<MediaPlayerPlaybackSpeedDial
				defaultSpeed={defaultPlaybackSpeed}
				show={false}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
				<div className="pointer-events-none flex w-full max-w-[85%] items-center justify-center gap-3">
					<div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-white/10">
						<AudioLines className="size-7 text-white/85" />
					</div>
					{videoName && (
						<p className="min-w-0 line-clamp-2 text-left text-sm font-semibold text-white sm:text-lg">
							{videoName}
						</p>
					)}
				</div>

				{/* Invisible double-tap zones use the selected step. */}
				<div className="absolute inset-0 flex">
					<button
						type="button"
						aria-hidden="true"
						tabIndex={-1}
						className="h-full flex-1"
						onClick={() => handleTap("left")}
					/>
					<button
						type="button"
						aria-hidden="true"
						tabIndex={-1}
						className="h-full flex-1"
						onClick={() => handleTap("right")}
					/>
				</div>

				{flashSide && (
					<span
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-1 text-sm text-white",
							flashSide === "left" ? "left-[15%]" : "right-[15%]",
						)}
					>
						{flashSide === "left" ? `-${skipSeconds}s` : `+${skipSeconds}s`}
					</span>
				)}
			</div>

			<div className="flex flex-col gap-1.5">
				<SegmentedProgressBar
					chapters={chapters}
					duration={duration}
					videoRef={videoRef}
				/>
				<div className="flex items-center gap-2">
					<MediaPlayerTime fallbackDuration={duration} />
					<div className="flex-1" />
					<SkipButton
						videoRef={videoRef}
						direction="back"
						step={skipSeconds}
						onStepChange={setSkipSeconds}
						className="text-white hover:bg-white/15"
					/>
					<MediaPlayerPlay className="size-11 text-white hover:bg-white/15" />
					<SkipButton
						videoRef={videoRef}
						direction="forward"
						step={skipSeconds}
						onStepChange={setSkipSeconds}
						className="text-white hover:bg-white/15"
					/>
					<div className="flex-1" />
					<MediaPlayerPlaybackSpeed className="text-white hover:bg-white/15" />
					<MediaPlayerVolume expandable />
				</div>
			</div>
		</div>
	);
}
