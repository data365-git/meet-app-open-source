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

const POS_STORAGE_KEY = "data365:watchMiniPos";
const POS_MARGIN = 8;

type MiniPos = { x: number; y: number };

function clampPos(p: MiniPos, el: HTMLElement): MiniPos {
	const w = el.offsetWidth;
	const h = el.offsetHeight;
	const maxX = Math.max(POS_MARGIN, window.innerWidth - w - POS_MARGIN);
	const maxY = Math.max(POS_MARGIN, window.innerHeight - h - POS_MARGIN);
	return {
		x: Math.min(Math.max(p.x, POS_MARGIN), maxX),
		y: Math.min(Math.max(p.y, POS_MARGIN), maxY),
	};
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
	// Desktop-only: the mini interferes with reading on a phone (owner
	// 2026-07-14), so on mobile the video just scrolls away in normal flow.
	const [isDesktop, setIsDesktop] = useState(false);
	// User-dragged mini position (YouTube-style, owner 2026-07-14). null =
	// default anchor (bottom-right above the chat FAB). Persisted so the mini
	// reopens where the user left it.
	const [pos, setPos] = useState<MiniPos | null>(null);
	const [dragging, setDragging] = useState(false);
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

	// Invisible double-tap-to-skip over the mini video (owner 2026-07-14: tapping
	// the mini should skip too, no visible buttons). Double-tap left = −10s,
	// right = +10s; a single tap does nothing so it never fights play/pause.
	const miniLastTapRef = useRef<{ side: "left" | "right"; time: number } | null>(
		null,
	);
	const handleMiniTap = useCallback(
		(side: "left" | "right") => {
			const now = Date.now();
			const last = miniLastTapRef.current;
			if (last && last.side === side && now - last.time < 300) {
				miniLastTapRef.current = null;
				if (videoEl && Number.isFinite(videoEl.duration)) {
					const delta = side === "left" ? -10 : 10;
					videoEl.currentTime = Math.min(
						Math.max(0, videoEl.currentTime + delta),
						videoEl.duration,
					);
				}
			} else {
				miniLastTapRef.current = { side, time: now };
			}
		},
		[videoEl],
	);

	// Read the persisted drag position on mount only (SSR-safe). Raw value —
	// it gets clamped to the CURRENT viewport when the mini actually docks
	// (below), so a stale position from a bigger monitor can't strand the
	// mini off-screen (Fable review must-fix #4).
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(POS_STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw) as MiniPos;
				if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
					setPos(parsed);
				}
			}
		} catch {
			// ignore (storage disabled / bad JSON)
		}
	}, []);

	// The AI chat popup (`.ai-popup`, always mounted, `open` class when shown)
	// is fixed at the same bottom-right quadrant (right:26 bottom:104 w:392
	// z:2147483001) and would bury the mini. Track its open state so the
	// mini's DEFAULT anchor slides left of it (Fable review must-fix #1);
	// a user-dragged position is left alone.
	const [chatOpen, setChatOpen] = useState(false);
	useEffect(() => {
		const el = document.querySelector(".ai-popup");
		if (!el) return;
		const sync = () => setChatOpen(el.classList.contains("open"));
		sync();
		const mo = new MutationObserver(sync);
		mo.observe(el, { attributes: true, attributeFilter: ["class"] });
		return () => mo.disconnect();
	}, []);

	useEffect(() => {
		const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduceMotion(mql.matches);
		const onChange = () => setReduceMotion(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, []);

	// Track desktop (>=1024px, the `lg` breakpoint — matches the share page's
	// two-column layout) — the VIDEO mini docks only here.
	useEffect(() => {
		const mql = window.matchMedia("(min-width: 1024px)");
		setIsDesktop(mql.matches);
		const onChange = () => setIsDesktop(mql.matches);
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
	// VIDEO is desktop-only — on a phone the floating frame covers the reading
	// area. AUDIO has no video frame, just a slim Telegram-style pin bar that
	// doesn't block reading, so it docks on every viewport (owner 2026-07-14:
	// "why is there no audio pin [on mobile]").
	const dockable = docked && (isDesktop || isAudio);
	// The mini auto-appears the moment playback starts, then stays activated —
	// "scroll down while paused" (after having played) still shows the mini —
	// until the user explicitly dismisses it with ×.
	const showMini = dockable && activated && !dismissed;

	useEffect(() => {
		if (isPlaying) setActivated(true);
	}, [isPlaying]);

	// When the VIDEO mini floats in the bottom-right corner, flag the body so the
	// chat FAB (styled in ai-chat.css) lifts above it instead of being covered.
	// Audio docks as a top pin bar, so it never sets this.
	useEffect(() => {
		if (showMini && !isAudio) {
			document.body.dataset.miniDocked = "true";
			return () => {
				delete document.body.dataset.miniDocked;
			};
		}
		return undefined;
	}, [showMini, isAudio]);

	const handleDismiss = useCallback(() => {
		setDismissed(true);
		setActivated(false);
	}, []);

	// Clamp the (possibly stale) persisted position into the CURRENT viewport
	// the moment the mini docks — not only on window resize (must-fix #4).
	useEffect(() => {
		if (!dockable || isAudio || !pos) return;
		const el = innerRef.current;
		if (!el) return;
		const clamped = clampPos(pos, el);
		if (clamped.x !== pos.x || clamped.y !== pos.y) setPos(clamped);
	}, [dockable, isAudio, pos]);

	// Keep a dragged position inside the viewport if the window is resized.
	useEffect(() => {
		if (!pos) return;
		const onResize = () => {
			const el = innerRef.current;
			if (!el) return;
			setPos((prev) => (prev ? clampPos(prev, el) : prev));
		};
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [pos]);

	// Drag (YouTube-style, owner 2026-07-14): the whole top gradient strip is
	// the grab surface. Pointer capture keeps the drag alive outside the strip.
	const dragOrigin = useRef<{
		px: number;
		py: number;
		ox: number;
		oy: number;
	} | null>(null);

	const handleStripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		// Presses on the expand/× buttons are clicks, not drags.
		if ((e.target as HTMLElement).closest("button")) return;
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

	const handleStripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const origin = dragOrigin.current;
		const el = innerRef.current;
		if (!origin || !el) return;
		setPos(
			clampPos(
				{
					x: origin.ox + (e.clientX - origin.px),
					y: origin.oy + (e.clientY - origin.py),
				},
				el,
			),
		);
	};

	const handleStripPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
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

	// Dragging suppresses the transition, else the mini rubber-bands 200ms
	// behind the cursor (must-fix #3).
	const transitionClass =
		reduceMotion || dragging
			? ""
			: `transition-all ease-out ${showMini ? "duration-200" : "duration-150"}`;

	const playPauseLabel = isPlaying ? tm("pause") : tm("play");

	// Enter/exit transform: a directional slide + slight scale. The VIDEO mini
	// lives at the bottom → slides up from below; the AUDIO pin lives at the
	// top → slides down from above.
	const hiddenSlide = isAudio ? "-translate-y-2" : "translate-y-2";
	const motionClass = showMini
		? "translate-y-0 scale-100 opacity-100"
		: `pointer-events-none ${hiddenSlide} scale-[0.96] opacity-0`;

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
		// Telegram-style pin bar: full-width at the very top on EVERY viewport
		// (owner screenshot 2026-07-14), sitting just below the sticky notice.
		outerClassName = [
			"fixed inset-x-2 z-50 flex h-12 items-center gap-2.5 rounded-xl border border-gray-5 bg-gray-1/95 px-3 shadow-md backdrop-blur-md",
			"top-[var(--docked-top)]",
			transitionClass,
			motionClass,
		].join(" ");
	} else {
		// Floating real player (YouTube-style, owner spec 2026-07-14): default
		// anchor bottom-right ABOVE the chat FAB (right:26 bottom:26 h:62). When
		// the chat POPUP is open (same quadrant, 392px wide, z above the mini)
		// the default slides left of it. A user-dragged `pos` wins over both via
		// inline top/left (+ right/bottom:auto so the fixed box isn't
		// over-constrained — must-fix #2).
		outerClassName = [
			"fixed z-50 w-[min(230px,60vw)] overflow-hidden rounded-xl ring-1 ring-black/10 shadow-[0_8px_30px_rgba(0,0,0,0.25)] dark:ring-white/15 dark:shadow-[0_8px_30px_rgba(0,0,0,0.55)]",
			// Owner 2026-07-14: pin the mini to the very bottom-right corner. The
			// chat FAB lifts above it (see `data-mini-docked` effect + ai-chat.css)
			// so the two no longer stack the other way around.
			"bottom-[24px]",
			chatOpen ? "right-[434px]" : "right-4",
			"lg:w-[480px]",
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
						? isAudio
							? ({
									"--docked-top": `${dockedTopOffset}px`,
								} as React.CSSProperties)
							: pos
								? {
										top: pos.y,
										left: pos.x,
										right: "auto",
										bottom: "auto",
									}
								: undefined
						: undefined
				}
			>
				{/* One stable host for `children` — never changes type/position, so
				    the native <video>/<audio> is never remounted across dock
				    transitions. */}
				<div className={playerHostClassName}>{children}</div>

				{dockable && !isAudio && (
					// Overlay strip: a SIBLING of the host inside the fixed wrapper
					// (not re-parenting children). The WHOLE strip is the drag
					// surface (pointer-events-auto + touch-none, must-fix #3);
					// expand top-left, × top-right (their presses don't start a
					// drag — filtered in handleStripPointerDown).
					<div
						onPointerDown={handleStripPointerDown}
						onPointerMove={handleStripPointerMove}
						onPointerUp={handleStripPointerUp}
						onPointerCancel={handleStripPointerUp}
						className={`absolute inset-x-0 top-0 z-10 h-10 touch-none bg-gradient-to-b from-black/50 to-transparent ${
							dragging ? "cursor-grabbing" : "cursor-grab"
						}`}
					>
						<button
							type="button"
							onClick={handleExpand}
							aria-label={t("miniExpand")}
							className="absolute left-0 top-0 flex size-10 items-center justify-center text-white/90"
						>
							<ExpandIcon className="size-4" />
						</button>
						<button
							type="button"
							onClick={handleDismiss}
							aria-label={t("miniClose")}
							className="absolute right-0 top-0 flex size-10 items-center justify-center text-white/90"
						>
							<CloseIcon className="size-4" />
						</button>
					</div>
				)}

				{dockable && !isAudio && (
					// Invisible double-tap-to-skip zones over the mini's video area.
					// Sits between the top drag strip (h-10) and the bottom transport
					// so it never blocks those; single tap is a no-op.
					<div className="absolute inset-x-0 bottom-12 top-10 z-[5] flex">
						<button
							type="button"
							aria-label={tm("skipBack", { seconds: 10 })}
							className="h-full flex-1 cursor-default"
							onClick={() => handleMiniTap("left")}
						/>
						<button
							type="button"
							aria-label={tm("skipForward", { seconds: 10 })}
							className="h-full flex-1 cursor-default"
							onClick={() => handleMiniTap("right")}
						/>
					</div>
				)}

				{dockable && !isAudio && (
					// Persistent bottom transport strip: owner (2026-07-14) wants the
					// timeline ALWAYS visible in the mini (scrub + see position) —
					// media-chrome's own control bar auto-hides after inactivity and is
					// suppressed while docked (docked-chrome.css). Play/pause + slim
					// seek + time, driven straight off the native <video>.
					<div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center gap-2 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-2.5 pb-1.5 pt-6">
						<button
							type="button"
							onClick={togglePlay}
							aria-label={playPauseLabel}
							className="pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-sm transition-colors hover:bg-white/25"
						>
							{isPlaying ? <PauseIcon /> : <PlayIcon />}
						</button>
						<div className="pointer-events-auto min-w-0 flex-1">
							<DockSeekBar
								videoEl={videoEl}
								currentTime={currentTime}
								duration={duration}
								variant="dark"
							/>
						</div>
						<span className="shrink-0 text-[11px] tabular-nums text-white/90">
							{formatMmSs(currentTime)} / {formatMmSs(duration)}
						</span>
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
			{/* Visible draggable handle (owner 2026-07-14): without a dot the mini
			    timeline reads as a static bar — the knob shows it can be grabbed and
			    dragged like the main player's scrubber. */}
			<span
				aria-hidden="true"
				className={`pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full shadow ${
					variant === "dark" ? "bg-white" : "bg-[var(--brand)]"
				}`}
				style={{ left: `${progress}%` }}
			/>
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
