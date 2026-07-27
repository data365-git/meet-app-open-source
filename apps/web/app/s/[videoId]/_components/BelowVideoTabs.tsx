"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";

type TabId = "summary" | "tasks" | "transcript" | "refined";

const TABS: { id: TabId; label: string }[] = [
	{ id: "summary", label: "Summary" },
	{ id: "tasks", label: "Tasks" },
	{ id: "transcript", label: "Transcript" },
	{ id: "refined", label: "Refined" },
];

interface BelowVideoTabsProps {
	summary?: React.ReactNode;
	tasks?: React.ReactNode;
	transcript?: React.ReactNode;
	refined?: React.ReactNode;
	headerAction?: React.ReactNode;
}

export function BelowVideoTabs({
	summary,
	tasks,
	transcript,
	refined,
	headerAction,
}: BelowVideoTabsProps) {
	const searchParams = useSearchParams();
	const router = useRouter();

	const rawParam = searchParams.get("tab");
	const initialTab: TabId =
		rawParam === "tasks" ||
		rawParam === "transcript" ||
		rawParam === "refined" ||
		rawParam === "summary"
			? rawParam
			: "summary";

	const [activeTab, setActiveTab] = useState<TabId>(initialTab);

	const handleTabClick = useCallback(
		(id: TabId) => {
			setActiveTab(id);
			// Update URL param for shareability (no scroll/navigation).
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", id);
			router.replace(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams],
	);

	const panels: Record<TabId, React.ReactNode> = {
		summary,
		tasks,
		transcript,
		refined,
	};

	return (
		<div className="flex flex-col w-full">
			{headerAction && (
				<div className="flex justify-end mb-2">{headerAction}</div>
			)}
			{/* Tab bar */}
			<div
				className="border-b border-gray-200"
				style={{
					fontFamily:
						"-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
					display: "flex",
					gap: "4px",
					padding: "8px",
					background: "rgba(255,255,255,0.95)",
					borderRadius: "16px 16px 0 0",
				}}
			>
				{TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						onClick={() => handleTabClick(tab.id)}
						style={{
							flex: 1,
							padding: "9px 8px",
							fontSize: "13.5px",
							fontWeight: 600,
							textAlign: "center",
							cursor: "pointer",
							color: activeTab === tab.id ? "#7c3aed" : "#475569",
							border: "none",
							borderRadius: "9px",
							background: activeTab === tab.id ? "#f5f3ff" : "none",
							boxShadow:
								activeTab === tab.id
									? "inset 0 0 0 1px rgba(124, 58, 237, .14)"
									: "none",
							position: "relative",
							transition:
								"color 320ms cubic-bezier(.22,.61,.36,1), background 320ms cubic-bezier(.22,.61,.36,1)",
						}}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Only the active panel is rendered — true tab switching. */}
			<section className="bg-white border border-gray-200 rounded-xl shadow-sm p-5 mt-3">
				{panels[activeTab]}
			</section>
		</div>
	);
}
