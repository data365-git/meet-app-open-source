"use client";

import clsx from "clsx";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";

/* ------------------------------------------------------------------
   Wave 2.5: the inline (`?variant=inline`) chat that used to live in
   this panel's footer was DELETED — the owner-delivered "modal" design
   (AIFab + AIChatPopup, rendered by ShareVideo) is now the only chat
   surface. SharePanel is left as the theme-token tab shell for
   Summary/Tasks/Transcript/Refined. ShareVideo.tsx (not owned by this
   change) still passes `chatVariant`/`processing` props for backward
   compatibility; they're accepted but no longer change behavior here.
   See docs/plans/2026-07-19-wave25-handoff.md for the exact ShareVideo
   cleanup patch that removes the now-dead `?variant=inline` plumbing.
   ------------------------------------------------------------------ */

type PanelTab = "summary" | "tasks" | "transcript" | "refined";

interface SharePanelProps {
	/** Unused since the inline chat was deleted (Wave 2.5) — kept only because
	 * ShareVideo.tsx (not owned by this change) still passes it. */
	videoId: string;
	/** Unused since the inline chat was deleted (Wave 2.5) — kept only because
	 * ShareVideo.tsx (not owned by this change) still passes it. */
	onVideoJump: (seconds: number) => void;
	summary: React.ReactNode;
	tasks: React.ReactNode;
	transcript: React.ReactNode;
	refined: React.ReactNode;
	/** Unused since the inline chat was deleted (Wave 2.5) — kept only because
	 * ShareVideo.tsx (not owned by this change) still passes it. */
	processing?: boolean;
	/** False once transcription is done but the transcript is empty/missing —
	 * matches what `ensureTranscriptIndex` (chat/route.ts) requires. */
	transcriptReady?: boolean;
	/** True once AI GENERATION (summary/tasks/refined) is COMPLETE/SKIPPED. Used
	 * so the Transcript tab stays reachable while only AI-generation is still
	 * running — the transcript doesn't have to wait for the summary to finish. */
	aiContentReady?: boolean;
	/** Dead since Wave 2.5 (the "inline" chat variant was deleted) — kept only
	 * because ShareVideo.tsx (not owned by this change) still passes it. */
	chatVariant?: "modal" | "inline";
}

export function SharePanel({
	summary,
	tasks,
	transcript,
	refined,
	transcriptReady = true,
	aiContentReady = true,
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

	// Per-tab readiness: Summary is always reachable (it hosts the live AI-status
	// view while processing). Transcript unlocks the moment the transcript is
	// ready — it must NOT wait for the summary/refine generation. Tasks + Refined
	// come out of AI generation, so they unlock only when that is complete.
	const tabReady: Record<PanelTab, boolean> = {
		summary: true,
		tasks: aiContentReady,
		transcript: transcriptReady,
		refined: aiContentReady,
	};
	// Fall back to Summary only when the selected tab isn't ready yet.
	const effectiveActiveTab: PanelTab = tabReady[activeTab] ? activeTab : "summary";

	const handleTabClick = useCallback(
		(id: PanelTab) => {
			setActiveTab(id);
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", id);
			router.replace(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams],
	);

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
					const isLocked = !tabReady[tab.id];
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={isActive}
							aria-controls={`panel-${tab.id}`}
							id={`tab-${tab.id}`}
							onClick={() => handleTabClick(tab.id)}
							disabled={isLocked}
							title={isLocked ? t("tabLockedHint") : undefined}
							className={clsx(
								"-mb-px min-h-11 flex-1 shrink-0 whitespace-nowrap border-b-2 px-3 text-[13.5px] font-semibold transition-colors",
								isActive
									? "border-[var(--brand)] text-[var(--brand)]"
									: "border-transparent text-gray-11 hover:text-gray-12",
								isLocked && "cursor-not-allowed opacity-45 pointer-events-none",
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
		</div>
	);
}
