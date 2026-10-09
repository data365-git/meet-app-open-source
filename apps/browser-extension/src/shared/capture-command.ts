// ── Pause/Resume: the ONE reply rule, shared by both UIs ────────────────────
//
// Two places let a user pause a recording, and they were copy-pasted apart:
//   • popup/popup.ts             — the toolbar popup
//   • recorder/recorder-page.ts  — the persistent full-screen recorder tab
//
// background/sw.ts already answers honestly: its PAUSE/RESUME handlers return
// { ok: false } WITHOUT writing the persisted flag whenever the control message
// never reached a live recorder (dead offscreen document, closed recorder tab).
// The lie was on this side — the popup fired the message and ignored the reply,
// so a failed pause looked exactly like a successful one: the label flicked
// back and nothing else happened, over a recorder that was still recording.
//
// The rule lives HERE so a future fix to one caller cannot leave the other
// behind, the same way shared/client-audio.ts holds the tab-audio rule.
//
// FAIL-CLOSED, like client-audio: only an explicit ok === true means "the
// recorder actually did it". Chrome resolves a sendMessage callback with
// `undefined` when no listener answered, and that must never read as success.

export type CaptureCommand = "PAUSE" | "RESUME";

/** What to tell the user when the command didn't take. Keyed by command so a
 * new one can't be added without copy — and so the message states the state
 * capture is STILL in, which is the fact the user needs. */
export const CAPTURE_COMMAND_PROBLEM: Record<CaptureCommand, string> = {
	PAUSE: "Couldn't pause — the recorder didn't respond. Still recording.",
	RESUME: "Couldn't resume — the recorder didn't respond. Still paused.",
};

export type CaptureCommandResult = { ok: true } | { ok: false; error: string };

/**
 * Ask the service worker to pause/resume, and interpret its answer.
 *
 * `send` is the caller's own sendMessage-with-reply helper; it may resolve any
 * shape (including undefined) and may reject — every non-{ok:true} outcome is a
 * failure the caller must SHOW rather than swallow.
 */
export async function sendCaptureCommand(
	send: (msg: Record<string, unknown>) => Promise<unknown>,
	command: CaptureCommand,
): Promise<CaptureCommandResult> {
	let reply: unknown;
	try {
		reply = await send({ type: command });
	} catch {
		return { ok: false, error: CAPTURE_COMMAND_PROBLEM[command] };
	}
	const ok =
		typeof reply === "object" &&
		reply !== null &&
		(reply as { ok?: unknown }).ok === true;
	return ok ? { ok: true } : { ok: false, error: CAPTURE_COMMAND_PROBLEM[command] };
}
