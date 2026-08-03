"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { getMonthlySpend } from "@/actions/billing/get-monthly-spend";
import { formatUzs } from "@/lib/format-uzs";

interface MeetingCostPanelProps {
	videoId: string;
}

export function MeetingCostPanel({ videoId }: MeetingCostPanelProps) {
	const t = useTranslations("share");
	const OPERATIONS: { key: string; label: string }[] = [
		{ key: "transcription", label: t("costTranscription") },
		{ key: "summary", label: t("costSummary") },
		{ key: "embedding", label: t("costEmbeddings") },
		{ key: "chat", label: t("costChat") },
	];
	const { data, isLoading, error } = useQuery({
		queryKey: ["cost", videoId],
		queryFn: () => getMonthlySpend({ type: "video", id: videoId }),
		staleTime: 60_000,
	});

	if (isLoading) {
		return null;
	}

	if (error || !data) {
		return (
			<div className="rounded-xl border border-red-100 bg-red-50 px-4 py-6 text-center">
				<p className="text-sm text-red-600">{t("costLoadError")}</p>
			</div>
		);
	}

	const hasActivity = data.totalUsdCents > 0;

	if (!hasActivity) {
		return null;
	}

	const breakdownValues = OPERATIONS.map(({ key }) => data.breakdown[key] ?? 0);
	const allBreakdownZero = breakdownValues.every((v) => v === 0);

	// shrink-0 on the root: globals.css sets `* { min-height: 0 }`, which
	// removes every flex item's content-based minimum height. When the sticky
	// sidebar column (ShareVideo, lg:max-h screen) runs out of room - e.g. many
	// comments - this panel would otherwise be crushed below its text height and
	// the labels, amounts and savings line paint on top of each other. shrink-0
	// restores the intrinsic minimum; the column's overflow-y-auto absorbs the
	// excess.
	return (
		<div className="flex shrink-0 flex-col gap-4">
			<div className="flex flex-col items-center gap-1 rounded-xl px-6 py-5 text-center shadow-sm" style={{ background: "var(--gray-1)", border: "1px solid var(--gray-4)" }}>
				<span className="text-xs font-medium" style={{ color: "var(--gray-11)" }}>
					{t("meetingCost")}
				</span>
				<span className="text-3xl font-bold" style={{ color: "var(--gray-12)" }}>
					{formatUzs(data.totalUsdCents)}
				</span>
			</div>

			{!allBreakdownZero && (
				<div className="grid grid-cols-4 gap-3">
					{OPERATIONS.map(({ key, label }) => {
						const cents = data.breakdown[key] ?? 0;
						return (
							<div
								key={key}
								className="flex flex-col gap-1 rounded-xl px-3 py-3 shadow-sm"
								style={{ background: "var(--gray-1)", border: "1px solid var(--gray-4)" }}
							>
								<span className="text-xs font-medium" style={{ color: "var(--gray-11)" }}>{label}</span>
								<span className="text-sm font-semibold" style={{ color: "var(--gray-12)" }}>
									{formatUzs(cents)}
								</span>
							</div>
						);
					})}
				</div>
			)}

			{/* Price honesty (Wave 2.2): the total above is REAL paid spend only —
			    this surfaces the free-tier ("cheap" mode) share so the owner sees
			    both numbers instead of assuming a low total means AI was cheap.
			    "taxminan" (approximate) because these events don't record the
			    audio/text token split (see getMonthlySpend). */}
			{data.freeTierSavingsUsdCents != null &&
				data.freeTierSavingsUsdCents > 0 && (
					<p
						className="text-center text-xs"
						style={{ color: "var(--gray-10)" }}
					>
						{t("freeTierSavings", {
							amount: formatUzs(data.freeTierSavingsUsdCents),
						})}
					</p>
				)}
		</div>
	);
}
