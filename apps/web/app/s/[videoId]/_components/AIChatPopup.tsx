"use client";

import Cookies from "js-cookie";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import "./ai-chat.css";

/* ============================================================
   Meeting AI popup — calm / flat, ADHD-friendly redesign
   (owner-delivered design, Wave 2.5).
   - Follows the app theme automatically (body class "dark"/"light",
     "theme" cookie, or prefers-color-scheme) -> data-theme on popup.
   - Adaptive rendering: short answers stay a plain bubble; longer
     answers get a TL;DR band + labelled sections + bullet lists.
   - Reading-size control (persisted).
   - Strings come from next-intl (uz / ru / en), "aiChat" namespace.
   Extended (beyond the delivered drop-in) to keep existing product
   behavior: processing/transcriptReady gating, per-video localStorage
   history, and the auth/quota error copy — the delivered file didn't
   need these because it wasn't wired to this app's AI pipeline yet.
   ============================================================ */

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
}

interface AIChatPopupProps {
	videoId: string;
	onVideoJump: (seconds: number) => void;
	onClose: () => void;
	isOpen?: boolean;
	/** Whole AI pipeline still running — disables the ask box. */
	processing?: boolean;
	/** False once transcription is done but the transcript is empty/missing. */
	transcriptReady?: boolean;
}

// UUIDs never collide, unlike a counter reseeded from saved.length on reload
// (which duplicated ids for non-contiguous history and rendered messages on
// top of each other).
function nextMsgId() {
	return `msg-${crypto.randomUUID()}`;
}

// The A/A reading-size toggle was removed (owner decision, 2026-08-03): one
// fixed comfortable size lives in ai-chat.css (.ai-body font-size). The old
// persisted preference is cleaned up in an effect below.

function parseMmSsToSeconds(mmss: string): number {
	const parts = mmss.split(":");
	if (parts.length === 2) {
		return parseInt(parts[0] ?? "0", 10) * 60 + parseInt(parts[1] ?? "0", 10);
	}
	if (parts.length === 3) {
		return (
			parseInt(parts[0] ?? "0", 10) * 3600 +
			parseInt(parts[1] ?? "0", 10) * 60 +
			parseInt(parts[2] ?? "0", 10)
		);
	}
	return 0;
}

/* ---- Theme: follow the app ---- */
type Theme = "light" | "dark";
function readAppTheme(): Theme {
	if (typeof document !== "undefined") {
		if (document.body.classList.contains("dark")) return "dark";
		if (document.body.classList.contains("light")) return "light";
	}
	const cookie = Cookies.get("theme");
	if (cookie === "dark" || cookie === "light") return cookie;
	if (
		typeof window !== "undefined" &&
		window.matchMedia?.("(prefers-color-scheme: dark)").matches
	) {
		return "dark";
	}
	return "light";
}
function useAppTheme(): Theme {
	const [theme, setTheme] = useState<Theme>("light");
	useEffect(() => {
		const update = () => setTheme(readAppTheme());
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["class"],
		});
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		mq.addEventListener("change", update);
		return () => {
			observer.disconnect();
			mq.removeEventListener("change", update);
		};
	}, []);
	return theme;
}

/* ---- Inline: **bold** + [mm:ss] citations ---- */

/** One timestamp, e.g. `4:12` or `1:45:45`. */
const TIMESTAMP = String.raw`\d{1,3}:\d{2}(?::\d{2})?`;

// The model routinely groups citations into ONE bracket — "[1:45:45, 2:01:40]" —
// and the old pattern only accepted a bracket holding a single timestamp, so
// those groups fell through as plain grey text while their single-timestamp
// neighbours rendered as clickable chips (owner spotted it in the UI, 2026-08-10).
// Accepting a comma/semicolon separated LIST and emitting one chip per timestamp
// makes every citation clickable regardless of how the model chose to group them.
const INLINE_RE = new RegExp(
	String.raw`\[(${TIMESTAMP}(?:\s*[,;]\s*${TIMESTAMP})*)\]|\*\*(.+?)\*\*`,
	"g",
);

export function renderInline(
	text: string,
	onVideoJump: (seconds: number) => void,
	keyBase: string,
): React.ReactNode[] {
	const re = new RegExp(INLINE_RE.source, "g");
	const out: React.ReactNode[] = [];
	let last = 0;
	let i = 0;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex walk
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) out.push(text.slice(last, m.index));
		if (m[1]) {
			const stamps = m[1]
				.split(/\s*[,;]\s*/)
				.map((s) => s.trim())
				.filter(Boolean);
			stamps.forEach((stamp, s) => {
				const secs = parseMmSsToSeconds(stamp);
				// Keep the comma the model wrote. Joining the chips with a bare
				// space would quietly edit the sentence the user is reading.
				if (s > 0) out.push(", ");
				out.push(
					<button
						key={`${keyBase}-c${i}-${s}`}
						type="button"
						className="ai-citation"
						onClick={() => onVideoJump(secs)}
					>
						[{stamp}]
					</button>,
				);
			});
		} else if (m[2]) {
			out.push(<strong key={`${keyBase}-b${i}`}>{m[2]}</strong>);
		}
		last = m.index + m[0].length;
		i++;
	}
	if (last < text.length) out.push(text.slice(last));
	return out;
}

/* ---- Parse an assistant answer into calm blocks ---- */
type Block =
	| { kind: "section"; label: string }
	| { kind: "bullet"; text: string }
	| { kind: "para"; text: string };

interface ParsedAnswer {
	structured: boolean;
	tldr: string | null;
	blocks: Block[];
}

function parseAnswer(content: string): ParsedAnswer {
	const lines = content.replace(/\r/g, "").split("\n");
	const blocks: Block[] = [];
	let structured = false;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
		const boldHeading = line.match(/^\*\*(.+?)\*\*:?\s*$/);
		const bullet = line.match(/^[-*•]\s+(.+)$/);
		const numbered = line.match(/^\d+[.)]\s+(.+)$/);
		if (heading) {
			blocks.push({ kind: "section", label: heading[1] ?? "" });
			structured = true;
		} else if (boldHeading) {
			blocks.push({ kind: "section", label: boldHeading[1] ?? "" });
			structured = true;
		} else if (bullet) {
			blocks.push({ kind: "bullet", text: bullet[1] ?? "" });
			structured = true;
		} else if (numbered) {
			blocks.push({ kind: "bullet", text: numbered[1] ?? "" });
			structured = true;
		} else {
			blocks.push({ kind: "para", text: line });
		}
	}

	// If structured and it opens with a short lead paragraph, lift it as TL;DR.
	let tldr: string | null = null;
	if (structured && blocks[0]?.kind === "para") {
		const lead = blocks[0] as { kind: "para"; text: string };
		if (lead.text.length <= 240) {
			tldr = lead.text;
			blocks.shift();
		}
	}
	return { structured, tldr, blocks };
}

function AnswerBody({
	content,
	tldrLabel,
	onVideoJump,
}: {
	content: string;
	tldrLabel: string;
	onVideoJump: (seconds: number) => void;
}) {
	const { structured, tldr, blocks } = parseAnswer(content);

	// Adaptive: plain answers stay a simple, readable bubble.
	if (!structured) {
		// By construction (parseAnswer only sets structured=true when a
		// heading/bullet is found), every block here is "para" — but the type
		// is still the Block union, so fall back to the label for the
		// theoretical "section" case rather than assuming .text exists.
		return (
			<div className="ai-answer plain">
				{blocks.map((b, i) => (
					<p key={`p-${i}`}>
						{renderInline(
							b.kind === "section" ? b.label : b.text,
							onVideoJump,
							`p-${i}`,
						)}
					</p>
				))}
			</div>
		);
	}

	// Group consecutive bullets into one list.
	const rendered: React.ReactNode[] = [];
	let bulletBuf: Extract<Block, { kind: "bullet" }>[] = [];
	const flush = (key: string) => {
		if (bulletBuf.length === 0) return;
		rendered.push(
			<div className="ai-bullets" key={`bl-${key}`}>
				{bulletBuf.map((b, i) => (
					<div className="ai-bullet" key={`b-${key}-${i}`}>
						<span className="bdot" />
						<span className="txt">
							{renderInline(b.text, onVideoJump, `b-${key}-${i}`)}
						</span>
					</div>
				))}
			</div>,
		);
		bulletBuf = [];
	};

	blocks.forEach((b, i) => {
		if (b.kind === "bullet") {
			bulletBuf.push(b);
			return;
		}
		flush(`${i}`);
		if (b.kind === "section") {
			rendered.push(
				<div className="ai-section" key={`s-${i}`}>
					<div className="hd">
						<span className="dot" />
						<span className="lbl">{b.label}</span>
					</div>
				</div>,
			);
		} else {
			rendered.push(
				<div className="ai-para" key={`pa-${i}`}>
					{renderInline(b.text, onVideoJump, `pa-${i}`)}
				</div>,
			);
		}
	});
	flush("end");

	return (
		<div className="ai-answer structured">
			{tldr && (
				<div className="ai-tldr">
					<span className="lbl">{tldrLabel}</span>
					<span className="txt">{renderInline(tldr, onVideoJump, "tldr")}</span>
				</div>
			)}
			{rendered}
		</div>
	);
}

function OrbIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			aria-hidden="true"
		>
			<path
				d="M12 7.5 13.4 11.2 17 12l-3.6 1L12 16.5 10.6 13 7 12l3.6-.8z"
				fill="currentColor"
				stroke="none"
			/>
			<circle cx="17.5" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
		</svg>
	);
}

type ChipKind = "summary" | "tasks" | "email" | "decisions";

function ChipIcon({ kind }: { kind: ChipKind }) {
	const common = {
		width: 16,
		height: 16,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.9,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
		"aria-hidden": true,
	};
	if (kind === "summary")
		return (
			<svg {...common}>
				<path d="M4 6h16M4 11h16M4 16h10" />
			</svg>
		);
	if (kind === "tasks")
		return (
			<svg {...common}>
				<path d="m3 7 1.6 1.6L8 5" />
				<path d="m3 17 1.6 1.6L8 15" />
				<path d="M11 7h10M11 17h10" />
			</svg>
		);
	if (kind === "email")
		return (
			<svg {...common}>
				<rect x="3" y="5" width="18" height="14" rx="2.5" />
				<path d="m3.5 7 8.5 6 8.5-6" />
			</svg>
		);
	return (
		<svg {...common}>
			<path d="M12 2.6l2.5 1.85 3.1.05.05 3.1L19.4 10l-1.85 2.5.05 3.1-3.1.05L12 17.4l-2.5-1.85-3.1-.05-.05-3.1L4.6 10l1.85-2.5-.05-3.1 3.1-.05z" />
			<path d="m9.2 10.2 2 2 3.6-3.6" />
		</svg>
	);
}

export function AIChatPopup({
	videoId,
	onVideoJump,
	onClose,
	isOpen = false,
	processing = false,
	transcriptReady = true,
}: AIChatPopupProps) {
	const t = useTranslations("aiChat");
	// Auth/quota error copy stays on the "share" namespace — the delivered
	// aiChat i18n block only covers the calm UI shell, not backend error cases.
	const tShare = useTranslations("share");
	const theme = useAppTheme();

	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	// Expanded = the chat fills the window. A long answer (a meeting summary, a
	// task list) wraps after two or three words in a 400px column, which is what
	// made it hard to read. The drag handle could already do this, but by hand,
	// every time.
	const [isExpanded, setIsExpanded] = useState(false);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);
	const abortRef = useRef<AbortController | null>(null);
	const resizeState = useRef<{
		startX: number;
		startY: number;
		startW: number;
		startH: number;
	} | null>(null);

	const QUICK_ACTIONS: { kind: ChipKind; label: string; query: string }[] = [
		{ kind: "summary", label: t("chipSummary"), query: t("chipSummaryQuery") },
		{ kind: "tasks", label: t("chipTasks"), query: t("chipTasksQuery") },
		{ kind: "email", label: t("chipFollowUp"), query: t("chipFollowUpQuery") },
		{ kind: "decisions", label: t("chipDecisions"), query: t("chipDecisionsQuery") },
	];

	const inputDisabled = isStreaming || processing || !transcriptReady;
	const inputPlaceholder = processing
		? tShare("aiInputDisabledPlaceholder")
		: !transcriptReady
			? tShare("aiTranscriptNotReady")
			: t("placeholder");

	// One-time cleanup of the removed reading-size preference.
	useEffect(() => {
		try {
			localStorage.removeItem("aiChatReading");
		} catch {
			// storage disabled — nothing to clean
		}
	}, []);

	useEffect(() => {
		if (!isOpen) return;
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", handleKey);
		return () => window.removeEventListener("keydown", handleKey);
	}, [isOpen, onClose]);

	// Focus the input on open; return focus to the trigger on close.
	useEffect(() => {
		if (!isOpen) return;
		const previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const frame = window.requestAnimationFrame(() => {
			const el = textareaRef.current;
			el?.focus();
			if (document.activeElement !== el) {
				closeButtonRef.current?.focus();
			}
		});
		return () => {
			window.cancelAnimationFrame(frame);
			previouslyFocused?.focus();
		};
	}, [isOpen]);

	// Abort any in-flight stream when the popup unmounts.
	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

	const messageCount = messages.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on new messages / streaming
	useEffect(() => {
		const body = messagesEndRef.current;
		if (body) body.scrollTop = body.scrollHeight;
	}, [messageCount, isStreaming]);

	// Per-video chat history (owner: keep history for that video only) so a
	// refresh doesn't wipe it. UUID ids mean no reseed/collision risk on load.
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(`data365:aiChat:${videoId}`);
			if (!raw) return;
			const saved = JSON.parse(raw) as Message[];
			if (Array.isArray(saved) && saved.length > 0) {
				setMessages(saved.map((m) => ({ ...m, id: nextMsgId() })));
			}
		} catch {
			// ignore (storage disabled / bad JSON)
		}
	}, [videoId]);

	useEffect(() => {
		// Skip empty so the first mount (before load applies) can't clobber a
		// stored history with [].
		if (messages.length === 0) return;
		try {
			window.localStorage.setItem(
				`data365:aiChat:${videoId}`,
				JSON.stringify(messages),
			);
		} catch {
			// ignore
		}
	}, [messages, videoId]);

	const adjustTextarea = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
	};

	const sendMessage = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || isStreaming || processing || !transcriptReady) return;

			const userMsg: Message = {
				id: nextMsgId(),
				role: "user",
				content: trimmed,
			};
			const nextMessages = [...messages, userMsg];
			setMessages(nextMessages);
			setInput("");
			if (textareaRef.current) textareaRef.current.style.height = "auto";
			setIsStreaming(true);

			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			let assistantContent = "";

			try {
				const response = await fetch("/api/video/ai/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoId,
						messages: nextMessages.map((m) => ({
							role: m.role,
							content: m.content,
						})),
					}),
					signal: controller.signal,
				});

				if (!response.ok || !response.body) {
					let errorText = t("errorGeneric");
					if (response.status === 403) {
						let body: { error?: string } = {};
						try {
							body = await response.clone().json();
						} catch {
							// non-JSON body — fall through to generic auth message
						}
						errorText =
							body.error === "ai_access_required"
								? tShare("aiProRequired")
								: tShare("aiAuthRequired");
					} else if (response.status === 401) {
						errorText = tShare("aiAuthRequired");
					} else if (response.status === 429) {
						let body: { error?: string; code?: string } = {};
						try {
							body = await response.clone().json();
						} catch {
							// non-JSON body (e.g. legacy per-minute limiter) — fall
							// through to the generic busy message below.
						}
						errorText =
							body.error === "daily_limit" || body.code === "daily_limit"
								? tShare("aiChatDailyLimit")
								: tShare("aiBusy");
					}
					setMessages((prev) => [
						...prev,
						{ id: nextMsgId(), role: "assistant", content: errorText },
					]);
					return;
				}

				const assistantId = nextMsgId();
				setMessages((prev) => [
					...prev,
					{ id: assistantId, role: "assistant", content: "" },
				]);

				const reader = response.body.getReader();
				const decoder = new TextDecoder();

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					const chunk = decoder.decode(value, { stream: true });
					for (const line of chunk.split("\n")) {
						const trimmedLine = line.trim();
						if (!trimmedLine.startsWith("data:")) continue;
						const payload = trimmedLine.slice(5).trim();
						if (payload === "[DONE]") break;
						try {
							const parsed = JSON.parse(payload) as {
								token?: string;
								error?: string;
							};
							if (parsed.error) {
								assistantContent = tShare("aiAnswerError", {
									error: parsed.error,
								});
								setMessages((prev) => {
									const updated = [...prev];
									const lastMsg = updated[updated.length - 1];
									if (lastMsg?.role === "assistant") {
										updated[updated.length - 1] = {
											...lastMsg,
											content: assistantContent,
										};
									}
									return updated;
								});
							} else if (parsed.token) {
								assistantContent += parsed.token;
								setMessages((prev) => {
									const updated = [...prev];
									const lastMsg = updated[updated.length - 1];
									if (lastMsg?.role === "assistant") {
										updated[updated.length - 1] = {
											...lastMsg,
											content: assistantContent,
										};
									}
									return updated;
								});
							}
						} catch {
							/* non-JSON SSE line */
						}
					}
				}
			} catch (err) {
				if ((err as Error).name !== "AbortError") {
					setMessages((prev) => [
						...prev,
						{ id: nextMsgId(), role: "assistant", content: t("errorGeneric") },
					]);
				}
			} finally {
				setIsStreaming(false);
				abortRef.current = null;
			}
		},
		[videoId, messages, isStreaming, processing, transcriptReady, t, tShare],
	);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage(input);
		}
	};

	const onResizeMouseDown = (e: React.MouseEvent) => {
		e.preventDefault();
		const el = popupRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		resizeState.current = {
			startX: e.clientX,
			startY: e.clientY,
			startW: rect.width,
			startH: rect.height,
		};
		const onMove = (ev: MouseEvent) => {
			if (!resizeState.current || !popupRef.current) return;
			const dx = resizeState.current.startX - ev.clientX;
			const dy = resizeState.current.startY - ev.clientY;
			popupRef.current.style.width = `${Math.max(320, resizeState.current.startW + dx)}px`;
			popupRef.current.style.height = `${Math.max(380, resizeState.current.startH + dy)}px`;
		};
		const onUp = () => {
			resizeState.current = null;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	// The drag-resize writes width/height as INLINE styles, and inline beats any
	// stylesheet rule — so an `.expanded` CSS class alone would silently do
	// nothing for anyone who had ever dragged the corner. Rather than escalate to
	// !important, the inline values are parked on expand and put back on collapse,
	// so a user who sized the panel by hand gets their size back.
	const parkedSizeRef = useRef<{ width: string; height: string } | null>(null);

	const toggleExpanded = () => {
		const el = popupRef.current;
		if (el) {
			if (!isExpanded) {
				parkedSizeRef.current = {
					width: el.style.width,
					height: el.style.height,
				};
				el.style.width = "";
				el.style.height = "";
			} else if (parkedSizeRef.current) {
				el.style.width = parkedSizeRef.current.width;
				el.style.height = parkedSizeRef.current.height;
				parkedSizeRef.current = null;
			}
		}
		setIsExpanded((v) => !v);
	};

	const hasMessages = messages.length > 0;

	return (
		<div
			ref={popupRef}
			data-theme={theme}
			className={`ai-popup${isOpen ? " open" : ""}${
				isExpanded ? " expanded" : ""
			}`}
			role="dialog"
			aria-label={t("title")}
			aria-hidden={!isOpen}
			inert={!isOpen}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: mouse-only resize handle */}
			<div className="ai-resize" onMouseDown={onResizeMouseDown} />

			<div className="ai-hd">
				<div className="ai-orb">
					<OrbIcon />
				</div>
				<div className="htxt">
					<div className="t">{t("title")}</div>
					<div className="s">
						{!processing && transcriptReady && <span className="live" />}
						{processing
							? tShare("aiInputDisabledPlaceholder")
							: !transcriptReady
								? tShare("aiTranscriptNotReady")
								: t("subtitle")}
					</div>
				</div>
				<button
					type="button"
					className="ai-expand"
					onClick={toggleExpanded}
					aria-label={isExpanded ? t("collapse") : t("expand")}
					title={isExpanded ? t("collapse") : t("expand")}
					aria-pressed={isExpanded}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						{isExpanded ? (
							<path d="M9 3v6H3M15 21v-6h6M21 3l-6 6M3 21l6-6" />
						) : (
							<path d="M9 3H3v6M15 21h6v-6M21 9V3h-6M3 15v6h6" />
						)}
					</svg>
				</button>
				<button
					ref={closeButtonRef}
					type="button"
					className="ai-x"
					onClick={onClose}
					aria-label={t("close")}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						aria-hidden="true"
					>
						<path d="M18 6 6 18M6 6l12 12" />
					</svg>
				</button>
			</div>

			<div className="ai-body" ref={messagesEndRef}>
				{!hasMessages && inputDisabled && (
					<div className="ai-welcome">
						<div className="ws">{inputPlaceholder}</div>
					</div>
				)}

				{!hasMessages && !inputDisabled && (
					<>
						<div className="ai-welcome">
							<div className="wt">{t("welcomeTitle")}</div>
							<div className="ws">{t("welcomeSubtitle")}</div>
						</div>
						<div className="ai-chips">
							{QUICK_ACTIONS.map((action) => (
								<button
									key={action.query}
									type="button"
									className="ai-chip"
									onClick={() => sendMessage(action.query)}
								>
									<span className="ic">
										<ChipIcon kind={action.kind} />
									</span>
									{action.label}
									<span className="arr">›</span>
								</button>
							))}
						</div>
					</>
				)}

				{messages.map((msg) =>
					msg.role === "user" ? (
						<div key={msg.id} className="ai-msg user">
							<div className="ai-avatar me">{t("you")}</div>
							<div className="bubble">{msg.content}</div>
						</div>
					) : (
						<div key={msg.id} className="ai-msg ai">
							<div className="ai-avatar ai">
								<OrbIcon />
							</div>
							<div className="content">
								{msg.content ? (
									<AnswerBody
										content={msg.content}
										tldrLabel={t("tldr")}
										onVideoJump={onVideoJump}
									/>
								) : (
									<div className="ai-typing">
										<span />
										<span />
										<span />
									</div>
								)}
							</div>
						</div>
					),
				)}

				{isStreaming && messages[messages.length - 1]?.role !== "assistant" && (
					<div className="ai-msg ai">
						<div className="ai-avatar ai">
							<OrbIcon />
						</div>
						<div className="ai-typing">
							<span />
							<span />
							<span />
						</div>
					</div>
				)}
			</div>

			<div className="ai-foot">
				<div className="ai-inputbar">
					<textarea
						ref={textareaRef}
						rows={1}
						placeholder={inputPlaceholder}
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							adjustTextarea();
						}}
						onKeyDown={handleKeyDown}
						disabled={inputDisabled}
					/>
					<button
						type="button"
						className="ai-send"
						onClick={() => sendMessage(input)}
						disabled={!input.trim() || inputDisabled}
						aria-label={t("send")}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.4"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12 20V5" />
							<path d="m6 11 6-6 6 6" />
						</svg>
					</button>
				</div>
				<div className="ai-disclaimer">{t("disclaimer")}</div>
			</div>
		</div>
	);
}
