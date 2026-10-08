"use client";

import { useState } from "react";
import {
	declineHermesMeeting,
	queueHermesMeeting,
} from "@/actions/videos/hermes-meeting";
import {
	HERMES_CLIENT_FIELD_MAX_LENGTH,
	type HermesMeetingState,
} from "@/lib/hermes-meeting";

/**
 * "Bu meetingmi? Hermesga joylaymi?" (ADR 2026-10-08, part A).
 *
 * Rendered ONLY for org admins viewing a Meetings-library video (the server
 * page gates that); the actions re-check both rules server-side. The dialog
 * auto-opens until the first recorded answer: "Ha" queues, "Yo'q" records the
 * decline (it never auto-opens again), and "Keyinroq" just closes — nothing
 * is recorded, so the dialog may show again on the next visit.
 */

/** Terminal transcription states: the transcript will never land. */
const TRANSCRIPT_FAILED = new Set(["ERROR", "NO_AUDIO", "SKIPPED"]);

export function HermesMeeting({
	videoId,
	initialHermes,
	transcriptionStatus,
}: {
	videoId: string;
	initialHermes: HermesMeetingState | null;
	transcriptionStatus: string | null;
}) {
	const [hermes, setHermes] = useState<HermesMeetingState | null>(
		initialHermes,
	);
	const [dialogOpen, setDialogOpen] = useState(initialHermes === null);
	const [clientName, setClientName] = useState("");
	const [company, setCompany] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fieldsValid =
		clientName.trim().length > 0 &&
		company.trim().length > 0 &&
		clientName.trim().length <= HERMES_CLIENT_FIELD_MAX_LENGTH &&
		company.trim().length <= HERMES_CLIENT_FIELD_MAX_LENGTH;

	async function onDecline() {
		setBusy(true);
		setError(null);
		const result = await declineHermesMeeting(videoId);
		setBusy(false);
		if (result.success) {
			setHermes(result.hermes ?? { status: "declined" });
			setDialogOpen(false);
		} else {
			setError(result.error);
		}
	}

	async function onQueue() {
		setBusy(true);
		setError(null);
		const result = await queueHermesMeeting(videoId, clientName, company);
		setBusy(false);
		if (result.success) {
			setHermes(result.hermes ?? null);
			setDialogOpen(false);
		} else {
			setError(result.error);
		}
	}

	/** Re-queue a failed delivery with the fields the first attempt stored. */
	async function onRetry() {
		if (!hermes?.clientName || !hermes?.company) {
			// Nothing usable stored — fall back to the dialog for new input.
			setClientName(hermes?.clientName ?? "");
			setCompany(hermes?.company ?? "");
			setError(null);
			setDialogOpen(true);
			return;
		}
		setBusy(true);
		setError(null);
		const result = await queueHermesMeeting(
			videoId,
			hermes.clientName,
			hermes.company,
		);
		setBusy(false);
		if (result.success) {
			setHermes(result.hermes ?? null);
		} else {
			setError(result.error);
		}
	}

	if (hermes?.status === "queued") {
		if (
			transcriptionStatus &&
			TRANSCRIPT_FAILED.has(transcriptionStatus)
		) {
			return (
				<div className="text-xs text-red-500 my-2">
					Transkript qilib bo&apos;lmadi - Hermesga yuborilmadi
				</div>
			);
		}
		return (
			<div className="text-xs text-gray-10 dark:text-dark-gray-10 my-2">
				Hermesga navbatda (transkript tayyorlanmoqda)
			</div>
		);
	}

	if (hermes?.status === "delivered") {
		return (
			<div className="text-xs text-green-600 my-2">
				Hermesga joylandi ✓ {hermes.fileName ?? ""}
			</div>
		);
	}

	if (hermes?.status === "failed") {
		return (
			<div className="my-2 flex items-center gap-2">
				<span className="text-xs text-red-500">
					Hermesga yuborib bo&apos;lmadi
				</span>
				{error ? (
					<span className="text-xs text-red-500">{error}</span>
				) : null}
				<button
					type="button"
					className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-10 hover:bg-gray-100 dark:border-dark-gray-200 dark:text-dark-gray-10 dark:hover:bg-gray-300/20"
					onClick={onRetry}
					disabled={busy}
				>
					Qayta urinish
				</button>
			</div>
		);
	}

	return (
		<div className="my-2">
			{dialogOpen ? (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
					role="dialog"
					aria-modal="true"
					aria-label="Bu meetingmi? Hermesga joylaymi?"
				>
					<div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-gray-200 dark:bg-gray-2">
						<p className="mb-3 text-sm font-medium">
							Bu meetingmi? Hermesga joylaymi?
						</p>
						<label className="block text-xs text-gray-10 dark:text-dark-gray-10">
							Mijoz ismi
							<input
								className="mt-1 mb-3 w-full rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm dark:border-dark-gray-200"
								value={clientName}
								onChange={(e) => setClientName(e.target.value)}
								maxLength={HERMES_CLIENT_FIELD_MAX_LENGTH}
								disabled={busy}
							/>
						</label>
						<label className="block text-xs text-gray-10 dark:text-dark-gray-10">
							Kompaniya
							<input
								className="mt-1 mb-3 w-full rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm dark:border-dark-gray-200"
								value={company}
								onChange={(e) => setCompany(e.target.value)}
								maxLength={HERMES_CLIENT_FIELD_MAX_LENGTH}
								disabled={busy}
							/>
						</label>
						{error ? (
							<p className="mb-2 text-xs text-red-500">{error}</p>
						) : null}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								className="rounded-md px-3 py-1.5 text-sm text-gray-10 hover:bg-gray-100 dark:text-dark-gray-10 dark:hover:bg-gray-300/20"
								onClick={() => setDialogOpen(false)}
								disabled={busy}
							>
								Keyinroq
							</button>
							<button
								type="button"
								className="rounded-md px-3 py-1.5 text-sm text-gray-10 hover:bg-gray-100 dark:text-dark-gray-10 dark:hover:bg-gray-300/20"
								onClick={onDecline}
								disabled={busy}
							>
								Yo&apos;q
							</button>
							<button
								type="button"
								className="rounded-md bg-blue-500 px-3 py-1.5 text-sm text-white disabled:opacity-50"
								onClick={onQueue}
								disabled={busy || !fieldsValid}
							>
								Ha, joylash
							</button>
						</div>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="rounded-md border border-gray-200 px-2 py-1 text-xs text-gray-10 hover:bg-gray-100 dark:border-dark-gray-200 dark:text-dark-gray-10 dark:hover:bg-gray-300/20"
					onClick={() => {
						setError(null);
						setDialogOpen(true);
					}}
				>
					Hermesga joylash
				</button>
			)}
		</div>
	);
}
