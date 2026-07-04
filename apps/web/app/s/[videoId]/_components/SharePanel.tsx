"use client";

import clsx from "clsx";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	formatSeconds,
	parseTimestampToSeconds,
} from "./ai-chat-timestamps";

type PanelTab = "summary" | "tasks" | "transcript" | "refined";

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
}

let msgIdCounter = 0;
function nextMsgId() {
	return `msg-${++msgIdCounter}`;
}

function splitByLineBreak(text: string, keyOffset: number): React.ReactNode[] {
	const lines = text.split("\n");
	const result: React.ReactNode[] = [];
	for (let n = 0; n < lines.length; n++) {
		if (n > 0) result.push(<br key={`br-${keyOffset}-${String(n)}`} />);
		result.push(lines[n]);
	}
	return result;
}

function renderBoldAndBreaks(
	text: string,
	keyOffset: number,
): React.ReactNode[] {
	const boldRegex = /\*\*(.+?)\*\*/g;
	const segments: React.ReactNode[] = [];
	let last = 0;
	let match: RegExpExecArray | null;
	let i = keyOffset;

	while (true) {
		match = boldRegex.exec(text);
		if (match === null) break;
		const before = text.slice(last, match.index);
		if (before) {
			segments.push(...splitByLineBreak(before, i));
			i++;
		}
		segments.push(
			<span key={`b-${i++}`} className="font-semibold">
				{match[1]}
			</span>,
		);
		last = match.index + match[0].length;
	}

	const tail = text.slice(last);
	if (tail) {
		segments.push(...splitByLineBreak(tail, i));
	}

	return segments;
}

function renderMessageContent(
	content: string,
	onVideoJump: (seconds: number) => void,
): React.ReactNode[] {
	const citationRegex = /\[(\d{1,3}:\d{2}(?::\d{2})?)\]/g;
	const parts: React.ReactNode[] = [];
	let last = 0;
	let match: RegExpExecArray | null;

	while (true) {
		match = citationRegex.exec(content);
		if (match === null) break;
		const before = content.slice(last, match.index);
		if (before) {
			parts.push(...renderBoldAndBreaks(before, parts.length));
		}
		const timestamp = match[1] ?? "";
		const seconds = parseTimestampToSeconds(timestamp);
		parts.push(
			<button
				key={`cite-${match.index}`}
				type="button"
				className="inline-block rounded-md border border-[var(--brand)] bg-[var(--brand-wash)] px-1.5 text-xs font-medium text-[var(--brand)] transition-[filter] hover:brightness-95"
				onClick={() => onVideoJump(seconds)}
			>
				{`[${formatSeconds(seconds)}]`}
			</button>,
		);
		last = match.index + match[0].length;
	}

	const tail = content.slice(last);
	if (tail) {
		parts.push(...renderBoldAndBreaks(tail, parts.length + 1000));
	}

	return parts;
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
		rawParam === "tasks" ||
		rawParam === "transcript" ||
		rawParam === "refined"
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
		chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
	}, [messageCount, isStreaming]);

	useEffect(() => {
		return () => abortRef.current?.abort();
	}, []);

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
	const activeContent = panels.find((p) => p.id === effectiveActiveTab)?.content;

	return (
		<div className="flex w-full flex-col overflow-hidden rounded-2xl border border-gray-4 bg-gray-1 shadow-[0_2px_6px_rgba(15,23,42,.06),0_8px_20px_rgba(15,23,42,.08)] lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
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
									className="ml-6 self-end rounded-xl rounded-br-sm bg-gray-3 px-3 py-1.5 text-[13px] leading-relaxed text-gray-12"
								>
									{msg.content}
								</div>
							) : (
								<div
									key={msg.id}
									className="self-start text-[13px] leading-relaxed text-gray-12"
								>
									{renderMessageContent(msg.content, onVideoJump)}
								</div>
							),
						)}
						{isStreaming &&
							messages[messages.length - 1]?.role !== "assistant" && (
								<div
									className="flex gap-1 self-start py-1"
									aria-hidden="true"
								>
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
				<div className="flex items-end gap-2">
					<textarea
						ref={textareaRef}
						rows={1}
						placeholder={processing ? t("aiInputDisabledPlaceholder") : t("aiAskPlaceholder")}
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
