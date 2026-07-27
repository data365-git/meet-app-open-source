/**
 * Live pipeline progress (audio → transcribe → index → analyze) written into
 * `videos.metadata.pipelineProgress` as a read-modify-write of the JSON column
 * (no dedicated DB column). The transcribe + generate-ai workflows share the
 * single `phases` array so the share page's GenerateStrip can render a phased
 * progress bar, a counting-down ETA (from per-chunk wall-clock times), and
 * per-chunk tick marks — matching v2's transcription UX.
 */

import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type {
	PipelinePhase,
	PipelinePhaseKey,
	PipelineProgress,
	VideoMetadata,
} from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/** Uzbek phase labels shown in the strip chips. */
const PHASE_LABELS: Record<PipelinePhaseKey, string> = {
	audio: "Audio tayyorlash",
	transcribe: "Transkripsiya",
	index: "AI indekslash",
	analyze: "AI tahlil",
};

/** Execution + display order. Matches GenerateStrip chip order and phase weights. */
const PHASE_ORDER: PipelinePhaseKey[] = [
	"audio",
	"transcribe",
	"index",
	"analyze",
];

/** Thrown from the transcription progress callback when the owner cancels. */
export class TranscriptionCancelledError extends Error {
	constructor() {
		super("Transcription cancelled by user");
		this.name = "TranscriptionCancelledError";
	}
}

// Per-video promise chain serializing read-modify-write of the metadata JSON so
// concurrent progress callbacks (parallel chunk transcription) don't clobber
// each other. Best-effort, in-process only.
const locks = new Map<string, Promise<unknown>>();

function withVideoLock<T>(videoId: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(videoId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	locks.set(
		videoId,
		next.then(
			() => undefined,
			() => undefined,
		),
	);
	return next;
}

async function readMetadata(videoId: string): Promise<VideoMetadata> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	return (row?.metadata as VideoMetadata) || {};
}

async function writeMetadata(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	await db()
		.update(videos)
		.set({ metadata })
		.where(eq(videos.id, videoId as Video.VideoId));
}

function phase(
	key: PipelinePhaseKey,
	status: PipelinePhase["status"],
	extra?: Partial<PipelinePhase>,
): PipelinePhase {
	return {
		key,
		label: PHASE_LABELS[key],
		status,
		done: 0,
		total: 0,
		...extra,
	};
}

/**
 * Seed all four phases at transcription start. For audio-source uploads there is
 * no video→audio extraction, so the audio phase starts already done and the
 * transcribe phase is the first active one.
 */
export async function initPipelineProgress(
	videoId: string,
	isAudioSource: boolean,
): Promise<void> {
	const now = new Date().toISOString();
	const phases: PipelinePhase[] = PHASE_ORDER.map((key) => {
		if (key === "audio") {
			return isAudioSource
				? phase("audio", "done", {
						done: 1,
						total: 1,
						startedAt: now,
						completedAt: now,
					})
				: phase("audio", "active", { startedAt: now });
		}
		if (key === "transcribe" && isAudioSource) {
			return phase("transcribe", "active", { startedAt: now });
		}
		return phase(key, "queued");
	});

	const progress: PipelineProgress = {
		currentPhase: isAudioSource ? "transcribe" : "audio",
		phases,
		startedAt: now,
		updatedAt: now,
	};

	await withVideoLock(videoId, async () => {
		const metadata = await readMetadata(videoId);
		await writeMetadata(videoId, {
			...metadata,
			pipelineProgress: progress,
			transcriptionError: undefined,
			cancelRequested: false,
		});
	});
}

/** Read-modify-write a single phase entry. No-op if pipelineProgress is missing. */
export async function patchPipelinePhase(
	videoId: string,
	key: PipelinePhaseKey,
	updates: Partial<PipelinePhase>,
	opts?: { makeCurrent?: boolean; transcriptionProgress?: number },
): Promise<void> {
	await withVideoLock(videoId, async () => {
		const metadata = await readMetadata(videoId);
		const existing = metadata.pipelineProgress;
		if (!existing) return;
		const phases = existing.phases.map((p) =>
			p.key === key ? { ...p, ...updates } : p,
		);
		const next: PipelineProgress = {
			...existing,
			phases,
			currentPhase: opts?.makeCurrent ? key : existing.currentPhase,
			updatedAt: new Date().toISOString(),
		};
		await writeMetadata(videoId, {
			...metadata,
			pipelineProgress: next,
			...(opts?.transcriptionProgress != null
				? { transcriptionProgress: opts.transcriptionProgress }
				: {}),
		});
	});
}

/**
 * Begin the analyze phase (AI summary/tasks/refined). Called by generate-ai.
 * If a pipelineProgress already exists (normal transcribe → analyze flow), just
 * flip analyze active and mark the earlier phases done. If none exists (AI-only
 * regeneration where transcription is already COMPLETE), synthesize a fresh
 * progress with the earlier phases pre-completed so the strip still animates.
 */
export async function beginAnalyzePhase(videoId: string): Promise<void> {
	const now = new Date().toISOString();
	await withVideoLock(videoId, async () => {
		const metadata = await readMetadata(videoId);
		const existing = metadata.pipelineProgress;
		const phases: PipelinePhase[] = existing
			? existing.phases.map((p) =>
					p.key === "analyze"
						? { ...p, status: "active", startedAt: now }
						: p.status === "done"
							? p
							: { ...p, status: "done", completedAt: p.completedAt ?? now },
				)
			: PHASE_ORDER.map((key) =>
					key === "analyze"
						? phase("analyze", "active", { startedAt: now })
						: phase(key, "done", { done: 1, total: 1, completedAt: now }),
				);
		const next: PipelineProgress = {
			currentPhase: "analyze",
			phases,
			startedAt: existing?.startedAt ?? now,
			updatedAt: now,
		};
		await writeMetadata(videoId, { ...metadata, pipelineProgress: next });
	});
}

/** Mark the analyze phase done (or errored). Called by generate-ai. */
export async function completeAnalyzePhase(
	videoId: string,
	status: "done" | "error" = "done",
): Promise<void> {
	await patchPipelinePhase(videoId, "analyze", {
		status,
		done: status === "done" ? 1 : 0,
		total: 1,
		completedAt: new Date().toISOString(),
	});
}

/** True if the owner requested cancellation via the cancel-processing endpoint. */
export async function isCancelRequested(videoId: string): Promise<boolean> {
	const metadata = await readMetadata(videoId);
	return metadata.cancelRequested === true;
}
