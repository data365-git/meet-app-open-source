"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMmSs } from "./video/SegmentedProgressBar";

interface DockedMediaState {
	videoEl: HTMLVideoElement | null;
	isPlaying: boolean;
	currentTime: number;
	duration: number;
}

/**
 * Tracks the native <video> mounted inside `children` (via querySelector,
 * since it lives in a sibling React subtree we don't own — media-chrome's
 * own dispatch/context isn't reachable from here) and mirrors play state +
 * time/duration so the dock's own transport controls can drive it directly.
 */
function useDockedMediaState(
	innerRef: React.RefObject<HTMLDivElement | null>,
): DockedMediaState {
	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);

	useEffect(() => {
		let video: HTMLVideoElement | null = null;
		let raf = 0;
		const syncPlaying = () => {
			if (video) setIsPlaying(!video.paused && !video.ended);
		};
		const syncTime = () => {
			if (video) setCurrentTime(video.currentTime);
		};
		const syncDuration = () => {
			if (video && Number.isFinite(video.duration) && video.duration > 0) {
				setDuration(video.duration);
			}
		};
		const attach = () => {
			const el = innerRef.current?.querySelector("video");
			if (!el) {
				raf = requestAnimationFrame(attach);
				return;
			}
			video = el;
			setVideoEl(el);
			el.addEventListener("play", syncPlaying);
			el.addEventListener("playing", syncPlaying);
			el.addEventListener("pause", syncPlaying);
			el.addEventListener("ended", syncPlaying);
			el.addEventListener("timeupdate", syncTime);
			el.addEventListener("loadedmetadata", syncDuration);
			syncPlaying();
			syncTime();
			syncDuration();
		};
		attach();
		return () => {
			cancelAnimationFrame(raf);
			if (video) {
				video.removeEventListener("play", syncPlaying);
				video.removeEventListener("playing", syncPlaying);
				video.removeEventListener("pause", syncPlaying);
				video.removeEventListener("ended", syncPlaying);
				video.removeEventListener("timeupdate", syncTime);
				video.removeEventListener("loadedmetadata", syncDuration);
			}
		};
	}, [innerRef]);

	return { videoEl, isPlaying, currentTime, duration };
}

/**
 * Wraps the video player so it can "dock" into a fixed mini-player once the
 * user scrolls it out of view. Only the WRAPPER's CSS position toggles —
 * `children` (the playerBlock) is rendered exactly once and never remounts,
 * so playback keeps working across dock/undock.
 *
 * Docked style (owner decision 2026-07-13): on EVERY viewport the dock is a
 * slim bottom bar with NO video pixels — just play/pause + a seekable
 * progress bar + time (+ title). A floating video box would cover the AI
 * analysis the user is reading, so docking never shows the video frame.
 * `children` stays mounted (invisible) for playback continuity.
 */
export function DockableVideo({
	children,
	isAudio = false,
	title,
}: {
	children: React.ReactNode;
	isAudio?: boolean;
	title?: string;
}) {
	const t = useTranslations("share");
	const tm = useTranslations("mediaPlayer");
	const slotRef = useRef<HTMLDivElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const [docked, setDocked] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [activated, setActivated] = useState(false);
	const [slotHeight, setSlotHeight] = useState<number | null>(null);
	const [reduceMotion, setReduceMotion] = useState(false);

	const { videoEl, isPlaying, currentTime, duration } =
		useDockedMediaState(innerRef);

	const togglePlay = useCallback(() => {
		if (!videoEl) return;
		if (videoEl.paused || videoEl.ended) {
			void videoEl.play().catch(() => {});
		} else {
			videoEl.pause();
		}
	}, [videoEl]);

	useEffect(() => {
		const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduceMotion(mql.matches);
		const onChange = () => setReduceMotion(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	useEffect(() => {
		const slot = slotRef.current;
		if (!slot) return;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
					setDocked(true);
				} else if (entry.isIntersecting) {
					setDocked(false);
					setDismissed(false);
					setActivated(false);
				}
			},
			{ threshold: 0 },
		);
		observer.observe(slot);
		return () => observer.disconnect();
	}, []);

	// Whether the wrapper is currently a fixed mini-player (leaves normal flow).
	const dockable = docked;
	// The mini auto-appears the moment playback starts while docked, then stays
	// (owner choice B): pausing keeps it so the user can resume; only × or
	// scrolling the main player back into view hides it.
	const showMini = dockable && activated && !dismissed;

	useEffect(() => {
		if (dockable && isPlaying) setActivated(true);
	}, [dockable, isPlaying]);

	// Measure the player's inline (non-docked) height so the slot can reserve
	// that space via min-height once the inner wrapper becomes `fixed` and
	// leaves normal flow — otherwise the content below jumps up.
	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;
		const measure = () => {
			if (!dockable) setSlotHeight(inner.getBoundingClientRect().height);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(inner);
		return () => ro.disconnect();
	}, [dockable]);

	const handleExpand = () => {
		slotRef.current?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};

	const transitionClass = reduceMotion
		? ""
		: "transition-all duration-[180ms] ease-out";

	const playPauseLabel = isPlaying ? tm("pause") : tm("play");

	// The dock's box styling lives on the inner wrapper (innerRef) itself, NOT
	// on a per-state child element, so `children` can hang off ONE stable host
	// div that never changes type/position → the native <video> is never
	// remounted across dock transitions (a remount would restart playback and
	// orphan the dock/transcript/resume listeners). Only CSS toggles.
	const outerClassName = !dockable
		? `relative ${transitionClass}`
		: `fixed inset-x-2 bottom-2 z-50 flex items-center gap-2.5 rounded-2xl border border-gray-5 bg-gray-1/95 px-3 py-2 shadow-lg backdrop-blur-md sm:inset-x-auto sm:right-4 sm:w-[380px] ${transitionClass} ${
				showMini
					? "translate-y-0 opacity-100"
					: "pointer-events-none translate-y-3 opacity-0"
			}`;

	// One stable host for `children` across every state (see above). Docked, it
	// is absolutely positioned behind the bar chrome and hidden (opacity-0) —
	// the bar never shows video pixels; undocked, plain flow.
	const playerHostClassName = !dockable
		? undefined
		: "pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-0";

	return (
		<div
			ref={slotRef}
			className="min-w-0"
			style={dockable && slotHeight ? { minHeight: slotHeight } : undefined}
		>
			<div ref={innerRef} className={outerClassName}>
				{/* One stable host for `children` — never changes type/position, so
				    the native <video> is never remounted across dock transitions. */}
				<div className={playerHostClassName}>{children}</div>

				{dockable && (
					<>
						<button
							type="button"
							onClick={togglePlay}
							aria-label={playPauseLabel}
							className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white transition-colors hover:bg-blue-600"
						>
							{isPlaying ? <PauseIcon /> : <PlayIcon />}
						</button>
						<div className="min-w-0 flex-1">
							{title && (
								<p className="truncate text-xs font-medium text-gray-12">
									{title}
								</p>
							)}
							<div className="flex items-center gap-2">
								<DockSeekBar
									videoEl={videoEl}
									currentTime={currentTime}
									duration={duration}
									variant="light"
								/>
								<span className="shrink-0 text-[11px] tabular-nums text-gray-10">
									{formatMmSs(currentTime)} / {formatMmSs(duration)}
								</span>
							</div>
						</div>
						<button
							type="button"
							onClick={handleExpand}
							aria-label={t("miniExpand")}
							className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
						>
							<ExpandIcon />
						</button>
						<button
							type="button"
							onClick={() => setDismissed(true)}
							aria-label={t("miniClose")}
							className="flex size-7 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
						>
							<CloseIcon />
						</button>
					</>
				)}
			</div>
		</div>
	);
}

/** Simple draggable seek track driving the native <video> directly (no
 * media-chrome dispatch — this component sits outside that context). */
function DockSeekBar({
	videoEl,
	currentTime,
	duration,
	variant,
}: {
	videoEl: HTMLVideoElement | null;
	currentTime: number;
	duration: number;
	variant: "light" | "dark";
}) {
	const trackRef = useRef<HTMLDivElement>(null);
	const draggingRef = useRef(false);

	const seek = useCallback(
		(clientX: number) => {
			const el = trackRef.current;
			if (!el || !videoEl || !(duration > 0)) return;
			const rect = el.getBoundingClientRect();
			const ratio = Math.max(
				0,
				Math.min((clientX - rect.left) / rect.width, 1),
			);
			videoEl.currentTime = ratio * duration;
		},
		[videoEl, duration],
	);

	const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
		draggingRef.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		seek(e.clientX);
	};
	const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (draggingRef.current) seek(e.clientX);
	};
	const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
		draggingRef.current = false;
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			// ignore
		}
	};

	const progress =
		duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

	return (
		<div
			ref={trackRef}
			className="relative flex h-4 w-full cursor-pointer touch-none select-none items-center"
			onPointerDown={onDown}
			onPointerMove={onMove}
			onPointerUp={onUp}
			onPointerCancel={onUp}
		>
			<div
				className={`h-1 w-full overflow-hidden rounded-full ${
					variant === "dark" ? "bg-white/25" : "bg-gray-6"
				}`}
			>
				<div
					className={`h-full rounded-full ${variant === "dark" ? "bg-white" : "bg-blue-500"}`}
					style={{ width: `${progress}%` }}
				/>
			</div>
		</div>
	);
}

function ExpandIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-3.5"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden="true"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M4 14v6h6M20 10V4h-6M20 4l-7 7M4 20l7-7"
			/>
		</svg>
	);
}

function CloseIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-3.5"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden="true"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M6 6l12 12M18 6 6 18"
			/>
		</svg>
	);
}

function PlayIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-4"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M8 5v14l11-7z" />
		</svg>
	);
}

function PauseIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-4"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M7 5h4v14H7zM13 5h4v14h-4z" />
		</svg>
	);
}
