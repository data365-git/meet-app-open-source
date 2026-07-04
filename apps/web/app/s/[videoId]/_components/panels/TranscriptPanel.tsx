"use client";

import { useTranslations } from "next-intl";
import React, { useEffect, useRef, useState } from "react";
import {
	normalizeWebVttVoiceText,
	stripRenderedVttTags,
} from "@/lib/transcript-vtt";
import {
	clampStartSec,
	collapseRepeatedCues,
} from "../utils/transcript-utils";
import { renderMarkdownBold } from "./markdownBold";

interface TranscriptPanelProps {
	transcriptContent?: string;
	currentTime?: number;
	onVideoJump?: (seconds: number) => void;
	chapters?: { startSec: number; title: string }[];
	duration?: number | null;
}

interface Cue {
	id: number;
	startSeconds: number;
	endSeconds: number;
	text: string;
	speaker: string | null;
	timestamp: string;
}

export function parseVTTCues(vttContent: string): Cue[] {
	const lines = vttContent.split(/\r?\n/);
	const cues: Cue[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]?.trim() ?? "";

		if (line === "WEBVTT" || line === "") {
			i++;
			continue;
		}

		// Skip standalone cue-identifier lines (bare integers before a timestamp line).
		if (/^\d+$/.test(line) && !line.includes("-->")) {
			i++;
			continue;
		}

		if (line.includes("-->")) {
			// Strip leading markdown / bracket decoration:
			// handles "**[00:00:00.000 --> 00:00:05.500]** text"
			//          "[00:00:00.000 --> 00:00:05.500] text"
			//          "00:00:00.000 --> 00:00:05.500 text"
			const stripped = line.replace(/^\*{0,2}\[?/, "");

			const arrowIdx = stripped.indexOf("-->");
			if (arrowIdx === -1) {
				i++;
				continue;
			}

			const startRaw = stripped.slice(0, arrowIdx).trim();
			const afterArrow = stripped.slice(arrowIdx + 3);

			// The end timestamp runs up to the first ']', '**', or cue setting
			// (position/align/line keywords). Take only the time token.
			const endTokenMatch = afterArrow.match(/^[\s]*([\d:.]+)/);
			const endRaw = endTokenMatch?.[1]?.trim() ?? "";

			const startSeconds = vttTimeToSeconds(startRaw);
			const endSeconds = vttTimeToSeconds(endRaw);

			if (startSeconds === null || endSeconds === null) {
				i++;
				continue;
			}

			// Capture any inline text that follows the closing bracket / **
			// e.g. "**[start --> end]** spoken text here"
			// Everything after the end timestamp token, then strip decorators.
			const afterEnd = afterArrow.slice(endTokenMatch?.[0]?.length ?? 0);
			const inlineText = afterEnd
				.replace(/^[^\]]*\]/, "") // drop up to first ']' (handles closing bracket)
				.replace(/^\*\*/, "") // drop the timestamp-wrapper's closing ** marker only
				.replace(/^[\s\-–—:>]+/, "") // strip leading separators
				.trim();

			let rawText: string;

			if (inlineText) {
				// Text was on the same line — do NOT consume following lines.
				rawText = inlineText;
				i++;
			} else {
				// Standard multi-line VTT: collect following non-empty lines.
				i++;
				const textLines: string[] = [];
				while (i < lines.length && (lines[i]?.trim() ?? "") !== "") {
					textLines.push(lines[i] ?? "");
					i++;
				}
				rawText = textLines.join(" ").trim();
			}

			// Discard parser artifacts: empty, bare numbers, or punctuation-only.
			if (!rawText || /^[\d\s\-–—.,;:!?]+$/.test(rawText)) {
				continue;
			}

			const { speaker, text } = extractSpeaker(rawText);
			cues.push({
				id: cues.length,
				startSeconds,
				endSeconds,
				// Final render-boundary strip: guarantee no orphan WebVTT tag
				// (e.g. a lone `</v>` from a lost cross-cue opener) survives into
				// any downstream path (karaoke, search highlight, copy/download).
				text: stripRenderedVttTags(text),
				speaker,
				timestamp: formatTimestamp(startSeconds),
			});
			continue;
		}

		i++;
	}

	return cues;
}

function vttTimeToSeconds(timeStr: string): number | null {
	const parts = timeStr.split(":");
	if (parts.length === 3) {
		const [h, m, s] = parts;
		const hours = parseInt(h ?? "0", 10);
		const minutes = parseInt(m ?? "0", 10);
		const seconds = parseFloat(s ?? "0");
		if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
			return null;
		return hours * 3600 + minutes * 60 + seconds;
	}
	if (parts.length === 2) {
		const [m, s] = parts;
		const minutes = parseInt(m ?? "0", 10);
		const seconds = parseFloat(s ?? "0");
		if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
		return minutes * 60 + seconds;
	}
	return null;
}

function extractSpeaker(text: string): {
	speaker: string | null;
	text: string;
} {
	const normalized = normalizeWebVttVoiceText(text);
	if (normalized.text !== text || normalized.speaker) return normalized;

	const colonMatch = text.match(/^([^:]{1,30}):\s+(.+)$/);
	if (colonMatch) {
		return {
			speaker: colonMatch[1]?.trim() ?? "Speaker",
			text: colonMatch[2]?.trim() ?? text,
		};
	}
	return { speaker: null, text };
}

function formatTimestamp(seconds: number): string {
	if (seconds >= 3600) {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = Math.floor(seconds % 60);
		return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
	}
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// Card grouping bounds (see plan Task P2): consecutive same-speaker cues merge
// into one card while the inter-cue gap and the accumulated span stay small.
const MAX_CARD_GAP_SEC = 6;
const MAX_CARD_SPAN_SEC = 60;

export interface TranscriptCard {
	speaker: string | null;
	startSeconds: number;
	timestamp: string;
	cues: Cue[];
}

/**
 * Group consecutive cues into speaker cards. A running card keeps absorbing the
 * next cue while ALL hold: (a) same speaker, (b) inter-cue gap
 * (next.start − prev.end) ≤ 6s, (c) accumulated span (next.end − card.start)
 * ≤ 60s. Any violation starts a new card. The card's timestamp is its first
 * cue's start. Pure + deterministic so it can be unit-tested in isolation.
 */
export function groupCuesIntoCards(cues: Cue[]): TranscriptCard[] {
	const cards: TranscriptCard[] = [];
	for (const cue of cues) {
		const current = cards[cards.length - 1];
		const prev = current?.cues[current.cues.length - 1];
		const sameSpeaker = current != null && current.speaker === cue.speaker;
		const gapOk =
			prev != null && cue.startSeconds - prev.endSeconds <= MAX_CARD_GAP_SEC;
		const spanOk =
			current != null &&
			cue.endSeconds - current.startSeconds <= MAX_CARD_SPAN_SEC;

		if (current && sameSpeaker && gapOk && spanOk) {
			current.cues.push(cue);
		} else {
			cards.push({
				speaker: cue.speaker,
				startSeconds: cue.startSeconds,
				timestamp: cue.timestamp,
				cues: [cue],
			});
		}
	}
	return cards;
}

// --- Feature helpers ---

function secondsToSRTTime(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	const ms = Math.round((sec - Math.floor(sec)) * 1000);
	return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")},${ms.toString().padStart(3, "0")}`;
}

export function cuesToPlainText(cues: Cue[]): string {
	return cues
		.map((c) => {
			const text = c.text.replace(/\*\*/g, "");
			return c.speaker
				? `[${c.timestamp}] ${c.speaker}: ${text}`
				: `[${c.timestamp}] ${text}`;
		})
		.join("\n");
}

export function cuesToSRT(cues: Cue[]): string {
	return cues
		.map(
			(c, i) =>
				`${i + 1}\n${secondsToSRTTime(c.startSeconds)} --> ${secondsToSRTTime(c.endSeconds)}\n${c.text.replace(/\*\*/g, "")}\n`,
		)
		.join("\n");
}

function downloadBlob(content: string, filename: string, type: string): void {
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

function highlightMatch(text: string, query: string): React.ReactNode {
	if (!query) return text;
	const idx = text.toLowerCase().indexOf(query.toLowerCase());
	if (idx === -1) return text;
	return (
		<>
			{text.slice(0, idx)}
			<mark
				style={{
					background: "var(--brand-wash)",
					color: "var(--brand)",
					fontWeight: 600,
					borderRadius: "3px",
					padding: "0 1px",
				}}
			>
				{text.slice(idx, idx + query.length)}
			</mark>
			{text.slice(idx + query.length)}
		</>
	);
}

function isActive(cue: Cue, currentTime: number): boolean {
	return currentTime >= cue.startSeconds && currentTime < cue.endSeconds;
}

/**
 * Word-level karaoke for the ACTIVE cue only: split the cue text into word
 * tokens (preserving `**bold**` emphasis) and interpolate each word's start
 * time within [startSeconds, endSeconds] by cumulative character position.
 * Words whose interpolated start has been reached are tinted; the rest keep
 * the normal text color.
 */
function renderKaraokeText(cue: Cue, currentTime: number): React.ReactNode {
	const parts = cue.text.split(/\*\*(.+?)\*\*/g); // odd indices = bold
	const tokens: { text: string; bold: boolean }[] = [];
	parts.forEach((part, i) => {
		if (!part) return;
		const bold = i % 2 === 1;
		for (const piece of part.split(/(\s+)/)) {
			if (piece) tokens.push({ text: piece, bold });
		}
	});
	const totalChars = tokens.reduce((n, tok) => n + tok.text.length, 0);
	if (totalChars === 0) return renderMarkdownBold(cue.text);
	const cueDuration = Math.max(cue.endSeconds - cue.startSeconds, 0.001);
	let charsBefore = 0;
	return tokens.map((tok, i) => {
		const wordStart = cue.startSeconds + cueDuration * (charsBefore / totalChars);
		charsBefore += tok.text.length;
		if (/^\s+$/.test(tok.text)) return tok.text;
		const sung = currentTime >= wordStart;
		return (
			<span
				key={`kw-${i}`}
				className={tok.bold ? "font-semibold" : undefined}
				style={{
					color: sung ? "var(--blue-11)" : undefined,
					transition: "color 120ms linear",
				}}
			>
				{tok.text}
			</span>
		);
	});
}

function normalizeCueTimes(cues: Cue[], duration?: number | null): Cue[] {
	if (!duration || duration <= 0) return cues;

	return cues
		.map((cue) => {
			const recoveredStart = clampStartSec(cue.startSeconds, duration);
			const shouldScaleEnd =
				cue.endSeconds > duration && cue.endSeconds / 60 <= duration;
			const recoveredEnd = shouldScaleEnd
				? cue.endSeconds / 60
				: Math.min(cue.endSeconds, duration);
			const endSeconds =
				recoveredEnd > recoveredStart
					? recoveredEnd
					: Math.min(duration, recoveredStart + 3);

			return {
				...cue,
				startSeconds: recoveredStart,
				endSeconds,
				timestamp: formatTimestamp(recoveredStart),
			};
		})
		.sort((a, b) => a.startSeconds - b.startSeconds);
}

export function TranscriptPanel({
	transcriptContent,
	currentTime = 0,
	onVideoJump,
	duration,
}: TranscriptPanelProps) {
	const t = useTranslations("share");
	const containerRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLDivElement>(null);

	const cues = transcriptContent
		? normalizeCueTimes(
				collapseRepeatedCues(parseVTTCues(transcriptContent), (c) => c.text),
				duration,
			)
		: [];

	const activeCueId = cues.find((c) => isActive(c, currentTime))?.id ?? null;

	const hasAnySpeaker = cues.some((c) => c.speaker !== null);
	const distinctSpeakers = Array.from(
		new Set(cues.map((c) => c.speaker).filter((s): s is string => s !== null)),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeCueId drives which DOM node activeRef points to; re-running when it changes is intentional
	useEffect(() => {
		if (activeRef.current) {
			activeRef.current.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
			});
		}
	}, [activeCueId]);

	// --- Search state ---
	const [searchQuery, setSearchQuery] = useState("");
	const trimmedQuery = searchQuery.trim();

	// --- Speaker filter state ---
	const [speakerFilter, setSpeakerFilter] = useState<string | null>(null);
	const [speakerMenuOpen, setSpeakerMenuOpen] = useState(false);
	const speakerMenuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!speakerMenuOpen) return;
		function handleClickOutside(e: MouseEvent) {
			if (
				speakerMenuRef.current &&
				!speakerMenuRef.current.contains(e.target as Node)
			) {
				setSpeakerMenuOpen(false);
			}
		}
		function handleEsc(e: KeyboardEvent) {
			if (e.key === "Escape") setSpeakerMenuOpen(false);
		}
		document.addEventListener("mousedown", handleClickOutside);
		document.addEventListener("keydown", handleEsc);
		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
			document.removeEventListener("keydown", handleEsc);
		};
	}, [speakerMenuOpen]);

	// --- Copy state ---
	const [copied, setCopied] = useState(false);

	function handleCopy() {
		navigator.clipboard.writeText(cuesToPlainText(cues)).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	}

	// --- Download ---
	function handleDownload(format: "txt" | "srt") {
		if (format === "txt") {
			downloadBlob(cuesToPlainText(cues), "transcript.txt", "text/plain");
		} else {
			downloadBlob(cuesToSRT(cues), "transcript.srt", "text/plain");
		}
	}

	// Filtered cues: search query AND speaker filter combine (both must match).
	const filteredCues = cues.filter((c) => {
		const matchesQuery = trimmedQuery
			? c.text.toLowerCase().includes(trimmedQuery.toLowerCase()) ||
				(c.speaker?.toLowerCase().includes(trimmedQuery.toLowerCase()) ?? false)
			: true;
		const matchesSpeaker = speakerFilter ? c.speaker === speakerFilter : true;
		return matchesQuery && matchesSpeaker;
	});

	// Shared panel header (search + copy + download)
	function renderHeader() {
		return (
			<div
				style={{
					display: "flex",
					flexDirection: "column",
					gap: "8px",
					padding: "4px 0 8px",
					borderBottom: "1px solid var(--gray-3)",
					marginBottom: "8px",
				}}
			>
				{/* Search row */}
				<div style={{ position: "relative", display: "flex", alignItems: "center" }}>
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
							position: "absolute",
							left: "10px",
							width: "14px",
							height: "14px",
							color: "var(--gray-10)",
							pointerEvents: "none",
						}}
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						type="text"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder={t("searchTranscript")}
						style={{
							flex: 1,
							paddingLeft: "32px",
							paddingRight: searchQuery ? "32px" : "10px",
							paddingTop: "7px",
							paddingBottom: "7px",
							fontSize: "13px",
							background: "var(--gray-2)",
							border: "1px solid var(--gray-4)",
							borderRadius: "8px",
							color: "var(--gray-12)",
							outline: "none",
						}}
					/>
					{searchQuery && (
						<button
							type="button"
							onClick={() => setSearchQuery("")}
							aria-label={t("clearSearch")}
							style={{
								position: "absolute",
								right: "8px",
								background: "none",
								border: "none",
								cursor: "pointer",
								color: "var(--gray-10)",
								padding: "2px",
								display: "flex",
								alignItems: "center",
							}}
						>
							<svg
								aria-hidden="true"
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.5"
								strokeLinecap="round"
								style={{ width: "13px", height: "13px" }}
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					)}
				</div>

				{/* Speaker filter + results count + copy + download row */}
				<div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
					{distinctSpeakers.length >= 2 && (
						<div ref={speakerMenuRef} style={{ position: "relative" }}>
							<button
								type="button"
								onClick={() => setSpeakerMenuOpen((v) => !v)}
								aria-haspopup="listbox"
								aria-expanded={speakerMenuOpen}
								style={{
									display: "flex",
									alignItems: "center",
									gap: "4px",
									padding: "5px 10px",
									fontSize: "12px",
									fontWeight: 500,
									background: speakerFilter ? "var(--brand-wash)" : "var(--gray-3)",
									color: speakerFilter ? "var(--brand)" : "var(--gray-11)",
									border: "none",
									borderRadius: "6px",
									cursor: "pointer",
									whiteSpace: "nowrap",
								}}
							>
								{speakerFilter ?? t("speakerFilter")}
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
									<polyline points="6 9 12 15 18 9" />
								</svg>
							</button>
							{speakerMenuOpen && (
								<div
									role="listbox"
									style={{
										position: "absolute",
										top: "calc(100% + 4px)",
										left: 0,
										zIndex: 10,
										minWidth: "160px",
										background: "var(--gray-1)",
										border: "1px solid var(--gray-4)",
										borderRadius: "8px",
										boxShadow: "0 4px 12px rgba(15,23,42,.12)",
										padding: "4px",
										display: "flex",
										flexDirection: "column",
										gap: "1px",
									}}
								>
									<button
										type="button"
										role="option"
										aria-selected={speakerFilter === null}
										onClick={() => {
											setSpeakerFilter(null);
											setSpeakerMenuOpen(false);
										}}
										style={{
											display: "flex",
											alignItems: "center",
											justifyContent: "space-between",
											gap: "6px",
											padding: "6px 8px",
											fontSize: "12.5px",
											fontWeight: 500,
											textAlign: "left",
											background:
												speakerFilter === null ? "var(--brand-wash)" : "transparent",
											color: speakerFilter === null ? "var(--brand)" : "var(--gray-12)",
											border: "none",
											borderRadius: "6px",
											cursor: "pointer",
										}}
									>
										{t("allSpeakers")}
										{speakerFilter === null && <span aria-hidden="true">✓</span>}
									</button>
									{distinctSpeakers.map((speaker) => (
										<button
											key={speaker}
											type="button"
											role="option"
											aria-selected={speakerFilter === speaker}
											onClick={() => {
												setSpeakerFilter(speaker);
												setSpeakerMenuOpen(false);
											}}
											style={{
												display: "flex",
												alignItems: "center",
												justifyContent: "space-between",
												gap: "6px",
												padding: "6px 8px",
												fontSize: "12.5px",
												fontWeight: 500,
												textAlign: "left",
												background:
													speakerFilter === speaker ? "var(--brand-wash)" : "transparent",
												color:
													speakerFilter === speaker ? "var(--brand)" : "var(--gray-12)",
												border: "none",
												borderRadius: "6px",
												cursor: "pointer",
											}}
										>
											{speaker}
											{speakerFilter === speaker && <span aria-hidden="true">✓</span>}
										</button>
									))}
								</div>
							)}
						</div>
					)}

					{trimmedQuery && (
						<span
							style={{
								fontSize: "12px",
								color: "var(--gray-10)",
								flex: 1,
							}}
						>
							{t("resultCount", { count: filteredCues.length })}
						</span>
					)}
					{!trimmedQuery && <span style={{ flex: 1 }} />}

					{/* Copy button */}
					<button
						type="button"
						onClick={handleCopy}
						title={copied ? t("copied") : t("copyTranscript")}
						onMouseEnter={(e) => {
							e.currentTarget.style.background = "var(--blue-3)";
							e.currentTarget.style.color = "var(--blue-11)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.background = "var(--gray-3)";
							e.currentTarget.style.color = "var(--gray-11)";
						}}
						style={{
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
							cursor: "pointer",
							transition: "background 150ms, color 150ms",
							whiteSpace: "nowrap",
						}}
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
						onClick={() => handleDownload("txt")}
						title={t("downloadTxt")}
						onMouseEnter={(e) => {
							e.currentTarget.style.background = "var(--blue-3)";
							e.currentTarget.style.color = "var(--blue-11)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.background = "var(--gray-3)";
							e.currentTarget.style.color = "var(--gray-11)";
						}}
						style={{
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
							cursor: "pointer",
							transition: "background 150ms, color 150ms",
							whiteSpace: "nowrap",
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
							style={{ width: "12px", height: "12px" }}
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
						TXT
					</button>

					{/* Download SRT */}
					<button
						type="button"
						onClick={() => handleDownload("srt")}
						title={t("downloadSrt")}
						onMouseEnter={(e) => {
							e.currentTarget.style.background = "var(--blue-3)";
							e.currentTarget.style.color = "var(--blue-11)";
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.background = "var(--gray-3)";
							e.currentTarget.style.color = "var(--gray-11)";
						}}
						style={{
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
							cursor: "pointer",
							transition: "background 150ms, color 150ms",
							whiteSpace: "nowrap",
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
							style={{ width: "12px", height: "12px" }}
						>
							<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
							<polyline points="7 10 12 15 17 10" />
							<line x1="12" y1="15" x2="12" y2="3" />
						</svg>
						SRT
					</button>
				</div>
			</div>
		);
	}

	if (!transcriptContent || cues.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
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
					<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
				</svg>
				<p className="text-sm font-medium text-gray-12">
					{t("noTranscript")}
				</p>
				<p className="text-xs text-gray-10">
					{t("transcriptProcessing")}
				</p>
			</div>
		);
	}

	// Flat conversation row: TIME | SPEAKER (only when it changes) | TEXT.
	// The speaker cell keeps its width even when blank so text stays aligned.
	function renderRow(cue: Cue, prevSpeaker: string | null) {
		const active = cue.id === activeCueId;
		const matches =
			!!trimmedQuery && cue.text.toLowerCase().includes(trimmedQuery.toLowerCase());
		const showSpeaker = hasAnySpeaker && cue.speaker !== prevSpeaker;

		return (
			<div
				key={`row-${cue.id}`}
				ref={active ? activeRef : undefined}
				style={{
					display: "flex",
					gap: "12px",
					padding: "10px 2px",
					borderBottom: "1px solid var(--ds-border, var(--gray-4))",
					alignItems: "baseline",
					background: active ? "var(--brand-wash)" : "transparent",
					borderRadius: active ? "8px" : undefined,
				}}
			>
				<button
					type="button"
					onClick={() => onVideoJump?.(cue.startSeconds)}
					title={t("jumpToTime", { time: cue.timestamp })}
					aria-label={t("jumpToTime", { time: cue.timestamp })}
					style={{
						flexShrink: 0,
						minWidth: "44px",
						fontSize: "11.5px",
						fontVariantNumeric: "tabular-nums",
						fontFamily:
							"ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
						color: "var(--brand)",
						background: "none",
						border: "none",
						padding: 0,
						textAlign: "left",
						cursor: "pointer",
					}}
				>
					{cue.timestamp}
				</button>

				{hasAnySpeaker && (
					<span
						style={{
							flexShrink: 0,
							minWidth: "56px",
							fontSize: "12.5px",
							fontWeight: 600,
							color: "var(--gray-12)",
						}}
					>
						{showSpeaker ? cue.speaker : ""}
					</span>
				)}

				<span
					className="break-words"
					style={{
						flex: 1,
						fontSize: "13px",
						lineHeight: 1.5,
						color: "var(--gray-11)",
					}}
				>
					{matches
						? highlightMatch(cue.text, trimmedQuery)
						: active
							? renderKaraokeText(cue, currentTime)
							: renderMarkdownBold(cue.text)}
				</span>
			</div>
		);
	}

	// Single flat list of rows — chapters are grouped in the Summary tab, not here.
	return (
		<div ref={containerRef} className="flex flex-col p-4">
			{renderHeader()}
			{filteredCues.map((cue, i) =>
				renderRow(cue, i > 0 ? (filteredCues[i - 1]?.speaker ?? null) : null),
			)}
		</div>
	);
}
