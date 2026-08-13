/**
 * WHICH PAID PROVIDER ACTUALLY PRODUCED THIS JOB'S TRANSCRIPT (round-18 #1).
 *
 * The gap-fill guard in workflows/transcribe.ts skips paid re-transcription of
 * a TRAILING gap when that gap is an artefact of OpenRouter's compressed cue
 * timestamps rather than genuinely missing audio. The condition it needs is
 * "OpenRouter produced this transcript" — a fact about the RUN.
 *
 * It used to test `hasOpenRouterKey()` instead: a fact about the ENVIRONMENT.
 * Those two agree only on an OpenRouter-only instance. On the ordinary case —
 * a transcript produced end-to-end by the FREE Google chain on a box that also
 * holds an OpenRouter key for the paid leg — the environment says "OpenRouter"
 * while the transcript says "Google". A genuinely failed last chunk was then
 * refused its paid fill, the free-only retry threw `free-only call skipped`,
 * and the end of the meeting went permanently missing from the transcript,
 * recorded only in `metadata.transcriptionGaps` and a console.warn.
 *
 * So the fact is RECORDED where it is created — the OpenRouter paid leg, on
 * success — and read where the decision is made. Scope is per-job (videoId)
 * and in-memory, the same shape as lib/free-tier-health.ts: both phase
 * launchers clear it at job start, and a cron re-kick in a fresh process
 * simply starts with no verdict.
 *
 * A LOST verdict fails in the SAFE direction by construction: "unknown" reads
 * as "not OpenRouter", so the trailing gap gets its paid fill and real audio
 * loss is still repaired. The only cost of being wrong is money on a gap that
 * may not need filling — never a silently truncated meeting.
 */

const openRouterTranscriptJobs = new Set<string>();

/** Called by the OpenRouter transcription leg once it has actually returned
 * transcript text for this job. Any chunk is enough: cue-timestamp compression
 * pulls the merged timeline toward the start regardless of which chunk it
 * affected, so one OpenRouter-produced chunk can manufacture the trailing gap. */
export function markOpenRouterTranscript(videoId: string): void {
	openRouterTranscriptJobs.add(videoId);
}

/** True only when OpenRouter is known to have produced transcript text for
 * this job in this process. Unknown → false (see the safe-direction note). */
export function transcriptCameFromOpenRouter(videoId: string): boolean {
	return openRouterTranscriptJobs.has(videoId);
}

/** Job-start reset, alongside clearFreeTierVerdict: a fresh run must not
 * inherit a previous run's provider. */
export function clearTranscriptProvenance(videoId: string): void {
	openRouterTranscriptJobs.delete(videoId);
}

/** Test seam: clear all per-job state between tests. */
export function resetTranscriptProvenance(): void {
	openRouterTranscriptJobs.clear();
}
