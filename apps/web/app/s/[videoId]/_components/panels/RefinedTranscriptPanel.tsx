"use client";

import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { downloadFilename } from "@/lib/download-filename";
import {
	buildRefinedTranscriptDocxBlob,
	buildRefinedTranscriptPlainText,
	saveBlobToFile,
} from "@/lib/refined-transcript-export";
import {
	clampStartSec,
	computeFollowScrollTop,
	formatTimeMinutes,
	isNearActiveRow,
} from "../utils/transcript-utils";
import { renderMarkdownBold } from "./markdownBold";

interface RefinedTranscriptPanelProps {
	refinedTranscript?: {
		chapters: {
			startSec: number;
			title: string;
			paragraphs: string[];
		}[];
	};
	onVideoJump?: (seconds: number) => void;
	duration?: number | null;
	currentTime?: number;
	/** The recording's current title — used to name the downloaded file and
	 *  head the .docx, exactly like `videoTitle` on TranscriptPanel. Optional
	 *  because callers may not thread it down; see `resolveRecordingTitle` for
	 *  the fallback. */
	videoTitle?: string | null;
}

export function RefinedTranscriptPanel({
	refinedTranscript,
	onVideoJump,
	duration,
	currentTime = 0,
	videoTitle,
}: RefinedTranscriptPanelProps) {
	const t = useTranslations("share");
	const [closedChapters, setClosedChapters] = useState<Set<number>>(new Set());
	const [copied, setCopied] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const activeSectionRef = useRef<HTMLElement>(null);

	function toggleChapter(startSec: number) {
		setClosedChapters((prev) => {
			const next = new Set(prev);
			if (next.has(startSec)) {
				next.delete(startSec);
			} else {
				next.add(startSec);
			}
			return next;
		});
	}

	const activeStartSec = getActiveRefinedChapterStartSec(
		refinedTranscript?.chapters ?? [],
		currentTime,
		duration,
	);

	// --- Copy / download controls (same affordances as the raw Transcript tab).
	// The export builders live in lib/refined-transcript-export; notes there
	// explain the output shapes (readable prose, ** markers handled per format).
	const plainText = useMemo(
		() =>
			refinedTranscript
				? buildRefinedTranscriptPlainText(refinedTranscript)
				: "",
		[refinedTranscript],
	);
	const canExport = plainText.length > 0;

	// Downloads are named after the recording via the shared downloadFilename
	// helper, so a folder of exports stays distinguishable. ShareVideo threads the
	// recording title down as a prop, the same way it already does for the raw
	// TranscriptPanel; an earlier version read it out of the `videoStatus`
	// react-query cache by literal key, which nothing typed or tested, so a rename
	// of that key would have silently downgraded every export to "recording.txt".
	function resolveRecordingTitle(): string | null {
		return videoTitle ?? null;
	}

	function handleCopy() {
		if (!canExport) return;
		navigator.clipboard.writeText(plainText).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	function handleDownloadTxt() {
		if (!canExport) return;
		saveBlobToFile(
			new Blob([plainText], { type: "text/plain" }),
			downloadFilename(resolveRecordingTitle(), "txt"),
		);
	}

	async function handleDownloadDocx() {
		if (!canExport || !refinedTranscript) return;
		const recordingTitle = resolveRecordingTitle();
		const blob = await buildRefinedTranscriptDocxBlob(
			refinedTranscript,
			recordingTitle,
		);
		saveBlobToFile(blob, downloadFilename(recordingTitle, "docx"));
	}

	// --- Auto-follow active chapter, scoped to this panel's own scroll container ---
	// Same pattern as TranscriptPanel: `containerRef` (the panel root) is always
	// rendered as the direct child of SharePanel's `overflow-y-auto` tabpanel div
	// — that ancestor is the true scroll container, NOT the page. We scroll it
	// via scrollTop math instead of `scrollIntoView`, which would otherwise drag
	// every scrollable ancestor (including the page/viewport) along with it.
	const followingRef = useRef(true);
	const programmaticScrollRef = useRef(false);

	function getScrollContainer(): HTMLElement | null {
		return containerRef.current?.parentElement ?? null;
	}

	function scrollToActiveSection(behavior: ScrollBehavior) {
		const container = getScrollContainer();
		const row = activeSectionRef.current;
		if (!container || !row) return;
		const target = computeFollowScrollTop({
			rowOffsetTop: row.offsetTop,
			rowHeight: row.offsetHeight,
			containerScrollTop: container.scrollTop,
			containerClientHeight: container.clientHeight,
			containerScrollHeight: container.scrollHeight,
		});
		if (target === container.scrollTop) return;
		programmaticScrollRef.current = true;
		container.scrollTo({ top: target, behavior });
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeStartSec drives which DOM node activeSectionRef points to; re-running when it changes is intentional
	useEffect(() => {
		if (followingRef.current) {
			scrollToActiveSection("smooth");
		}
	}, [activeStartSec]);

	// Detect user-initiated scroll on the panel's own container: any 'scroll'
	// event not flagged as our own programmatic scroll means the user touched
	// the panel (wheel/touch/scrollbar all surface as native 'scroll' events).
	// Stop following on such input; resume once they scroll back near the
	// active section (checked on the same event, after the flag is cleared).
	useEffect(() => {
		const container = getScrollContainer();
		if (!container) return;

		function handleScroll() {
			if (programmaticScrollRef.current) {
				programmaticScrollRef.current = false;
				return;
			}
			// Genuine user scroll.
			const row = activeSectionRef.current;
			if (!container || !row) {
				followingRef.current = false;
				return;
			}
			followingRef.current = isNearActiveRow({
				rowOffsetTop: row.offsetTop,
				rowHeight: row.offsetHeight,
				containerScrollTop: container.scrollTop,
				containerClientHeight: container.clientHeight,
			});
		}

		container.addEventListener("scroll", handleScroll, { passive: true });
		return () => container.removeEventListener("scroll", handleScroll);
	}, []);

	// Seeking via chapter click re-enables follow and jumps straight to it.
	function handleChapterSeek(seconds: number) {
		followingRef.current = true;
		onVideoJump?.(seconds);
	}

	if (!refinedTranscript || refinedTranscript.chapters.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-gray-4 bg-gray-2 px-4 py-10 text-center">
				<svg
					aria-hidden="true"
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#94a3b8"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="size-8"
				>
					<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
					<polyline points="14 2 14 8 20 8" />
					<line x1="16" y1="13" x2="8" y2="13" />
					<line x1="16" y1="17" x2="8" y2="17" />
					<polyline points="10 9 9 9 8 9" />
				</svg>
				<p className="text-sm font-medium text-gray-12">
					{t("noRefinedTranscript")}
				</p>
				<p className="text-xs text-gray-10">{t("refinedTranscriptDesc")}</p>
			</div>
		);
	}

	// Controls row above the chapters: copy + TXT + DOCX. Button markup mirrors
	// the Transcript tab's header actions — same styles, icons, titles, hover
	// treatment and copied confirmation — so the two tabs read as one product.
	// Buttons disable (rather than hiding) when the builder found no exportable
	// text, so the tab's affordances stay discoverable but can never download
	// an empty file.
	function renderControls() {
		const baseStyle = {
			display: "flex",
			alignItems: "center",
			gap: "4px",
			padding: "5px 10px",
			fontSize: "12px",
			fontWeight: 500,
			background: "var(--gray-3)",
			color: "var(--gray-11)",
			border: "none",
			borderRadius: "6px",
			cursor: canExport ? "pointer" : "not-allowed",
			transition: "background 150ms, color 150ms",
			whiteSpace: "nowrap",
			opacity: canExport ? 1 : 0.55,
		};
		const hoverHandlers = canExport
			? {
					onMouseEnter: (e: MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = "var(--blue-3)";
						e.currentTarget.style.color = "var(--blue-11)";
					},
					onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => {
						e.currentTarget.style.background = "var(--gray-3)";
						e.currentTarget.style.color = "var(--gray-11)";
					},
				}
			: {};
		const downloadIcon = (
			<svg
				aria-hidden="true"
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{ width: "12px", height: "12px" }}
			>
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
				<polyline points="7 10 12 15 17 10" />
				<line x1="12" y1="15" x2="12" y2="3" />
			</svg>
		);

		return (
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "6px",
					padding: "4px 0 8px",
					borderBottom: "1px solid var(--gray-3)",
				}}
			>
				<span style={{ flex: 1 }} />

				{/* Copy */}
				<button
					type="button"
					onClick={handleCopy}
					disabled={!canExport}
					title={copied ? t("copied") : t("copyTranscript")}
					{...hoverHandlers}
					style={baseStyle}
				>
					{copied ? (
						<>
							<svg
								aria-hidden="true"
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{ width: "12px", height: "12px" }}
							>
								<polyline points="20 6 9 17 4 12" />
							</svg>
							{t("copied")}
						</>
					) : (
						<>
							<svg
								aria-hidden="true"
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{ width: "12px", height: "12px" }}
							>
								<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
								<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
							</svg>
							{t("copyTranscript")}
						</>
					)}
				</button>

				{/* Download TXT */}
				<button
					type="button"
					onClick={handleDownloadTxt}
					disabled={!canExport}
					title={t("downloadTxt")}
					{...hoverHandlers}
					style={baseStyle}
				>
					{downloadIcon}
					TXT
				</button>

				{/* Download DOCX */}
				<button
					type="button"
					onClick={handleDownloadDocx}
					disabled={!canExport}
					title={t("downloadDocx")}
					{...hoverHandlers}
					style={baseStyle}
				>
					{downloadIcon}
					DOCX
				</button>
			</div>
		);
	}

	return (
		<div ref={containerRef} className="flex flex-col gap-4">
			{renderControls()}
			{refinedTranscript.chapters.map((chapter) => {
				const startSec = formatPanelStartSec(chapter.startSec, duration);
				const isOpen = !closedChapters.has(chapter.startSec);
				const isActive = chapter.startSec === activeStartSec;
				return (
					<section
						key={chapter.startSec}
						ref={isActive ? activeSectionRef : undefined}
						className="refined-section rounded-xl border border-gray-4 bg-gray-1 p-4 shadow-sm"
						style={
							isActive
								? {
										borderLeft: "3px solid var(--brand)",
										background: "var(--brand-wash)",
									}
								: undefined
						}
					>
						<div className="mb-3 flex items-center gap-2">
							<button
								type="button"
								onClick={() => handleChapterSeek(startSec)}
								className="rounded-md px-2 py-0.5 font-mono text-xs font-medium transition-colors"
								style={{
									background: "var(--brand-wash)",
									color: "var(--brand)",
								}}
							>
								{formatTimeMinutes(startSec)}
							</button>
							<button
								type="button"
								onClick={() => toggleChapter(chapter.startSec)}
								aria-expanded={isOpen}
								aria-label={t("toggleChapter")}
								className="flex shrink-0 items-center justify-center"
								style={{
									background: "transparent",
									border: "none",
									cursor: "pointer",
									padding: 0,
								}}
							>
								<svg
									aria-hidden="true"
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									style={{
										width: "14px",
										height: "14px",
										flexShrink: 0,
										transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
										transition: "transform 150ms",
									}}
								>
									<polyline points="6 9 12 15 18 9" />
								</svg>
							</button>
							<button
								type="button"
								onClick={() => handleChapterSeek(startSec)}
								className="flex-1 text-left text-base font-bold text-gray-12"
								style={{
									background: "transparent",
									border: "none",
									cursor: "pointer",
									padding: 0,
								}}
							>
								{chapter.title}
							</button>
							<button
								type="button"
								onClick={() => handleChapterSeek(startSec)}
								aria-label={t("playFromChapter", { title: chapter.title })}
								className="flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors"
								style={{
									background: "var(--brand-wash)",
									color: "var(--brand)",
								}}
							>
								<Play className="size-3.5 fill-current" />
							</button>
						</div>
						{isOpen && (
							<div className="flex flex-col gap-2">
								{chapter.paragraphs.map((paragraph, pi) => (
									<p
										key={`${chapter.startSec}-p-${pi}`}
										className="text-sm leading-relaxed text-gray-12"
									>
										{renderMarkdownBold(paragraph)}
									</p>
								))}
							</div>
						)}
					</section>
				);
			})}
		</div>
	);
}

function formatPanelStartSec(
	startSec: number,
	duration?: number | null,
): number {
	return clampStartSec(startSec, duration ?? undefined);
}

export function getActiveRefinedChapterStartSec(
	chapters: Array<{ startSec: number }>,
	currentTime: number,
	duration?: number | null,
): number | null {
	let activeRawStartSec: number | null = null;
	let activeDisplayStartSec = Number.NEGATIVE_INFINITY;

	for (const chapter of chapters) {
		const displayStartSec = formatPanelStartSec(chapter.startSec, duration);
		if (
			displayStartSec <= currentTime &&
			displayStartSec > activeDisplayStartSec
		) {
			activeRawStartSec = chapter.startSec;
			activeDisplayStartSec = displayStartSec;
		}
	}

	return activeRawStartSec;
}
