import { patchVideoMetadata } from "@/lib/video-metadata";

// Liveness heartbeat interval. Liveness means THE PROCESS IS STILL RUNNING,
// not "the code reached a checkpoint": both phases run long uninterrupted
// awaits with no progress callback, so any stamp-at-boundary scheme keeps a
// blind window as long as the slowest await (rounds 3-5 of the 2026-08-10
// review each found one). A timer ticks independently of every await and
// covers phases not yet written. 5 min vs the 60-min stale threshold and
// 30-min cron cadence: a live job is never more than 5 min stale (12x
// margin), and a false-stale would need 11+ consecutive stamp writes to
// fail — at which point the DB is down and recovery semantics are moot.
// Cost: 12 tiny row-locked writes per hour per ACTIVE job. The timer dies
// with the process, so a killed container stops stamping automatically —
// exactly the signal the recovery cron needs.
//
// Shared by BOTH phases since round-12 #3: generation used to be judged by
// aiProcessingStartedAt alone, so a healthy generation longer than the stale
// window got a second, concurrent, PAID run. Same clock, same semantics:
// the cron judges every phase by time since last PROGRESS.
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function startAiJobHeartbeat(videoId: string): () => void {
	const stamp = () => {
		void patchVideoMetadata(videoId, (current) => ({
			...current,
			aiProgressAt: new Date().toISOString(),
		})).catch(() => {});
	};
	// Leading stamp (round-13 #1): setInterval has no leading tick, and
	// aiProgressAt is a cross-phase field — a 5-minute hole at start lets a
	// stale previous-phase stamp mark a brand-new job stale.
	stamp();
	const timer = setInterval(stamp, HEARTBEAT_INTERVAL_MS);
	// Never keep the process alive just for the heartbeat.
	(timer as unknown as { unref?: () => void }).unref?.();
	return () => clearInterval(timer);
}
