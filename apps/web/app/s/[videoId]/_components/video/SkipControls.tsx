"use client";

import { RotateCcw, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "@/app/lib/utils";

const SKIP_STEP_STORAGE_KEY = "data365:videoSkipStep";
const SKIP_STEP_OPTIONS = [5, 10, 15, 20, 30] as const;
const DEFAULT_SKIP_STEP = 10;
const LONG_PRESS_MS = 450;

export type SkipStep = (typeof SKIP_STEP_OPTIONS)[number];

function isSkipStep(value: unknown): value is SkipStep {
	return (
		typeof value === "number" &&
		(SKIP_STEP_OPTIONS as readonly number[]).includes(value)
	);
}

export function useSkipStep(): [SkipStep, (step: SkipStep) => void] {
	const [step, setStepState] = useState<SkipStep>(DEFAULT_SKIP_STEP);

	useEffect(() => {
		try {
			const stored = Number(window.localStorage.getItem(SKIP_STEP_STORAGE_KEY));
			if (isSkipStep(stored)) setStepState(stored);
		} catch {
			// Keep the default when storage is unavailable.
		}
	}, []);

	const setStep = useCallback((next: SkipStep) => {
		setStepState(next);
		try {
			window.localStorage.setItem(SKIP_STEP_STORAGE_KEY, String(next));
		} catch {
			// The selection still works for this page when storage is unavailable.
		}
	}, []);

	return [step, setStep];
}

interface SkipButtonProps {
	videoRef: RefObject<HTMLVideoElement | null>;
	direction: "back" | "forward";
	step: SkipStep;
	onStepChange: (step: SkipStep) => void;
	className?: string;
	menuPlacement?: "top" | "bottom";
	menuAlign?: "start" | "center";
}

export function SkipButton({
	videoRef,
	direction,
	step,
	onStepChange,
	className,
	menuPlacement = "top",
	menuAlign = "center",
}: SkipButtonProps) {
	const t = useTranslations("mediaPlayer");
	const [menuOpen, setMenuOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const longPressFiredRef = useRef(false);

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current === null) return;
		clearTimeout(longPressTimerRef.current);
		longPressTimerRef.current = null;
	}, []);

	useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

	useEffect(() => {
		if (!menuOpen) return;
		const closeOnOutsidePointer = (event: PointerEvent) => {
			if (!wrapperRef.current?.contains(event.target as Node))
				setMenuOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsidePointer);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsidePointer);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [menuOpen]);

	const skip = () => {
		if (longPressFiredRef.current) {
			longPressFiredRef.current = false;
			return;
		}
		const video = videoRef.current;
		if (!video || !Number.isFinite(video.duration)) return;
		const delta = direction === "back" ? -step : step;
		video.currentTime = Math.min(
			Math.max(0, video.currentTime + delta),
			video.duration,
		);
	};

	const Icon = direction === "back" ? RotateCcw : RotateCw;

	return (
		<div ref={wrapperRef} className="relative inline-flex shrink-0">
			<button
				type="button"
				data-slot={`media-skip-${direction}`}
				aria-label={t(direction === "back" ? "skipBack" : "skipForward", {
					seconds: step,
				})}
				aria-haspopup="menu"
				aria-expanded={menuOpen}
				className={cn(
					"flex size-11 touch-none select-none items-center justify-center rounded-full transition-colors",
					className,
				)}
				onPointerDown={() => {
					longPressFiredRef.current = false;
					clearLongPressTimer();
					longPressTimerRef.current = setTimeout(() => {
						longPressFiredRef.current = true;
						setMenuOpen(true);
					}, LONG_PRESS_MS);
				}}
				onPointerUp={clearLongPressTimer}
				onPointerLeave={clearLongPressTimer}
				onPointerCancel={clearLongPressTimer}
				onContextMenu={(event) => {
					event.preventDefault();
					setMenuOpen(true);
				}}
				onKeyDown={(event) => {
					if (event.key !== "ArrowDown") return;
					event.preventDefault();
					event.stopPropagation();
					setMenuOpen(true);
				}}
				onKeyUp={(event) => {
					if (event.key === "ArrowDown") event.stopPropagation();
				}}
				onClick={skip}
			>
				<span className="relative flex size-7 items-center justify-center">
					<Icon aria-hidden className="absolute inset-0 size-7" />
					<span className="text-[9px] font-semibold leading-none tabular-nums">
						{step}
					</span>
				</span>
			</button>

			{menuOpen && (
				<div
					role="menu"
					className={cn(
						"absolute z-50 flex items-center gap-1 rounded-xl border border-white/15 bg-black/90 p-1 text-white shadow-xl backdrop-blur-md",
						menuPlacement === "top" ? "bottom-full mb-2" : "top-full mt-2",
						menuAlign === "start" ? "left-0" : "left-1/2 -translate-x-1/2",
					)}
				>
					{SKIP_STEP_OPTIONS.map((option) => (
						<button
							key={option}
							type="button"
							role="menuitemradio"
							aria-checked={option === step}
							data-skip-step={option}
							onClick={() => {
								onStepChange(option);
								setMenuOpen(false);
							}}
							className={cn(
								"flex size-11 items-center justify-center rounded-lg text-xs font-semibold tabular-nums transition-colors",
								option === step
									? "bg-white text-black"
									: "text-white/80 hover:bg-white/15 hover:text-white",
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
