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

// Height (px) reserved for the sticky share-page notice banner
// (`ShareHeader.tsx` `#share-sticky-notice`, only rendered for an
// owner-not-pro viewer) plus a small breathing gap, so the mobile mini never
// sits flush under — or behind — it. Falls back to a small top gap when the
// banner isn't rendered at all (the common case).
const DOCKED_TOP_FALLBACK_PX = 12;
const DOCKED_TOP_GAP_PX = 8;

/**
 * Measures whatever is currently pinned to the top of the share page (the
 * conditional `#share-sticky-notice` banner in `ShareHeader.tsx`) so the
 * mobile mini-player can sit just below it instead of a hardcoded `top-*`
 * that would either float too high (colliding with the banner) or guess
 * wrong when the banner isn't rendered.
 */
function useDockedTopOffset(): number {
	const [offset, setOffset] = useState(DOCKED_TOP_FALLBACK_PX);

	useEffect(() => {
		const el = document.getElementById("share-sticky-notice");
		if (!el) return;
		const measure = () =>
			setOffset(el.getBoundingClientRect().height + DOCKED_TOP_GAP_PX);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return offset;
}

/**
 * Wraps the video player so it can "dock" into a floating mini-player once
 * the user scrolls it out of view. Only the WRAPPER's CSS position toggles —
 * `children` (the playerBlock) is rendered exactly once and never remounts,
 * so playback keeps working across dock/undock.
 *
 * Docked style (Fable-reviewed 2026-07-14, `docs/plans/2026-07-14-floating-
 * miniplayer-design.md`): VIDEO docks as a floating mini showing the REAL
 * player (full controls, no re-parenting) — mobile top-right below the
 * sticky header, desktop bottom-left. AUDIO docks as a Telegram-style
 * under-header/bottom-left pin bar (no video frame to float).
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
	const dockedTopOffset = useDockedTopOffset();

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
				// Entering/exiting fullscreen from the mini briefly changes layout
				// and can spuriously toggle intersection — ignore while it's active
				// to avoid a dock/undock flap.
				if (document.fullscreenElement) return;
				if (!entry.isIntersecting && entry.boundingClientRect.top < 0) {
					setDocked(true);
				} else if (entry.isIntersecting) {
					setDocked(false);
					setDismissed(false);
				}
			},
			{ threshold: 0 },
		);
		observer.observe(slot);
		return () => observer.disconnect();
	}, []);

	// Whether the wrapper is currently a fixed mini-player (leaves normal flow).
	const dockable = docked;
	// The mini auto-appears the moment playback starts, then stays activated —
	// "scroll down while paused" (after having played) still shows the mini —
	// until the user explicitly dismisses it with ×.
	const showMini = dockable && activated && !dismissed;

	useEffect(() => {
		if (isPlaying) setActivated(true);
	}, [isPlaying]);

	const handleDismiss = useCallback(() => {
		setDismissed(true);
		setActivated(false);
	}, []);

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
		: `transition-all ease-out ${showMini ? "duration-200" : "duration-150"}`;

	const playPauseLabel = isPlaying ? tm("pause") : tm("play");

	// Enter/exit transform: mobile slides down from above (the player exited
	// upward), desktop slides up from below — both settle to identity. Kept as
	// a directional slide (not a plain fade) so the mini reads as "floating in"
	// rather than "installed/stuck".
	const motionClass = showMini
		? "translate-y-0 scale-100 opacity-100"
		: "pointer-events-none -translate-y-2 scale-[0.96] opacity-0 xl:translate-y-2 xl:scale-100";

	// The dock's box styling lives on the inner wrapper (innerRef) itself, NOT
	// on a per-state child element, so `children` can hang off ONE stable host
	// div that never changes type/position → the native <video>/<audio> is
	// never remounted across dock transitions (a remount would restart
	// playback and orphan the dock/transcript/resume listeners). Only CSS
	// toggles on the wrapper (and, for audio only, the host — see below).
	let outerClassName: string;
	if (!dockable) {
		outerClassName = "relative";
	} else if (isAudio) {
		// Telegram-style pin bar: mobile under the sticky header, desktop
		// bottom-left (same quadrant as the video mini, for consistency).
		outerClassName = [
			"fixed inset-x-2 z-50 flex h-12 items-center gap-2.5 rounded-xl border border-gray-5 bg-gray-1/95 px-3 shadow-md backdrop-blur-md",
			"top-[var(--docked-top)]",
			"xl:inset-x-auto xl:left-4 xl:right-auto xl:top-auto xl:bottom-4 xl:max-w-[420px] xl:w-[420px]",
			transitionClass,
			motionClass,
		].join(" ");
	} else {
		// Floating real player: mobile top-right below the sticky header
		// (bottom-right/top-right are both taken on desktop by the AI panel /
		// chat FAB), desktop bottom-left.
		outerClassName = [
			"fixed right-3 z-50 w-[min(230px,60vw)] overflow-hidden rounded-xl ring-1 ring-black/10 shadow-[0_8px_30px_rgba(0,0,0,0.25)] dark:ring-white/15 dark:shadow-[0_8px_30px_rgba(0,0,0,0.55)]",
			"top-[var(--docked-top)]",
			"xl:left-4 xl:right-auto xl:top-auto xl:bottom-4 xl:w-[380px]",
			transitionClass,
			motionClass,
		].join(" ");
	}

	// One stable host for `children` across every state. AUDIO has no video
	// frame to float, so it stays hidden (invisible, behind the pin bar's own
	// chrome) same as before. VIDEO's host gets no special class at all —
	// docked, it simply becomes a normal-flow child of the `fixed` wrapper
	// above, so its own aspect-ratio sizing drives the mini's height and the
	// real player (with all its controls) is what's visible. No re-parenting.
	const playerHostClassName =
		dockable && isAudio
			? "pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-0"
			: undefined;

	return (
		<div
			ref={slotRef}
			className="min-w-0"
			style={dockable && slotHeight ? { minHeight: slotHeight } : undefined}
		>
			<div
				ref={innerRef}
				data-docked={dockable ? "true" : undefined}
				className={outerClassName}
				style={
					dockable
						? ({ "--docked-top": `${dockedTopOffset}px` } as React.CSSProperties)
						: undefined
				}
			>
				{/* One stable host for `children` — never changes type/position, so
				    the native <video>/<audio> is never remounted across dock
				    transitions. */}
				<div className={playerHostClassName}>{children}</div>

				{dockable && !isAudio && (
					// Overlay strip: a SIBLING of the host inside the fixed wrapper
					// (not re-parenting children) — expand top-left, × top-right.
					<div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-black/50 to-transparent">
						<button
							type="button"
							onClick={handleExpand}
							aria-label={t("miniExpand")}
							className="pointer-events-auto absolute left-0 top-0 flex size-10 items-center justify-center text-white/90"
						>
							<ExpandIcon className="size-4" />
						</button>
						<button
							type="button"
							onClick={handleDismiss}
							aria-label={t("miniClose")}
							className="pointer-events-auto absolute right-0 top-0 flex size-10 items-center justify-center text-white/90"
						>
							<CloseIcon className="size-4" />
						</button>
					</div>
				)}

				{dockable && isAudio && (
					<>
						<button
							type="button"
							onClick={togglePlay}
							aria-label={playPauseLabel}
							className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-[var(--brand-fg)] transition-opacity hover:opacity-90"
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
							onClick={handleDismiss}
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
					className={`h-full rounded-full ${variant === "dark" ? "bg-white" : "bg-[var(--brand)]"}`}
					style={{ width: `${progress}%` }}
				/>
			</div>
		</div>
	);
}

function ExpandIcon({ className = "size-3.5" }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className={className}
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

function CloseIcon({ className = "size-3.5" }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className={className}
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
