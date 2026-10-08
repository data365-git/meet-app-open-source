"use client";

import {
	Button,
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
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
 *
 * The optional props serve the "download + auto-transcribe" flow (2026-10-08
 * spec) without touching the two bulk-AI callers: `title` / `confirmLabel` /
 * `cancelLabel` reword the same dialog, `secondary` adds a middle button
 * ("Faqat tayyorlarini yuklab olish"), `hideConfirm` drops the paid action
 * (selection over BULK_AI_MAX_SELECTION: only the ready-only + cancel buttons
 * remain), and `notice` adds one explanation line. With NO optional prop the
 * dialog renders exactly as before.
 */
export const BulkAiConfirmDialog = ({
	mode,
	plan,
	running,
	onStart,
	onCancel,
	title,
	confirmLabel,
	cancelLabel,
	secondary,
	hideConfirm = false,
	notice,
}: {
	mode: BulkAiMode;
	plan: BulkAiPlan;
	/** The start loop is in flight: both buttons lock, spinner on "Boshlash". */
	running: boolean;
	onStart: () => void;
	onCancel: () => void;
	/** Replaces the default mode-based title. */
	title?: string;
	/** Replaces "Boshlash" (spinner text stays "Boshlanmoqda..."). */
	confirmLabel?: string;
	/** Replaces "Bekor". */
	cancelLabel?: string;
	/** Optional middle button between cancel and confirm. */
	secondary?: { label: string; onClick: () => void };
	/** Hide the paid confirm button (ceiling case: ready-only + cancel remain). */
	hideConfirm?: boolean;
	/** One extra explanation line under the plan line (e.g. the ceiling rule). */
	notice?: string;
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

	const resolvedTitle =
		title ?? (mode === "transcript" ? "Faqat transkript" : "To'liq AI tahlil");
	const resolvedConfirm = running
		? "Boshlanmoqda..."
		: (confirmLabel ?? "Boshlash");
	const resolvedCancel = cancelLabel ?? "Bekor";
	const planLine = (
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
	);
	const icon = <FontAwesomeIcon icon={faWandMagicSparkles} />;

	// The default two-button shape stays on ConfirmationDialog, byte for byte.
	if (!secondary) {
		return (
			<ConfirmationDialog
				open
				icon={icon}
				title={resolvedTitle}
				description={planLine}
				confirmLabel={resolvedConfirm}
				cancelLabel={resolvedCancel}
				confirmVariant="dark"
				loading={running}
				onConfirm={onStart}
				onCancel={onCancel}
			/>
		);
	}

	// Three-button shape (download + auto-transcribe flow). ConfirmationDialog
	// has a fixed two-button footer, so this composes the same @cap/ui dialog
	// primitives with the same classes and the same loading rule: dismissal is
	// refused while `running` is true (see ConfirmationDialog).
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !running) onCancel();
			}}
		>
			<DialogContent className="p-0 w-[calc(100%-20px)] max-w-md rounded-xl border bg-gray-2 border-gray-4">
				<DialogHeader icon={icon}>
					<DialogTitle className="text-lg text-gray-12">
						{resolvedTitle}
					</DialogTitle>
				</DialogHeader>
				<p className="p-5 text-[14px] leading-5 text-gray-11">
					{planLine}
					{notice && <span className="mt-2 block">{notice}</span>}
				</p>
				<DialogFooter>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							onCancel();
						}}
						variant="gray"
						size="sm"
						disabled={running}
					>
						{resolvedCancel}
					</Button>
					<Button
						onClick={(e) => {
							e.stopPropagation();
							secondary.onClick();
						}}
						variant="gray"
						size="sm"
						disabled={running}
					>
						{secondary.label}
					</Button>
					{!hideConfirm && (
						<Button
							onClick={(e) => {
								e.stopPropagation();
								onStart();
							}}
							variant="dark"
							size="sm"
							spinner={running}
							disabled={running}
						>
							{resolvedConfirm}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
