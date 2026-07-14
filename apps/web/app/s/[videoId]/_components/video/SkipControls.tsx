"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/app/lib/utils";

const SKIP_STEP_STORAGE_KEY = "data365:skipStep";
const SKIP_STEP_CHANGE_EVENT = "data365:skipStepChange";
const SKIP_STEP_OPTIONS = [5, 10, 15, 30] as const;
const DEFAULT_SKIP_STEP = 10;
const LONG_PRESS_MS = 450;

type SkipStep = (typeof SKIP_STEP_OPTIONS)[number];

function isSkipStep(value: unknown): value is SkipStep {
	return (
		typeof value === "number" &&
		(SKIP_STEP_OPTIONS as readonly number[]).includes(value)
	);
}

function readSkipStep(): SkipStep {
	try {
		const raw = window.localStorage.getItem(SKIP_STEP_STORAGE_KEY);
		const parsed = raw === null ? null : Number(raw);
		return isSkipStep(parsed) ? parsed : DEFAULT_SKIP_STEP;
	} catch {
		return DEFAULT_SKIP_STEP;
	}
}

/**
 * Podcast-style skip step (−N/+N), persisted in localStorage and kept in
 * sync live across every SkipButton instance in both players — localStorage
 * alone doesn't notify other same-tab listeners, so a custom event does.
 */
export function useSkipStep(): [SkipStep, (step: SkipStep) => void] {
	const [step, setStepState] = useState<SkipStep>(DEFAULT_SKIP_STEP);

	useEffect(() => {
		setStepState(readSkipStep());
		const onChange = (event: Event) => {
			const detail = (event as CustomEvent<number>).detail;
			if (isSkipStep(detail)) setStepState(detail);
		};
		window.addEventListener(SKIP_STEP_CHANGE_EVENT, onChange);
		return () => window.removeEventListener(SKIP_STEP_CHANGE_EVENT, onChange);
	}, []);

	const setStep = useCallback((next: SkipStep) => {
		setStepState(next);
		try {
			window.localStorage.setItem(SKIP_STEP_STORAGE_KEY, String(next));
		} catch {
			// ignore (storage disabled)
		}
		window.dispatchEvent(
			new CustomEvent(SKIP_STEP_CHANGE_EVENT, { detail: next }),
		);
	}, []);

	return [step, setStep];
}

interface SkipButtonProps {
	video: HTMLVideoElement | null;
	direction: "back" | "forward";
	className?: string;
	iconClassName?: string;
	// Which way the step picker opens. "top" (default) suits controls near the
	// bottom of their container (the in-page audio player); the docked audio
	// pin bar sits at the very top of the viewport, so it must open "bottom" or
	// the popover clips off-screen.
	menuPlacement?: "top" | "bottom";
}

/**
 * Circular-arrow skip button (tap to skip ±step seconds). Long-press or
 * right-click opens a small popover to change the shared step among
 * 5/10/15/30 — applies to both buttons in both players (AudioPlayer +
 * DockableVideo's audio pin bar) via `useSkipStep`.
 */
export function SkipButton({
	video,
	direction,
	className,
	iconClassName = "size-6",
	menuPlacement = "top",
}: SkipButtonProps) {
	const t = useTranslations("mediaPlayer");
	const [step, setStep] = useSkipStep();
	const [popoverOpen, setPopoverOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
	const longPressFiredRef = useRef(false);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

	const onPointerDown = useCallback(() => {
		longPressFiredRef.current = false;
		clearLongPressTimer();
		longPressTimerRef.current = setTimeout(() => {
			longPressFiredRef.current = true;
			setPopoverOpen(true);
		}, LONG_PRESS_MS);
	}, [clearLongPressTimer]);

	const onPointerUp = useCallback(() => {
		clearLongPressTimer();
	}, [clearLongPressTimer]);

	const onClick = useCallback(() => {
		if (longPressFiredRef.current) {
			// The long-press already opened the popover — don't also skip.
			longPressFiredRef.current = false;
			return;
		}
		const v = video;
		if (v && Number.isFinite(v.duration)) {
			v.currentTime = Math.min(
				Math.max(0, v.currentTime + (direction === "back" ? -step : step)),
				v.duration || v.currentTime + step,
			);
		}
	}, [video, direction, step]);

	useEffect(() => {
		if (!popoverOpen) return;
		const onOutsidePointerDown = (event: PointerEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node)) {
				setPopoverOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPopoverOpen(false);
		};
		document.addEventListener("pointerdown", onOutsidePointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onOutsidePointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [popoverOpen]);

	const label = t(direction === "back" ? "skipBack" : "skipForward", {
		seconds: step,
	});

	return (
		<div ref={wrapperRef} className="relative inline-flex shrink-0">
			<button
				type="button"
				aria-label={label}
				className={cn("touch-none select-none", className)}
				onPointerDown={onPointerDown}
				onPointerUp={onPointerUp}
				onPointerLeave={onPointerUp}
				onPointerCancel={onPointerUp}
				onContextMenu={(event) => {
					event.preventDefault();
					setPopoverOpen(true);
				}}
				onClick={onClick}
			>
				<svg
					viewBox="0 0 24 24"
					className={iconClassName}
					fill="none"
					stroke="currentColor"
					strokeWidth={1.6}
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					{direction === "back" ? (
						<>
							<path d="M11.4 6.2A6.2 6.2 0 1 0 6.4 8.9" />
							<path d="M6 4.4 6.2 9 10.8 8.6" />
						</>
					) : (
						<>
							<path d="M12.6 6.2A6.2 6.2 0 1 1 17.6 8.9" />
							<path d="M18 4.4 17.8 9 13.2 8.6" />
						</>
					)}
					<text
						x="12"
						y="15.3"
						textAnchor="middle"
						fontSize="7.5"
						stroke="none"
						fill="currentColor"
						fontWeight="600"
					>
						{step}
					</text>
				</svg>
			</button>

			{popoverOpen && (
				<div
					role="menu"
					aria-label={t("skipStepLabel")}
					className={cn(
						"absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-gray-5 bg-gray-1 p-1 text-gray-12 shadow-lg",
						menuPlacement === "bottom"
							? "top-full mt-2"
							: "bottom-full mb-2",
					)}
				>
					{SKIP_STEP_OPTIONS.map((option) => (
						<button
							key={option}
							type="button"
							onClick={() => {
								setStep(option);
								setPopoverOpen(false);
							}}
							className={cn(
								"rounded-md px-2 py-1 text-xs font-medium",
								option === step
									? "bg-[var(--brand)] text-[var(--brand-fg)]"
									: "hover:bg-gray-3",
							)}
						>
							{option}s
						</button>
					))}
				</div>
			)}
		</div>
	);
}
