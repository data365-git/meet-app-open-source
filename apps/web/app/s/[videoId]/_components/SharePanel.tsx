"use client";

import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatSeconds, parseTimestampToSeconds } from "./ai-chat-timestamps";
import { renderMarkdownBold } from "./panels/markdownBold";

type PanelTab = "summary" | "tasks" | "transcript" | "refined";

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
}

// Globally-unique per message. A previous module-level counter collided across
// videos: reloading reseeded it from saved.length (not the max saved id), so a
// non-contiguous saved history (msg-1,msg-2,msg-7,…) produced NEW ids that
// duplicated existing ones → duplicate React keys → messages rendered on top of
// each other. A UUID can never collide, so no reseed is needed on load.
function nextMsgId() {
	return `msg-${crypto.randomUUID()}`;
}

// Split the message into keyed text spans and clickable timestamp chips.
// Every node carries a stable position-based key (t-0, c-1, t-2, …) and line
// breaks are handled by `whitespace-pre-wrap` on the container — NOT by an
// array of unkeyed strings + <br>, which reconciled badly while the answer was
// streaming and left overlapping text on screen.
function renderMessageContent(
	content: string,
	onVideoJump: (seconds: number) => void,
): React.ReactNode[] {
	const citationRegex = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
	const nodes: React.ReactNode[] = [];
	let last = 0;
	let match: RegExpExecArray | null;
	let key = 0;

	while (true) {
		match = citationRegex.exec(content);
		if (match === null) break;
		const before = content.slice(last, match.index);
		if (before) {
			nodes.push(
				<span
					key={`t-${key++}`}
					className="break-words [overflow-wrap:anywhere]"
				>
					{renderMarkdownBold(before)}
				</span>,
			);
		}
		const seconds = parseTimestampToSeconds(match[1] ?? "");
		nodes.push(
			<button
				key={`c-${key++}`}
				type="button"
				className="mx-0.5 inline-flex max-w-full shrink-0 items-center align-baseline rounded-md border border-[var(--brand)] bg-[var(--brand-wash)] px-1.5 text-xs font-medium text-[var(--brand)] transition-[filter] hover:brightness-95"
				onClick={() => onVideoJump(seconds)}
			>
				{`[${formatSeconds(seconds)}]`}
			</button>,
		);
		last = match.index + match[0].length;
	}

	const tail = content.slice(last);
	if (tail) {
		nodes.push(
			<span key={`t-${key++}`} className="break-words [overflow-wrap:anywhere]">
				{renderMarkdownBold(tail)}
			</span>,
		);
	}

	return nodes;
}

interface SharePanelProps {
	videoId: string;
	onVideoJump: (seconds: number) => void;
	summary: React.ReactNode;
	tasks: React.ReactNode;
	transcript: React.ReactNode;
	refined: React.ReactNode;
	processing?: boolean;
}

export function SharePanel({
	videoId,
	onVideoJump,
	summary,
	tasks,
	transcript,
	refined,
	processing,
}: SharePanelProps) {
	const t = useTranslations("share");
	const searchParams = useSearchParams();
	const router = useRouter();

	const rawParam = searchParams.get("tab");
	const initialTab: PanelTab =
		rawParam === "tasks" || rawParam === "transcript" || rawParam === "refined"
			? rawParam
			: "summary";
	const [activeTab, setActiveTab] = useState<PanelTab>(initialTab);
	const effectiveActiveTab: PanelTab = processing ? "summary" : activeTab;

	const handleTabClick = useCallback(
		(id: PanelTab) => {
			setActiveTab(id);
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", id);
			router.replace(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams],
	);

	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [isStreaming, setIsStreaming] = useState(false);
	const chatEndRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const abortRef = useRef<AbortController | null>(null);

	const messageCount = messages.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional scroll trigger on message count and streaming state changes
	useEffect(() => {
		chatEndRef.current?.scrollIntoView({
			behavior: "smooth",
			block: "nearest",
		});
	}, [messageCount, isStreaming]);

	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

	// Persist the chat per-video (owner: keep history for that video only) so a
	// refresh no longer wipes it. Load once per videoId; ids are UUIDs, so no
	// counter reseed is needed to avoid collisions with the restored messages.
	useEffect(() => {
		try {
			const raw = window.localStorage.getItem(`data365:aiChat:${videoId}`);
			if (!raw) return;
			const saved = JSON.parse(raw) as Message[];
			if (Array.isArray(saved) && saved.length > 0) {
				// Re-key every restored message with a fresh UUID. This heals any
				// history persisted by the old counter that already contains
				// duplicate ids (which is exactly what rendered messages on top of
				// each other), guaranteeing unique React keys from now on.
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
		el.style.height = `${Math.min(el.scrollHeight, 90)}px`;
	};

	const sendMessage = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || isStreaming) return;

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
					let errorText = t("aiError");
					if (response.status === 403) {
						let body: { error?: string } = {};
						try {
							body = await response.clone().json();
						} catch {
							// non-JSON body — fall through to generic auth message
						}
						errorText =
							body.error === "ai_access_required"
								? t("aiProRequired")
								: t("aiAuthRequired");
					} else if (response.status === 401) {
						errorText = t("aiAuthRequired");
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
								? t("aiChatDailyLimit")
								: t("aiBusy");
					}
					setMessages((prev) => [
						...prev,
						{
							id: nextMsgId(),
							role: "assistant",
							content: errorText,
						},
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
					const lines = chunk.split("\n");

					for (const line of lines) {
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
								// Surface the server's error as the assistant reply instead
								// of leaving a blank/empty message.
								assistantContent = t("aiAnswerError", {
									error: parsed.error,
								});
								setMessages((prev) => {
									const updated = [...prev];
									const last = updated[updated.length - 1];
									if (last?.role === "assistant") {
										updated[updated.length - 1] = {
											...last,
											content: assistantContent,
										};
									}
									return updated;
								});
							} else if (parsed.token) {
								assistantContent += parsed.token;
								setMessages((prev) => {
									const updated = [...prev];
									const last = updated[updated.length - 1];
									if (last?.role === "assistant") {
										updated[updated.length - 1] = {
											...last,
											content: assistantContent,
										};
									}
									return updated;
								});
							}
						} catch {
							// non-JSON SSE lines skipped
						}
					}
				}
			} catch (err) {
				if ((err as Error).name !== "AbortError") {
					setMessages((prev) => [
						...prev,
						{
							id: nextMsgId(),
							role: "assistant",
							content: t("aiError"),
						},
					]);
				}
			} finally {
				setIsStreaming(false);
				abortRef.current = null;
			}
		},
		[videoId, messages, isStreaming, t],
	);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage(input);
		}
	};

	const clearChat = () => {
		abortRef.current?.abort();
		setMessages([]);
		setIsStreaming(false);
	};

	const TABS: { id: PanelTab; label: string }[] = [
		{ id: "summary", label: t("tabSummaryShort") },
		{ id: "tasks", label: t("tabTasksShort") },
		{ id: "transcript", label: t("tabTranscriptShort") },
		{ id: "refined", label: t("tabRefinedShort") },
	];

	const panels: { id: PanelTab; content: React.ReactNode }[] = [
		{ id: "summary", content: summary },
		{ id: "tasks", content: tasks },
		{ id: "transcript", content: transcript },
		{ id: "refined", content: refined },
	];
	const activeContent = panels.find(
		(p) => p.id === effectiveActiveTab,
	)?.content;

	return (
		<div className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-4 bg-gray-1 shadow-[0_2px_6px_rgba(15,23,42,.06),0_8px_20px_rgba(15,23,42,.08)]">
			<div
				role="tablist"
				aria-label={t("tabsAriaLabel")}
				className="flex shrink-0 overflow-x-auto border-b border-gray-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
			>
				{TABS.map((tab) => {
					const isActive = effectiveActiveTab === tab.id;
					const isDisabledByProcessing = processing && tab.id !== "summary";
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							aria-controls={`panel-${tab.id}`}
							id={`tab-${tab.id}`}
							onClick={() => handleTabClick(tab.id)}
							disabled={isDisabledByProcessing}
							className={clsx(
								"-mb-px min-h-11 flex-1 shrink-0 whitespace-nowrap border-b-2 px-3 text-[13.5px] font-semibold transition-colors",
								isActive
									? "border-[var(--brand)] text-[var(--brand)]"
									: "border-transparent text-gray-11 hover:text-gray-12",
								isDisabledByProcessing && "opacity-45 pointer-events-none",
							)}
						>
							{tab.label}
						</button>
					);
				})}
			</div>

			<div
				id={`panel-${effectiveActiveTab}`}
				role="tabpanel"
				aria-labelledby={`tab-${effectiveActiveTab}`}
				className="min-h-0 flex-1 overflow-y-auto p-4"
			>
				{activeContent}
			</div>

			{messages.length > 0 && (
				<div className="shrink-0 border-t border-gray-4">
					<div className="flex items-center justify-between px-4 pt-2.5">
						<span className="inline-flex items-center rounded-full bg-[var(--brand-wash)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--brand)]">
							{t("aiChatTitle")}
						</span>
						<button
							type="button"
							onClick={clearChat}
							aria-label={t("aiClearChat")}
							className="flex size-6 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
						>
							<svg
								width="13"
								height="13"
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
					<div className="flex max-h-64 flex-col gap-2.5 overflow-y-auto px-4 py-3">
						{messages.map((msg) =>
							msg.role === "user" ? (
								<div
									key={msg.id}
									className="ml-6 min-w-0 max-w-[85%] shrink-0 self-end break-words whitespace-pre-wrap rounded-xl rounded-br-sm bg-gray-3 px-3 py-1.5 text-[13px] leading-relaxed text-gray-12 [overflow-wrap:anywhere]"
								>
									{msg.content}
								</div>
							) : (
								<div
									key={msg.id}
									className="min-w-0 max-w-full shrink-0 self-start break-words whitespace-pre-wrap text-[13px] leading-relaxed text-gray-12 [overflow-wrap:anywhere]"
								>
									{renderMessageContent(msg.content, onVideoJump)}
								</div>
							),
						)}
						{isStreaming &&
							messages[messages.length - 1]?.role !== "assistant" && (
								<div className="flex gap-1 self-start py-1" aria-hidden="true">
									<span className="size-1.5 animate-pulse rounded-full bg-gray-8" />
									<span className="size-1.5 animate-pulse rounded-full bg-gray-8 [animation-delay:150ms]" />
									<span className="size-1.5 animate-pulse rounded-full bg-gray-8 [animation-delay:300ms]" />
								</div>
							)}
						<div ref={chatEndRef} />
					</div>
				</div>
			)}

			<div className="shrink-0 border-t border-gray-4 p-3">
				{messages.length === 0 && (
					<div className="mb-2.5 flex flex-col gap-1.5">
						<span className="font-mono text-[11px] uppercase tracking-wide text-gray-9">
							{t("suggestedQuestionsLabel")}
						</span>
						<div className="flex flex-wrap gap-1.5">
							{[t("suggestedQ1"), t("suggestedQ2"), t("suggestedQ3")].map(
								(q) => (
									<button
										key={q}
										type="button"
										onClick={() => sendMessage(q)}
										className="rounded-[14px] border border-gray-5 bg-gray-2 px-2.5 py-1.5 text-[13px] text-gray-12 transition-colors hover:bg-gray-3"
									>
										{q}
									</button>
								),
							)}
						</div>
					</div>
				)}
				<div className="flex items-end gap-2">
					<textarea
						ref={textareaRef}
						rows={1}
						placeholder={
							processing
								? t("aiInputDisabledPlaceholder")
								: t("aiAskPlaceholder")
						}
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							adjustTextarea();
						}}
						onKeyDown={handleKeyDown}
						disabled={isStreaming || processing}
						className="min-h-9 flex-1 resize-none rounded-[18px] border border-gray-5 bg-gray-2 px-4 py-2 text-[13px] text-gray-12 placeholder:text-gray-9 focus:border-[var(--brand)] focus:outline-none disabled:opacity-60"
					/>
					<button
						type="button"
						onClick={() => sendMessage(input)}
						disabled={!input.trim() || isStreaming}
						aria-label={t("aiSendAriaLabel")}
						className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						<svg
							width="15"
							height="15"
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
				<p className="mt-1.5 px-1 text-[10.5px] text-gray-9">
					{t("aiDisclaimer")}
				</p>
			</div>
		</div>
	);
}
