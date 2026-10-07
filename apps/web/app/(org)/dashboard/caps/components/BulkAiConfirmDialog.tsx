"use client";

import { faWandMagicSparkles } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import {
	type BulkAiMode,
	type BulkAiPlan,
	formatAudioLengthUz,
	splitSkippedReasons,
} from "@/lib/bulk-ai";

/**
 * The one price-confirm before a bulk AI start (ADR 2026-10-07 decision 3):
 * count, total audio length, "taxminan" price, and how many of the selection
 * are already done vs. currently being processed - both will be skipped.
 * Nothing runs without "Boshlash".
 *
 * Rendered only while open (the parent mounts/unmounts it), so there is no
 * `open` prop to keep true. Strings are inline Uzbek, following
 * SelectedCapsBar's existing convention (that bar does not use next-intl).
 */
export const BulkAiConfirmDialog = ({
	mode,
	plan,
	running,
	onStart,
	onCancel,
}: {
	mode: BulkAiMode;
	plan: BulkAiPlan;
	/** The start loop is in flight: both buttons lock, spinner on "Boshlash". */
	running: boolean;
	onStart: () => void;
	onCancel: () => void;
}) => {
	const { doneCount, runningCount } = splitSkippedReasons(plan.skipped);
	// F4: "tayyor" and "ishlanmoqda" are different facts - a running job is not
	// ready, and blending the two would promise results that are still cooking.
	const skipParts: string[] = [];
	if (doneCount > 0) skipParts.push(`${doneCount} tasi allaqachon tayyor`);
	if (runningCount > 0)
		skipParts.push(`${runningCount} tasi hozir ishlanmoqda`);
	// Some (not all) durations unknown: the price above covers only the known
	// ones, so say so instead of presenting a partial number as the whole cost.
	const partialPriceNote =
		plan.totalAudioSec > 0 && plan.unknownDurationCount > 0
			? ` (${plan.unknownDurationCount} tasining uzunligi noma'lum - narx to'liq emas)`
			: "";

	return (
		<ConfirmationDialog
			open
			icon={<FontAwesomeIcon icon={faWandMagicSparkles} />}
			title={mode === "transcript" ? "Faqat transkript" : "To'liq AI tahlil"}
			description={
				<span className="block">
					{plan.toRun.length} ta video ·{" "}
					{plan.totalAudioSec > 0
						? `${formatAudioLengthUz(plan.totalAudioSec)} audio`
						: "audio uzunligi noma'lum"}
					{plan.totalAudioSec > 0
						? ` · taxminan $${plan.estimatedUsd.toFixed(2)}${partialPriceNote}`
						: " · narxi noma'lum"}
					{skipParts.length > 0
						? ` · ${skipParts.join(" · ")} - o'tkazib yuboriladi`
						: ""}
				</span>
			}
			confirmLabel={running ? "Boshlanmoqda..." : "Boshlash"}
			cancelLabel="Bekor"
			confirmVariant="dark"
			loading={running}
			onConfirm={onStart}
			onCancel={onCancel}
		/>
	);
};
