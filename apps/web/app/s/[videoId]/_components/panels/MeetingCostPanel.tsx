"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { getMonthlySpend } from "@/actions/billing/get-monthly-spend";
import { costTier } from "@/lib/ai-cost-tier";
import { USD_TO_UZS, formatUzs } from "@/lib/format-uzs";

interface MeetingCostPanelProps {
	videoId: string;
	running: boolean;
}

export const costQueryKey = (videoId: string) => ["cost", videoId] as const;

export function MeetingCostPanel({ videoId, running }: MeetingCostPanelProps) {
	const t = useTranslations("share");
	const OPERATIONS: { key: string; label: string }[] = [
		{ key: "transcription", label: t("costTranscription") },
		{ key: "summary", label: t("costSummary") },
		{ key: "embedding", label: t("costEmbeddings") },
		{ key: "chat", label: t("costChat") },
	];
	const { data, isLoading, error } = useQuery({
		queryKey: costQueryKey(videoId),
		queryFn: () => getMonthlySpend({ type: "video", id: videoId }),
		staleTime: 60_000,
		refetchInterval: running ? 5000 : false,
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

	const tier = costTier({
		totalUsdCents: data.totalUsdCents,
		freeEventCount: data.freeEventCount,
	});
	if (!tier) return null;

	const breakdownValues = OPERATIONS.map(({ key }) => data.breakdown[key] ?? 0);
	const allBreakdownZero = breakdownValues.every((v) => v === 0);

	const pillClasses =
		tier === "paid"
			? "inline-flex items-center rounded-full border border-amber-6 bg-amber-3 px-3 py-1 text-xs font-medium text-amber-11"
			: "inline-flex items-center rounded-full border border-green-6 bg-green-3 px-3 py-1 text-xs font-medium text-green-11";

	const pillText = running
		? tier === "paid"
			? t("costLiveSwitchedPaid")
			: t("costLiveFreeSoFar")
		: tier === "paid"
			? t("costBadgePaid")
			: t("costBadgeFree");

	// shrink-0 on the root: globals.css sets `* { min-height: 0 }`, which
	// removes every flex item's content-based minimum height. When the sticky
	// sidebar column (ShareVideo, lg:max-h screen) runs out of room - e.g. many
	// comments - this panel would otherwise be crushed below its text height and
	// the labels, amounts and savings line paint on top of each other. shrink-0
	// restores the intrinsic minimum; the column's overflow-y-auto absorbs the
	// excess.
	return (
		<div className="flex shrink-0 flex-col gap-4">
			<div className="flex flex-col items-center gap-2 rounded-xl px-6 py-5 text-center shadow-sm" style={{ background: "var(--gray-1)", border: "1px solid var(--gray-4)" }}>
				<span className="text-xs font-medium" style={{ color: "var(--gray-11)" }}>
					{t("meetingCost")}
				</span>
				<span className={pillClasses}>{pillText}</span>
				<span className="text-3xl font-bold" style={{ color: "var(--gray-12)" }}>
					{tier === "paid" ? formatUzs(data.totalUsdCents) : t("costPaidNothing")}
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

			{/* Price honesty (Wave 2.2, extended for the paid/free tier badge above):
			    when paid, this is the free-tier ("cheap" mode) share alongside the
			    real spend; when free, it's the plain free-tier-savings line (no
			    paid spend exists yet). "taxminan" (approximate) because these
			    events don't record the audio/text token split (see
			    getMonthlySpend). */}
			{data.freeTierSavingsUsdCents != null &&
				Math.round((data.freeTierSavingsUsdCents / 100) * USD_TO_UZS) >= 1 && (
					<p
						className="text-center text-xs"
						style={{ color: "var(--gray-10)" }}
					>
						{tier === "paid"
							? t("costPartlyFree", {
									amount: formatUzs(data.freeTierSavingsUsdCents),
								})
							: t("freeTierSavings", {
									amount: formatUzs(data.freeTierSavingsUsdCents),
								})}
					</p>
				)}
		</div>
	);
}
