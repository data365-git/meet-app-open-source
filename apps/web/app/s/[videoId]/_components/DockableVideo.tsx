"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

const PIN_STORAGE_KEY = "data365:watchMiniPin";

/**
 * Wraps the video player so it can "dock" into a fixed mini-player once the
 * user scrolls it out of view. Only the WRAPPER's CSS position toggles —
 * `children` (the playerBlock) is rendered exactly once and never remounts,
 * so playback (and transcript seek sync via videoRef) keeps working.
 */
export function DockableVideo({ children }: { children: React.ReactNode }) {
	const t = useTranslations("share");
	const slotRef = useRef<HTMLDivElement | null>(null);
	const innerRef = useRef<HTMLDivElement | null>(null);
	const [docked, setDocked] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [pinned, setPinned] = useState(false);
	const [slotHeight, setSlotHeight] = useState<number | null>(null);
	const [reduceMotion, setReduceMotion] = useState(false);

	// Read persisted pin state on mount only (SSR-safe: localStorage is only
	// touched inside this effect, never during render).
	useEffect(() => {
		try {
			setPinned(window.localStorage.getItem(PIN_STORAGE_KEY) === "1");
		} catch {
			// ignore (e.g. storage disabled)
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
				}
			},
			{ threshold: 0 },
		);
		observer.observe(slot);
		return () => observer.disconnect();
	}, []);

	// Measure the player's inline (non-docked) height so the slot can reserve
	// that space via min-height once the inner wrapper becomes `fixed` and
	// leaves normal flow — otherwise the content below jumps up.
	useEffect(() => {
		const inner = innerRef.current;
		if (!inner) return;
		const measure = () => {
			if (!docked) setSlotHeight(inner.getBoundingClientRect().height);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(inner);
		return () => ro.disconnect();
	}, [docked]);

	const togglePin = () => {
		setPinned((prev) => {
			const next = !prev;
			try {
				window.localStorage.setItem(PIN_STORAGE_KEY, next ? "1" : "0");
			} catch {
				// ignore
			}
			return next;
		});
	};

	const handleExpand = () => {
		slotRef.current?.scrollIntoView({
			behavior: reduceMotion ? "auto" : "smooth",
			block: "start",
		});
	};

	const showMini = docked && (pinned || !dismissed);

	const transitionClass = reduceMotion
		? ""
		: "transition-all duration-[180ms] ease-out";

	return (
		<div
			ref={slotRef}
			className="min-w-0"
			style={docked && slotHeight ? { minHeight: slotHeight } : undefined}
		>
			<div
				ref={innerRef}
				className={
					docked
						? `fixed bottom-4 right-4 z-50 w-[min(300px,72vw)] ${transitionClass} ${
								showMini
									? "translate-y-0 opacity-100"
									: "pointer-events-none translate-y-2 opacity-0"
							}`
						: `relative ${transitionClass}`
				}
			>
				<div
					className={
						docked
							? "relative aspect-video overflow-hidden rounded-xl shadow-lg ring-1 ring-black/10"
							: "relative"
					}
				>
					{children}
					{docked && (
						<div className="absolute right-2 top-2 z-40 flex items-center gap-1">
							<button
								type="button"
								aria-label={
									pinned ? t("miniPinOff") : t("miniPinOn")
								}
								onClick={togglePin}
								className={`inline-flex size-6 items-center justify-center rounded-md border border-white/15 text-[11px] shadow-sm backdrop-blur-sm transition-colors ${
									pinned
										? "bg-[var(--brand)] text-white"
										: "bg-black/65 text-white/80 hover:bg-black/80 hover:text-white"
								}`}
							>
								<PinIcon filled={pinned} />
							</button>
							<button
								type="button"
								aria-label={t("miniExpand")}
								onClick={handleExpand}
								className="inline-flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
							>
								<ExpandIcon />
							</button>
							{!pinned && (
								<button
									type="button"
									aria-label={t("miniClose")}
									onClick={() => setDismissed(true)}
									className="inline-flex size-6 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
								>
									<CloseIcon />
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function PinIcon({ filled }: { filled: boolean }) {
	return (
		<svg
			viewBox="0 0 24 24"
			className="size-3.5"
			fill={filled ? "currentColor" : "none"}
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden="true"
		>
			<path
				strokeLinecap="round"
				strokeLinejoin="round"
				d="M12 17v5m-5-9V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8l2 3H5l2-3Z"
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
			<path strokeLinecap="round" strokeLinejoin="round" d="M6 6l12 12M18 6 6 18" />
		</svg>
	);
}
