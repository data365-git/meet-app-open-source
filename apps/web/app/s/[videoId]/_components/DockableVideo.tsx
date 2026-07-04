"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

const POS_STORAGE_KEY = "data365:watchMiniPos";
const MARGIN = 8;

type Pos = { x: number; y: number };

/**
 * Wraps the video player so it can "dock" into a fixed mini-player once the
 * user scrolls it out of view. Only the WRAPPER's CSS position toggles —
 * `children` (the playerBlock) is rendered exactly once and never remounts,
 * so playback (and transcript seek sync via videoRef) keeps working.
 *
 * The mini-player only appears on desktop (≥1024px) AND while the video is
 * actually playing. It has no pin: instead a move handle lets the user drag
 * it anywhere, and an × dismisses it.
 */
export function DockableVideo({ children }: { children: React.ReactNode }) {
	const t = useTranslations("share");
	const slotRef = useRef<HTMLDivElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const [docked, setDocked] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [isDesktop, setIsDesktop] = useState(false);
	const [isPlaying, setIsPlaying] = useState(false);
	const [pos, setPos] = useState<Pos | null>(null);
	const [dragging, setDragging] = useState(false);
	const [slotHeight, setSlotHeight] = useState<number | null>(null);
	const [reduceMotion, setReduceMotion] = useState(false);

	// Mini-player is a desktop affordance only (owner: never show on phone).
	useEffect(() => {
		const mql = window.matchMedia("(min-width: 1024px)");
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

	// Track real playback state off the underlying <video>. It mounts inside
	// CapVideoPlayer after this effect first runs, so retry until it exists.
	useEffect(() => {
		let video: HTMLVideoElement | null = null;
		let raf = 0;
		const sync = () => {
			if (video) setIsPlaying(!video.paused && !video.ended);
		};
		const attach = () => {
			const el = innerRef.current?.querySelector("video");
			if (!el) {
				raf = requestAnimationFrame(attach);
				return;
			}
			video = el;
			video.addEventListener("play", sync);
			video.addEventListener("playing", sync);
			video.addEventListener("pause", sync);
			video.addEventListener("ended", sync);
			sync();
		};
		attach();
		return () => {
			cancelAnimationFrame(raf);
			if (video) {
				video.removeEventListener("play", sync);
				video.removeEventListener("playing", sync);
				video.removeEventListener("pause", sync);
				video.removeEventListener("ended", sync);
			}
		};
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
				}
			},
			{ threshold: 0 },
		);
		observer.observe(slot);
		return () => observer.disconnect();
	}, []);

	// Whether the wrapper is currently a fixed mini-player (leaves normal flow).
	const dockable = docked && isDesktop;
	const showMini = dockable && isPlaying && !dismissed;

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

	// Default anchor (top-right) unless the user has dragged it somewhere.
	const positionStyle: React.CSSProperties | undefined = pos
		? { top: pos.y, left: pos.x, right: "auto" }
		: undefined;

	return (
		<div
			ref={slotRef}
			className="min-w-0"
			style={dockable && slotHeight ? { minHeight: slotHeight } : undefined}
		>
			<div
				ref={innerRef}
				style={dockable ? positionStyle : undefined}
				className={
					dockable
						? `fixed z-50 w-[min(300px,72vw)] ${pos ? "" : "top-4 right-4"} ${transitionClass} ${
								showMini
									? "translate-y-0 opacity-100"
									: "pointer-events-none -translate-y-2 opacity-0"
							}`
						: `relative ${transitionClass}`
				}
			>
				<div
					className={
						dockable
							? "relative aspect-video overflow-hidden rounded-xl shadow-lg ring-1 ring-black/10"
							: "relative"
					}
				>
					{children}
					{dockable && (
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
					)}
				</div>
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
