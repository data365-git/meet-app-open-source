"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Owner-only button that manually starts the AI pipeline
 * (transcript -> summary -> refined). Transcription/AI no longer run
 * automatically; this POSTs to /api/videos/[id]/generate.
 */
export function GenerateAiButton({
	videoId,
	isOwner,
	transcriptionStatus,
	aiGenerationStatus,
}: {
	videoId: string;
	isOwner: boolean;
	transcriptionStatus?: string | null;
	aiGenerationStatus?: string | null;
	transcriptionProgress?: number | null;
}) {
	const router = useRouter();
	const [submitting, setSubmitting] = useState(false);

	const statusRunning =
		transcriptionStatus === "PROCESSING" ||
		aiGenerationStatus === "QUEUED" ||
		aiGenerationStatus === "PROCESSING";

	// Hand off the optimistic "submitting" state to the real polled status once
	// the backend reports it (running or a terminal state).
	useEffect(() => {
		if (
			statusRunning ||
			transcriptionStatus === "COMPLETE" ||
			transcriptionStatus === "ERROR" ||
			aiGenerationStatus === "COMPLETE" ||
			aiGenerationStatus === "ERROR"
		) {
			setSubmitting(false);
		}
	}, [statusRunning, transcriptionStatus, aiGenerationStatus]);

	if (!isOwner) return null;

	const running = submitting || statusRunning;
	const done =
		transcriptionStatus === "COMPLETE" && aiGenerationStatus === "COMPLETE";

	const pct =
		typeof transcriptionProgress === "number" && transcriptionProgress > 0
			? Math.min(99, transcriptionProgress)
			: null;
	const label = running
		? pct !== null
			? `Transcribing… ${pct}%`
			: "Generating…"
		: done
			? "Regenerate"
			: "Generate summary & transcript";

	const handleClick = async () => {
		if (running) return;
		setSubmitting(true);
		try {
			const res = await fetch(`/api/videos/${videoId}/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
			});
			const body = (await res.json().catch(() => ({}))) as {
				success?: boolean;
				error?: string;
				message?: string;
			};
			if (!res.ok || body?.success === false) {
				throw new Error(body?.error || body?.message || "Failed to start");
			}
			toast.success("Generating summary & transcript…");
			router.refresh();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Failed to start generation",
			);
			setSubmitting(false);
		}
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={running}
			className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
			style={{ background: "#7c3aed" }}
		>
			{running && (
				<span
					className="h-3 w-3 animate-spin rounded-full"
					style={{
						border: "2px solid rgba(255,255,255,0.4)",
						borderTopColor: "#fff",
					}}
				/>
			)}
			{label}
		</button>
	);
}
