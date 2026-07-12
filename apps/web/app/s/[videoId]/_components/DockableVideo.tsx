"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatMmSs } from "./video/SegmentedProgressBar";

const POS_STORAGE_KEY = "data365:watchMiniPos";
const MARGIN = 8;
// Below this viewport width the corner video-frame dock has no room to be
// useful — style falls back to the controls-only strip (see showBarStyle).
const DESKTOP_BREAKPOINT = "(min-width: 1024px)";

type Pos = { x: number; y: number };

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
 * Two docked styles (owner decision 2026-07-11):
 * - Desktop (≥1024px) + video: a bigger floating corner box that still shows
 *   the video frame, with its OWN always-on play/pause + seek bar overlay
 *   (the full video chrome is too cramped to stay usable at this size).
 * - Everything else (mobile, or any audio) — a slim sticky top strip with
 *   NO video pixels, just play/pause + a seekable progress bar + time (+
 *   title). `children` stays mounted (invisible) for playback continuity.
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
	const [isDesktop, setIsDesktop] = useState(false);
	const [pos, setPos] = useState<Pos | null>(null);
	const [dragging, setDragging] = useState(false);
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

	// Style breakpoint: only a desktop-sized viewport has room for the
	// video-frame corner box; below it (and always for audio) we use the
	// controls-only strip.
	useEffect(() => {
		const mql = window.matchMedia(DESKTOP_BREAKPOINT);
		setIsDesktop(mql.matches);
		const onChange = () => setIsDesktop(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	// Read persisted drag position on mount only (SSR-safe).
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(POS_STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as Pos;
				if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
					setPos(parsed);
				}
			}
		} catch {
			// ignore (e.g. storage disabled / bad JSON)
		}
	}, []);

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
	// Video gets the roomier corner box only on desktop; mobile video and
	// ALL audio use the compact controls-only strip (no video pixels).
	const showBarStyle = isAudio || !isDesktop;
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

	// Keep a dragged position inside the viewport if the window is resized.
	useEffect(() => {
		if (!pos) return;
		const clampToViewport = () => {
			const el = innerRef.current;
			if (!el) return;
			setPos((prev) => (prev ? clampPos(prev, el) : prev));
		};
		window.addEventListener("resize", clampToViewport);
		return () => window.removeEventListener("resize", clampToViewport);
	}, [pos]);

	const dragOrigin = useRef<{
		px: number;
		py: number;
		ox: number;
		oy: number;
	} | null>(null);

	const handleMovePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
		const el = innerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		dragOrigin.current = {
			px: e.clientX,
			py: e.clientY,
			ox: rect.left,
			oy: rect.top,
		};
		setDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const handleMovePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
		const origin = dragOrigin.current;
		const el = innerRef.current;
		if (!origin || !el) return;
		const next = clampPos(
			{
				x: origin.ox + (e.clientX - origin.px),
				y: origin.oy + (e.clientY - origin.py),
			},
			el,
		);
		setPos(next);
	};

	const handleMovePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
		if (!dragOrigin.current) return;
		dragOrigin.current = null;
		setDragging(false);
		try {
			e.currentTarget.releasePointerCapture(e.pointerId);
		} catch {
			// ignore
		}
		setPos((prev) => {
			if (prev) {
				try {
					window.localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(prev));
				} catch {
					// ignore
				}
			}
			return prev;
		});
	};

	const handleExpand = () => {
		slotRef.current?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};

	const transitionClass =
		reduceMotion || dragging ? "" : "transition-all duration-[180ms] ease-out";

	// Default anchor (top-right) unless the user has dragged it somewhere —
	// only meaningful for the draggable corner box style.
	const positionStyle: React.CSSProperties | undefined = pos
		? { top: pos.y, left: pos.x, right: "auto" }
		: undefined;

	const playPauseLabel = isPlaying ? tm("pause") : tm("play");

	const outerClassName = !dockable
		? `relative ${transitionClass}`
		: showBarStyle
			? `fixed inset-x-2 top-2 z-50 sm:inset-x-auto sm:right-4 sm:w-[380px] ${transitionClass} ${
					showMini
						? "translate-y-0 opacity-100"
						: "pointer-events-none -translate-y-3 opacity-0"
				}`
			: `fixed z-50 w-[min(360px,55vw)] ${pos ? "" : "top-4 right-4"} ${transitionClass} ${
					showMini
						? "translate-y-0 opacity-100"
						: "pointer-events-none -translate-y-2 opacity-0"
				}`;

	return (
		<div
			ref={slotRef}
			className="min-w-0"
			style={dockable && slotHeight ? { minHeight: slotHeight } : undefined}
		>
			<div
				ref={innerRef}
				style={dockable && !showBarStyle ? positionStyle : undefined}
				className={outerClassName}
			>
				{!dockable ? (
					children
				) : showBarStyle ? (
					<div className="relative flex items-center gap-2.5 rounded-2xl border border-gray-5 bg-gray-1/95 px-3 py-2 shadow-lg backdrop-blur-md">
						{/* Mounted for playback continuity only — no visible frame on
						    the strip (owner: no video pixels on mobile/audio dock). */}
						<div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-0">
							{children}
						</div>
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
					</div>
				) : (
					<div className="relative aspect-video overflow-hidden rounded-xl shadow-lg ring-1 ring-black/10">
						{/* Frame stays visible (desktop has room for it) but inert —
						    the full video chrome is too cramped at this size to stay
						    usable, so our own overlay below drives play/pause + seek. */}
						<div className="pointer-events-none">{children}</div>
						<div className="absolute right-2 top-2 z-40 flex items-center gap-1">
							<button
								type="button"
								aria-label={t("miniMove")}
								onPointerDown={handleMovePointerDown}
								onPointerMove={handleMovePointerMove}
								onPointerUp={handleMovePointerUp}
								onPointerCancel={handleMovePointerUp}
								className={`inline-flex size-6 touch-none items-center justify-center rounded-md border border-white/15 text-white/80 shadow-sm backdrop-blur-sm transition-colors ${
									dragging
										? "cursor-grabbing bg-black/80 text-white"
										: "cursor-grab bg-black/65 hover:bg-black/80 hover:text-white"
								}`}
							>
								<MoveIcon />
							</button>
							<button
								type="button"
								aria-label={t("miniExpand")}
								onClick={handleExpand}
								className="inline-flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
							>
								<ExpandIcon />
							</button>
							<button
								type="button"
								aria-label={t("miniClose")}
								onClick={() => setDismissed(true)}
								className="inline-flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
							>
								<CloseIcon />
							</button>
						</div>
						<div className="absolute inset-x-0 bottom-0 z-40 flex items-center gap-2 bg-black/70 px-3 py-2 backdrop-blur-sm">
							<button
								type="button"
								onClick={togglePlay}
								aria-label={playPauseLabel}
								className="flex size-7 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/15"
							>
								{isPlaying ? <PauseIcon /> : <PlayIcon />}
							</button>
							<DockSeekBar
								videoEl={videoEl}
								currentTime={currentTime}
								duration={duration}
								variant="dark"
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

/** Simple draggable seek track driving the native <video> directly (no
 * media-chrome dispatch — this component sits outside that context). Used
 * by both docked styles. */
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

function clampPos(p: Pos, el: HTMLElement): Pos {
	const w = el.offsetWidth;
	const h = el.offsetHeight;
	const maxX = Math.max(MARGIN, window.innerWidth - w - MARGIN);
	const maxY = Math.max(MARGIN, window.innerHeight - h - MARGIN);
	return {
		x: Math.min(Math.max(p.x, MARGIN), maxX),
		y: Math.min(Math.max(p.y, MARGIN), maxY),
	};
}

function MoveIcon() {
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
				d="M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3"
			/>
		</svg>
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
