"use client";

import { useState } from "react";
import {
	declineHermesMeeting,
	queueHermesMeeting,
} from "@/actions/videos/hermes-meeting";
import type { HermesMeetingState } from "@/lib/hermes-meeting";

/**
 * "Bu meetingmi? Hermesga joylaymi?" (ADR 2026-10-08, part A).
 *
 * Rendered ONLY for admins viewing a Meetings-library video (the server page
 * gates that); the actions re-check both rules server-side. The dialog
 * auto-opens exactly once — the very first answer (Ha or Yo'q) persists in
 * metadata.hermes, and after that the small "Hermesga joylash" button is the
 * only way back in.
 */

const MAX_FIELD_LENGTH = 60;

export function HermesMeeting({
	videoId,
	initialHermes,
}: {
	videoId: string;
	initialHermes: HermesMeetingState | null;
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
		clientName.trim().length <= MAX_FIELD_LENGTH &&
		company.trim().length <= MAX_FIELD_LENGTH;

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

	if (hermes?.status === "queued") {
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
								maxLength={MAX_FIELD_LENGTH}
								disabled={busy}
							/>
						</label>
						<label className="block text-xs text-gray-10 dark:text-dark-gray-10">
							Kompaniya
							<input
								className="mt-1 mb-3 w-full rounded-md border border-gray-200 bg-transparent px-2 py-1 text-sm dark:border-dark-gray-200"
								value={company}
								onChange={(e) => setCompany(e.target.value)}
								maxLength={MAX_FIELD_LENGTH}
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
