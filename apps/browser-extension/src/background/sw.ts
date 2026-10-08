import { isKeepAliveAlarm, startKeepAlive, stopKeepAlive } from "./keepalive";
import { isMeetingFiling, suppressAutoOpen } from "./meeting";
import type { ExtensionSettings, ExtensionState } from "./state";
import { getSettings, getState, setSettings, setState } from "./state";
import { DEFAULT_API_BASE_URL } from "../shared/config";
import { getMeetingId } from "../shared/meeting-url";
import type { CaptureTier, CaptureTierName } from "../shared/recording-quality";
import {
	CAPTURE_TIER_NOTICE_ID,
	CAPTURE_TIERS,
	captureTierChangeNotice,
	captureTierFor,
	chooseCaptureTier,
} from "../shared/recording-quality";
import {
	abortUpload,
	computeDurationInSecs,
	discardUpload,
	finalizeUpload,
	finishLocalDiscardTraces,
	handleChunk,
	hasPendingDiscard,
	initializeUpload,
	isForeignRecorderSession,
	isRetryAlarm,
	resumeInterruptedFinishing,
	retryPendingUploads,
} from "./upload";

// ── Tab capture (Google Meet path) ─────────────────────────────────────────
//
// chrome.tabCapture.getMediaStreamId({ targetTabId }) mints a *serializable*
// stream id that the offscreen document can consume via getUserMedia with
// chromeMediaSource: "tab". This is the ONLY capture path that works from a
// service worker for tab content. (The old desktopCapture.chooseDesktopMedia
// path was architecturally broken from a SW: it required a targetTab, and its
// stream id could not be consumed inside an offscreen document.)

function getTabMediaStreamId(
	targetTabId: number,
	consumerTabId?: number,
): Promise<string> {
	return new Promise((resolve, reject) => {
		try {
			chrome.tabCapture.getMediaStreamId(
				consumerTabId !== undefined
					? { targetTabId, consumerTabId }
					: { targetTabId },
				(streamId: string) => {
					if (chrome.runtime.lastError) {
						reject(new Error(chrome.runtime.lastError.message));
					} else if (!streamId) {
						reject(new Error("tabCapture returned no stream id"));
					} else {
						resolve(streamId);
					}
				},
			);
		} catch (err) {
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

// ── Visible instruction recorder page ──────────────────────────────────────
//
// Full-screen instruction recording needs getDisplayMedia(), which only works
// in a visible page with a real user gesture. We open a dedicated extension tab
// that owns the whole capture and streams chunks back here using the same
// RECORDER_* protocol as the offscreen recorder.

async function openInstructionRecorder(
	sourceTabId?: number,
	meeting?: boolean,
	meetingId?: string,
): Promise<number> {
	const base = chrome.runtime.getURL("recorder.html");
	// The guarantee travels with the TAB from here on (see state.ts
	// ArmingState.meetingRequired comment) — only the guaranteed path gets the
	// params; a plain screen recording opens with none. meetingId rides along
	// too (when known) so RECORDER_STARTED can recover it even if the SW's
	// "arming" record was wiped by an INSTRUCTION_CANCEL/RETRY in between (same
	// reasoning as source/meeting — see the RECORDER_STARTED handler below).
	const url =
		meeting === true && sourceTabId !== undefined
			? `${base}?source=${sourceTabId}&meeting=1${meetingId ? `&meetingId=${encodeURIComponent(meetingId)}` : ""}`
			: base;
	// Reuse an existing recorder tab if one is already open. Match with a
	// wildcard so a tab left over from a PREVIOUS start (possibly carrying
	// different/stale query params) is still found, then force it to reload
	// via tabs.update({ url }) — merely re-activating a reused tab would keep
	// its stale page-load-time params (sourceTabId/meeting are parsed once at
	// load in recorder-page.ts), silently losing the guarantee.
	const existing = await chrome.tabs.query({ url: `${base}*` });
	if (existing.length > 0 && existing[0].id != null) {
		await chrome.tabs.update(existing[0].id, { url, active: true });
		if (existing[0].windowId != null) {
			await chrome.windows.update(existing[0].windowId, { focused: true });
		}
		return existing[0].id;
	}
	const tab = await chrome.tabs.create({ url, active: true });
	return tab.id!;
}

// ── Offscreen document ─────────────────────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length > 0) return;
	await chrome.offscreen.createDocument({
		url: "offscreen.html",
		reasons: [chrome.offscreen.Reason.USER_MEDIA],
		justification: "Recording screen/tab media",
	});
}

async function closeOffscreenDocument(): Promise<void> {
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length > 0) {
		await chrome.offscreen.closeDocument();
	}
}

function sendToOffscreen(message: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response: unknown) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
			} else {
				resolve(response);
			}
		});
	});
}

// Control messages (STOP/PAUSE/RESUME) can hit a target whose listener isn't
// ready yet (SW waking, offscreen just created, tab still loading) — Chrome then
// rejects with "Receiving end does not exist". These commands are idempotent, so
// retry a few times with a short backoff instead of silently dropping the action.
/** Returns true if the control message was delivered, false if every attempt
 * failed. (R8) Callers whose command is load-bearing for SAVING a recording —
 * STOP and the Meet-ended auto-stop — must check this: a swallowed failure used
 * to leave the recording stuck in "recording" forever with its uploaded parts
 * never completed. */
/**
 * @param accept Decides whether a RESOLVED send actually counts as delivered.
 *   The default answers "yes" for every reply, which is the historical behaviour
 *   and the right one for the fire-and-forget controls: `chrome.*.sendMessage`
 *   resolves with `undefined` whenever the receiver has no async handler, so for
 *   STOP/PAUSE/RESUME "it did not throw" is all the evidence that exists.
 *   A caller whose command must have taken EFFECT (the capture tier) passes a
 *   predicate that reads the receiver's acknowledgment payload instead — a
 *   resolved-but-refused reply is then retried like any other failure and, if it
 *   never turns into a real ack, reported as NOT delivered.
 */
async function sendControlWithRetry(
	send: () => Promise<unknown>,
	label: string,
	attempts = 4,
	delayMs = 150,
	accept: (response: unknown) => boolean = () => true,
): Promise<boolean> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await send();
			if (accept(response)) return true;
			if (attempt === attempts) {
				console.warn(
					`[sw] control send was refused by the receiver after ${attempts} attempts: ${label}`,
				);
				return false;
			}
		} catch (err) {
			if (attempt === attempts) {
				console.warn(
					`[sw] control send failed after ${attempts} attempts: ${label}`,
					err,
				);
				return false;
			}
		}
		await new Promise((r) => setTimeout(r, delayMs));
	}
	return false;
}

// ── Adaptive capture tier (backlog → what the capture is allowed to produce) ─
//
// WHY. A throttled soak run at 800 kbit/s FAILED with upload-never-completed:
// the capture kept producing ~8 Mbit/s while the link carried ~0.8, so after a
// 6-minute recording only 8 of ~17 parts had reached the server and the user was
// left waiting after Stop (e2e-audio-proof/soak-throttle-{A,B,C}.log; the same
// harness PASSED at 4 Mbit/s and unthrottled). The link is not ours to fix; what
// the capture PRODUCES is.
//
// The SW is the only context that KNOWS the backlog — it owns the uploader — so
// it is the one that decides. The decision itself is the pure, unit-tested
// chooseCaptureTier() in shared/recording-quality.ts; nothing about WHEN to move
// is re-invented here.
//
// WHAT THE BACKLOG IS MADE OF (corrected 2026-08-05 after a throttled 800 kbit/s
// soak that produced 10x the link's capacity and STILL never moved the tier).
// The obvious measure — `totalBytes - uploadedBytes` off the recording state —
// is structurally incapable of reaching the high-water mark, and here is why:
// `totalBytes` only counts chunks handleChunk has already PROCESSED, every chunk
// runs through the serial `enqueueRecorder` queue, and a chunk's own part upload
// happens inside that queue. So while a 5 MB part crawls up a slow link, every
// chunk that arrives behind it sits UNCOUNTED in the queue; by the time a
// decision is taken (right after a part completed) the only thing left over is
// the sub-part remainder in the buffer — under 5 MB, i.e. permanently under the
// 15 MB high-water mark and usually under the 5 MB low-water mark, which reads as
// "the link is keeping up" precisely when it is drowning.
// The bytes waiting in that queue ARE recorded-but-not-uploaded, so the backlog
// is the sum of both parts: the buffered remainder plus the queue depth. Queue
// depth is tracked as a live counter (incremented when a chunk message arrives,
// decremented when its handleChunk returns) rather than derived, because nothing
// else in the SW knows how much is waiting behind the queue's head.
//
// Re-decided ONLY when a part actually completed (uploadedBytes advanced). Every
// chunk raises totalBytes, so re-deciding per chunk would read a backlog that
// only ever grows between two part completions and would walk the tier down
// three steps in three seconds on a link that was merely mid-part.
//
// This does NOT start, stop, restart or finalize anything: it sends one advisory
// message to the recorder that already owns the live capture, addressed with the
// EXISTING recorder-session id (shared/recorder-session.ts), so a recorder left
// over from an earlier session ignores it exactly as it ignores every other
// message addressed to a session that is not its own.

/** Session the tier tracking below belongs to. `null` (not `undefined`) is the
 * "no session tracked yet" sentinel, because an unstamped pre-F2 recording has a
 * genuinely `undefined` id and must still be recognised as a NEW session once. */
let captureTierSessionId: string | undefined | null = null;
let currentCaptureTier: CaptureTierName = CAPTURE_TIERS[0].name;
/** uploadedBytes at the last decision — the "has a part completed since?" mark. */
let lastTierDecisionUploadedBytes = 0;
/** One decision at a time: two chunk handlers can interleave across the awaits
 * below, and both stepping the tier would move it two steps on one measurement,
 * defeating the one-step-per-decision rule chooseCaptureTier is built on. */
let captureTierDecisionInFlight = false;
/**
 * Bytes of received RECORDER_CHUNK messages whose handleChunk has not returned
 * yet — the depth of the serial recorder queue, in bytes.
 *
 * Deliberately NOT reset by resetCaptureTierTracking(): it mirrors a real queue,
 * and every increment is paired with a decrement in the same message handler's
 * `finally`, so zeroing it out of band would make it drift permanently negative
 * (and therefore under-report every later backlog).
 */
let queuedChunkBytes = 0;

/** A chunk message has arrived and is about to join the recorder queue. */
function noteChunkQueued(byteLength: number): void {
	queuedChunkBytes += byteLength;
}

/**
 * When the live recorder produced its most recent chunk — i.e. where the MEDIA
 * ends, which on a slow link is minutes before the finalize gets to run (the
 * finalize waits behind the whole upload backlog). Every recorder path already
 * stamps `ts` on RECORDER_CHUNK; this just remembers the newest one.
 */
let lastChunkAtSessionId: string | undefined | null = null;
let lastChunkAt = 0;

function noteChunkTimestamp(
	sessionId: string | undefined,
	ts: number | undefined,
): void {
	if (lastChunkAtSessionId !== sessionId) {
		lastChunkAtSessionId = sessionId;
		lastChunkAt = 0;
	}
	if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return;
	if (ts > lastChunkAt) lastChunkAt = ts;
}

/** The end of the media for this recorder session, or undefined when we never
 * saw a usable chunk timestamp (an SW restart loses this — falling back to "now"
 * is then the only honest answer available). */
function mediaEndedAt(sessionId: string | undefined): number | undefined {
	return lastChunkAtSessionId === sessionId && lastChunkAt > 0
		? lastChunkAt
		: undefined;
}

/** That chunk has been processed (or dropped): it is no longer waiting. Clamped
 * at 0 so a service-worker restart mid-queue — which loses the pending work and
 * its counter together — can never leave a negative bias behind. */
function noteChunkDequeued(byteLength: number): void {
	queuedChunkBytes = Math.max(0, queuedChunkBytes - byteLength);
}

function resetCaptureTierTracking(): void {
	captureTierSessionId = null;
	currentCaptureTier = CAPTURE_TIERS[0].name;
	lastTierDecisionUploadedBytes = 0;
	// A previous recording's quality notice does not describe this one's link.
	chrome.notifications.clear(CAPTURE_TIER_NOTICE_ID);
}

/**
 * Tell the user, in plain words, that the capture tier moved — and tell them
 * again when it comes back up.
 *
 * Called ONLY after a tier change has actually been delivered to the recorder,
 * so the message can never describe a change that did not happen. Everything
 * about WHEN a tier moves (and therefore when a message appears at all) is the
 * hysteresis in chooseCaptureTier: a short backlog that drains inside the band
 * produces no tier move, hence no notification. The wording itself lives in
 * shared/recording-quality.ts next to the thresholds it describes.
 */
function notifyCaptureTierChanged(
	from: CaptureTierName,
	to: CaptureTierName,
): void {
	const notice = captureTierChangeNotice(from, to);
	if (!notice) return;
	chrome.notifications.create(notice.id, {
		type: "basic",
		iconUrl: "icons/icon-128.png",
		title: notice.title,
		message: notice.message,
	});
	if (notice.restored) {
		// Back at full quality: the alert badge would otherwise keep implying
		// something is still wrong. Recording state owns the badge again.
		void getState().then(updateBadge);
	} else {
		chrome.action.setBadgeText({ text: "!" });
		chrome.action.setBadgeBackgroundColor({ color: "#dd6b20" });
	}
}

/**
 * Did the recorder ACKNOWLEDGE that it applied the constraints?
 *
 * "The send resolved" is not that answer. `chrome.tabs.sendMessage` /
 * `chrome.runtime.sendMessage` resolve with `undefined` when the far end has no
 * handler for the message at all, and the in-page recorder deliberately answers
 * `{ ok: false }` when it declines — the capture is owned by a different
 * recorder session, or applyConstraints threw OverconstrainedError. Treating
 * either as delivered would commit `currentCaptureTier` to a tier the capture is
 * NOT running at: the next measurement would then start from the wrong step and
 * silently skip the reduction the backlog was asking for, while the user got a
 * notification about a quality change that never happened.
 *
 * The sessionId echo is the third refusal. It is defence in depth — the recorder
 * already refuses a foreign session itself — for the case where a leftover
 * recorder from an EARLIER recording answers a message addressed to the live
 * one. An ack that carries no sessionId at all is still accepted, because a
 * recorder path that does not echo it (and cannot, being a different context's
 * older build) is not evidence of the wrong session; a MISMATCHED one is.
 */
function isCaptureTierAck(
	response: unknown,
	expectedSessionId: string | undefined,
): boolean {
	if (typeof response !== "object" || response === null) return false;
	const ack = response as { ok?: unknown; sessionId?: unknown };
	const acknowledged = ack.ok === true;
	if (!acknowledged) return false;
	if (typeof ack.sessionId === "string" && ack.sessionId !== expectedSessionId)
		return false;
	return true;
}

/** Send the tier to whichever recorder owns the live capture. Returns whether it
 * was delivered AND acknowledged — the three routes mirror STOP/PAUSE/RESUME
 * exactly, but unlike them this one reads the reply (see isCaptureTierAck). */
function sendCaptureTier(
	state: Extract<ExtensionState, { kind: "recording" }>,
	tier: CaptureTier,
): Promise<boolean> {
	const accept = (response: unknown) =>
		isCaptureTierAck(response, state.recorderSessionId);
	const message = {
		type: "CAPTURE_TIER",
		// (F2) Addressed to THIS recording's recorder. A recorder that minted a
		// different id must ignore it rather than reconfigure a capture that is
		// feeding some other upload.
		sessionId: state.recorderSessionId,
		tier,
	};
	if (state.recorderTabId !== undefined && state.mode === "instruction") {
		const tabId = state.recorderTabId;
		return sendControlWithRetry(
			() => chrome.tabs.sendMessage(tabId, message),
			"CAPTURE_TIER→tab",
			2,
			100,
			accept,
		);
	}
	if (state.contentRecorderTabId !== undefined) {
		const tabId = state.contentRecorderTabId;
		return sendControlWithRetry(
			() => chrome.tabs.sendMessage(tabId, message),
			"CAPTURE_TIER→tab",
			2,
			100,
			accept,
		);
	}
	return sendControlWithRetry(
		() => sendToOffscreen(message),
		"CAPTURE_TIER→offscreen",
		2,
		100,
		accept,
	);
}

/**
 * Re-decide the capture tier from the upload backlog and tell the recorder.
 *
 * Called after a chunk has been handled, i.e. after any part it produced has
 * finished uploading. Reads state; never writes it — a wrong tier costs quality
 * for a few seconds, so nothing here may risk the recording itself.
 */
async function adaptCaptureTier(messageSessionId: string | undefined): Promise<void> {
	if (captureTierDecisionInFlight) return;
	captureTierDecisionInFlight = true;
	try {
		const state = await getState();
		if (state.kind !== "recording") return;
		// The chunk that triggered this must belong to the live recording, judged
		// by the same strict rule the uploader uses.
		if (isForeignRecorderSession(state, messageSessionId)) return;

		const liveSessionId = state.recorderSessionId;
		if (captureTierSessionId !== liveSessionId) {
			// First measurement of a new recording: adopt its baseline, decide
			// nothing. There is no "since the last part" delta to judge yet.
			captureTierSessionId = liveSessionId;
			currentCaptureTier = CAPTURE_TIERS[0].name;
			lastTierDecisionUploadedBytes = state.uploadedBytes;
			return;
		}

		// No part has completed since the last decision — the backlog has only
		// grown by the bytes of an in-flight part, which is not evidence of
		// anything. Wait for the uploader to report.
		if (state.uploadedBytes <= lastTierDecisionUploadedBytes) return;
		lastTierDecisionUploadedBytes = state.uploadedBytes;

		// Both halves of "recorded but not uploaded" — see the note at the top of
		// this section for why the buffered half alone can never see the trouble.
		const bufferedBytes = Math.max(0, state.totalBytes - state.uploadedBytes);
		const backlogBytes = bufferedBytes + queuedChunkBytes;
		// The measurement itself, on every decision — not only on the moves. An
		// adaptive control loop that logs only when it acts leaves no way to tell
		// "the link was fine" apart from "the signal was blind", which is exactly
		// the confusion that hid the queue-depth defect above.
		console.info(
			`[sw] upload backlog ${backlogBytes} bytes (buffered ${bufferedBytes}, queued ${queuedChunkBytes}) at tier ${currentCaptureTier}`,
		);
		const nextTier = chooseCaptureTier(currentCaptureTier, backlogBytes);
		if (nextTier === currentCaptureTier) return;

		const delivered = await sendCaptureTier(state, captureTierFor(nextTier));
		// Only commit once the recorder ACKNOWLEDGED applying it. A step that was
		// not delivered — or was delivered and refused — but recorded anyway would
		// make the NEXT decision start from a tier the capture is not running at,
		// so this same step would be silently skipped and the backlog would keep
		// growing while the user was told the quality had already been reduced.
		if (!delivered) {
			console.warn(
				`[sw] capture tier ${currentCaptureTier}→${nextTier} was not acknowledged by the recorder; will retry the same step on the next part`,
			);
			return;
		}
		console.info(
			`[sw] capture tier ${currentCaptureTier}→${nextTier} (backlog ${backlogBytes} bytes)`,
		);
		notifyCaptureTierChanged(currentCaptureTier, nextTier);
		currentCaptureTier = nextTier;
	} catch (err) {
		// Advisory path: never let it break chunk handling.
		console.warn("[sw] capture tier adaptation failed:", err);
	} finally {
		captureTierDecisionInFlight = false;
	}
}

// ── Badge ─────────────────────────────────────────────────────────────────

function updateBadge(state: ExtensionState): void {
	switch (state.kind) {
		case "recording":
			chrome.action.setBadgeText({ text: "REC" });
			chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
			break;
		case "uploading":
		case "finishing":
			chrome.action.setBadgeText({ text: "↑" });
			chrome.action.setBadgeBackgroundColor({ color: "#3182ce" });
			break;
		case "complete":
			chrome.action.setBadgeText({ text: "✓" });
			chrome.action.setBadgeBackgroundColor({ color: "#38a169" });
			break;
		case "error":
			chrome.action.setBadgeText({ text: "!" });
			chrome.action.setBadgeBackgroundColor({ color: "#dd6b20" });
			break;
		default:
			chrome.action.setBadgeText({ text: "" });
			break;
	}
}

// ── Tab-audio degradation watchdog (guaranteed client audio) ───────────────
//
// `intentionalStop` is set true the instant ANY deliberate stop/disarm begins
// (STOP, CANCEL, a matching MEET_CALL_ENDED) and reset false when a new
// recording starts. Every degradation signal below is gated on it being
// false, so a normal user "Stop & upload" never raises a false alert (Codex
// FIX B — chrome.tabCapture.onStatusChanged fires "stopped" on ordinary stops
// too). Tab-audio loss is NON-FATAL (owner 2026-07-15 reversal): the
// recording keeps going (screen+mic, and whatever client audio remains) —
// this only surfaces a notification/badge, it never stops anything.
// `tabAudioDegradedNotified` makes the notify/badge idempotent PER DEGRADED
// SPAN, not per recording: it resets on recovery so a second loss re-notifies.
let intentionalStop = false;
let tabAudioDegradedNotified = false;

function notifyTabAudioDegraded(cause: "muted" | "suspended" | "ended"): void {
	if (tabAudioDegradedNotified) return;
	tabAudioDegradedNotified = true;
	const messages: Record<typeof cause, string> = {
		muted:
			"The Meet tab was muted. Recording continues (screen+mic); client audio is not being captured until it's unmuted.",
		suspended:
			"Client audio briefly dropped mid-recording. Recording continues; attempting to recover.",
		ended:
			"The Meet tab was closed or navigated away. Recording continues (screen+mic only) — client audio can't be reconnected.",
	};
	chrome.notifications.create("tab-audio-degraded", {
		type: "basic",
		iconUrl: "icons/icon-128.png",
		title: "Client audio degraded",
		message: messages[cause],
	});
	chrome.action.setBadgeText({ text: "!" });
	chrome.action.setBadgeBackgroundColor({ color: "#dd6b20" });
}

/** Recovery from a degraded span (muted→unmuted, audioCtx resumed). Clears the
 * notification/badge and re-arms notifyTabAudioDegraded for the NEXT loss —
 * "ended" never calls this (it's permanent for the rest of the recording). */
async function notifyTabAudioRecovered(): Promise<void> {
	tabAudioDegradedNotified = false;
	chrome.notifications.clear("tab-audio-degraded");
	const st = await getState();
	updateBadge(st);
}

/** SW-side detection (source tab closed/navigated away): tell the recorder tab
 * about the loss via the degraded path (NOT the ordinary STOP_CAPTURE, which
 * would mark this as an intentional stop) and notify. This is always the
 * unrecoverable "ended" cause — the recorder tab keeps recording screen+mic. */
async function handleSourceTabLost(tabId: number): Promise<void> {
	const state = await getState();
	if (
		state.kind !== "recording" ||
		!state.meetingRequired ||
		state.sourceTabId !== tabId
	) {
		return;
	}
	if (intentionalStop) return;
	if (state.recorderTabId !== undefined) {
		await sendControlWithRetry(
			() =>
				chrome.tabs.sendMessage(state.recorderTabId!, {
					type: "TAB_AUDIO_LOST_REMOTE",
				}),
			"TAB_AUDIO_LOST_REMOTE→tab",
		);
	}
	notifyTabAudioDegraded("ended");
}

// ── Meeting ended → ask, don't auto-stop (owner's choice) ──────────────────
//
// When the Google Meet call ends during a GUARANTEED full-screen meeting
// recording (mode "instruction" + meetingRequired), the owner wants neither a
// silent auto-stop (false-detection could cut a real recording short) nor a
// silent continue — instead prompt the admin whether to stop or keep going.
const MEET_ENDED_PROMPT_ID = "meet-ended-stop-prompt";

function promptStopOnMeetEnded(): void {
	chrome.notifications.create(MEET_ENDED_PROMPT_ID, {
		type: "basic",
		iconUrl: "icons/icon-128.png",
		title: "Meeting ended",
		message:
			"The Google Meet call ended. Stop the recording, or keep recording the screen?",
		buttons: [{ title: "Stop & save" }, { title: "Keep recording" }],
		requireInteraction: true,
	});
}

/** Deliberate stop of the running instruction recording — mirrors the popup
 * STOP path (set intentionalStop so the watchdog doesn't misread the teardown,
 * then tell the recorder tab to finalize). Used by the meeting-ended prompt. */
async function stopInstructionDeliberate(): Promise<void> {
	const st = await getState();
	if (st.kind !== "recording" || st.mode !== "instruction") return;
	intentionalStop = true;
	if (st.recorderTabId !== undefined) {
		await sendControlWithRetry(
			() => chrome.tabs.sendMessage(st.recorderTabId!, { type: "STOP_CAPTURE" }),
			"STOP_CAPTURE→tab",
		);
	}
}

// ── Recording lock ──────────────────────────────────────────────────────────
//
// A new recording may start from any TERMINAL state (idle / error / complete) —
// a finished "complete" recording must NOT block the next one. Only block while
// media is genuinely being captured or uploaded. (A stale "arming" is transient
// and intentionally NOT blocking: a fresh user-initiated start supersedes it,
// otherwise a half-armed attempt would lock out all future recordings.)
function isInProgress(state: ExtensionState): boolean {
	return (
		state.kind === "recording" ||
		state.kind === "uploading" ||
		state.kind === "finishing"
	);
}

// ── Message routing ────────────────────────────────────────────────────────

interface MessageBase {
	type: string;
}

function isMessageBase(v: unknown): v is MessageBase {
	return (
		typeof v === "object" &&
		v !== null &&
		"type" in v &&
		typeof (v as Record<string, unknown>).type === "string"
	);
}

function getString(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

/**
 * Security: only trust a CAP_EXTENSION_TOKEN write from a page whose origin
 * matches the server the extension is actually configured to talk to. Without
 * this check, ANY page matched by externally_connectable (e.g. any
 * *.up.railway.app subdomain) could overwrite apiKey + apiBaseUrl and hijack
 * uploads to an attacker-controlled backend.
 *
 * Allowed origins:
 *   - the configured apiBaseUrl origin (user's own Cap server)
 *   - the well-known Cap cloud default origin
 *   - localhost dev origins (OAuth callback runs on the web app port)
 */
function originOf(url: string | undefined): string | null {
	if (!url) return null;
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/**
 * Security: is this message from one of OUR OWN extension pages (recorder.html,
 * popup.html, ...) rather than a content script's web page? Content scripts
 * (e.g. injected into meet.google.com) also reach chrome.runtime.onMessage,
 * but their sender.url is the WEB PAGE's URL, not a chrome-extension:// URL —
 * a plain web page can never forge this (only onMessageExternal can be
 * reached from outside the extension, never onMessage). Used to gate which
 * senders are trusted to carry the guaranteed-client-audio fields on a
 * message instead of the (volatile) SW "arming" state — see REQUEST_TAB_AUDIO
 * and RECORDER_STARTED below.
 *
 * Deliberately a startsWith prefix check, not originOf() comparison: the URL
 * spec gives chrome-extension:// URLs an OPAQUE origin (the literal string
 * "null") since it isn't a "special" scheme, so comparing origins would match
 * ANY chrome-extension:// sender rather than only this extension's own.
 */
function isOwnExtensionSender(senderUrl: string | undefined): boolean {
	return (
		typeof senderUrl === "string" &&
		senderUrl.startsWith(chrome.runtime.getURL(""))
	);
}

function isTrustedTokenSender(
	senderUrl: string | undefined,
	configuredApiBaseUrl: string,
): boolean {
	const sender = originOf(senderUrl);
	if (!sender) return false;

	const allowed = new Set<string>();
	const configured = originOf(configuredApiBaseUrl);
	if (configured) allowed.add(configured);
	const defaultOrigin = originOf(DEFAULT_API_BASE_URL);
	if (defaultOrigin) allowed.add(defaultOrigin);
	// Local dev: API (3000) and web app / OAuth callback (3001).
	allowed.add("http://localhost:3000");
	allowed.add("http://localhost:3001");

	return allowed.has(sender);
}

function getNumber(
	obj: Record<string, unknown>,
	key: string,
): number | undefined {
	const v = obj[key];
	return typeof v === "number" ? v : undefined;
}

function _getBoolean(
	obj: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const v = obj[key];
	return typeof v === "boolean" ? v : undefined;
}

const MIN_MEET_RECORDING_MS_BEFORE_AUTO_STOP = 10000;

function isMeetUrl(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return (
			parsed.hostname === "meet.google.com" &&
			/^\/[a-z]+-[a-z]+-[a-z]+/.test(parsed.pathname)
		);
	} catch {
		return false;
	}
}

async function resolveMeetSenderTabId(
	sender: chrome.runtime.MessageSender,
): Promise<number | undefined> {
	if (sender.tab?.id !== undefined && isMeetUrl(sender.tab.url)) {
		return sender.tab.id;
	}

	const tabs = await chrome.tabs.query({
		active: true,
		currentWindow: true,
		url: "https://meet.google.com/*",
	});
	const tab = tabs.find((t) => t.id !== undefined && isMeetUrl(t.url));
	return tab?.id;
}

// Serializes recorder upload work (chunk processing + finalization) so they
// never overlap. chrome.runtime.onMessage runs each handler independently, so a
// late RECORDER_CHUNK and the RECORDER_STOPPED finalize could otherwise both
// begin with `await getState()` and race over the in-memory buffer / totalBytes
// — dropping the final chunk (the short-recording bug). Funnelling them through
// one chain guarantees the final chunk's append completes before finalize runs.
let recorderQueue: Promise<unknown> = Promise.resolve();
function enqueueRecorder<T>(fn: () => Promise<T>): Promise<T> {
	const run = recorderQueue.then(fn, fn);
	recorderQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** (F2) Told to a recorder whose messages no longer own the live recording, so it
 * can stop itself instead of running on invisibly — an orphan that is merely
 * ignored keeps the mic/screen-share indicator lit and burns battery forever. */
const STALE_SESSION_REPLY = { ok: false, reason: "stale-session" as const };

/** (F2b) Recorder sessions that are definitively over.
 *
 * The live recording's own id answers "is this message from the current
 * recording?" only while a recording IS live. It cannot answer during `arming`,
 * and that gap is exploitable: an old session's RECORDER_ERROR arriving while a
 * NEW recording is arming has no id to be compared against, so it used to flip
 * the new attempt to "error" and close its offscreen document. Remembering the
 * ids we have retired closes it, because the message can be judged on its own.
 *
 * Bounded so a long-lived worker cannot grow it without limit; retirement is
 * newest-first, and forgetting the oldest ids is safe — those recorders are long
 * dead. Not persisted: if the worker restarts, the recorder contexts that could
 * have sent stale messages are gone with it. */
/** (F2b) Set synchronously for the duration of a RECORDER_STARTED registration
 * so a second start cannot interleave with the first one's awaits. */
let recorderStartInFlight = false;

const RETIRED_SESSION_LIMIT = 20;
const retiredSessions: string[] = [];

function retireSession(sessionId: string | undefined): void {
	if (!sessionId || retiredSessions.includes(sessionId)) return;
	retiredSessions.push(sessionId);
	if (retiredSessions.length > RETIRED_SESSION_LIMIT) retiredSessions.shift();
}

function isRetiredSession(sessionId: string | undefined): boolean {
	return sessionId !== undefined && retiredSessions.includes(sessionId);
}

/** Shared finalization logic called from RECORDER_STOPPED and the tabs.onRemoved handler.
 *
 * `expectedSessionId` is the recorder session claiming the stop. A stop from an
 * EARLIER session must not finalize the recording that is live now; the check is
 * made against this function's own state read for the reason given in
 * isForeignRecorderSession. Internal callers (tabs.onRemoved, crash resume) pass
 * nothing and are always honoured — they act on behalf of the live recording. */
async function finalizeRecording(
	expectedSessionId?: string,
	fromMessage = false,
): Promise<"finalized" | "stale"> {
	const state = await getState();
	if (state.kind !== "recording") return "stale";
	// (F2) A stop that arrived as a MESSAGE must prove it owns this recording —
	// including when it carries NO id at all. An earlier draft only checked when an
	// id was present, on the theory that internal callers need the lenient branch;
	// an independent review falsified that: tabs.onRemoved and the crash-resume
	// path call finalizeRecording() DIRECTLY (sw.ts 681/1042/1908/1926/1964) and
	// never touch the message case, so leniency protected nobody and left a real
	// hole — a stale recorder tab whose own state had already been cleared could
	// send an unstamped stop and cut the CURRENT recording short mid-stream.
	if (fromMessage && isForeignRecorderSession(state, expectedSessionId)) {
		console.warn(
			`[sw] ignored RECORDER_STOPPED from a stale recorder session (${expectedSessionId}); live=${state.recorderSessionId}`,
		);
		return "stale";
	}
	// This recording is over: nothing from its recorder may act again, in any
	// state that follows (including the next attempt's "arming").
	retireSession(state.recorderSessionId);
	const videoId = state.videoId;
	const uploadId = state.uploadId;
	const parts = state.parts;
	const totalBytes = state.totalBytes;
	const uploadedBytes = state.uploadedBytes;
	// Computed HERE, before the state transition below drops startedAt/
	// pausedAccumMs (neither "uploading" nor "finishing" carries them) —
	// finalizeUpload has no other way to see them once this function's own
	// setState below has run.
	const durationInSecs = computeDurationInSecs(
		state.startedAt,
		state.pausedAccumMs,
		state.paused,
		state.pausedAt,
		mediaEndedAt(state.recorderSessionId),
	);

	const nextState: ExtensionState = {
		kind: "uploading",
		videoId,
		uploadId,
		parts,
		totalBytes,
		uploadedBytes,
		// Carried forward so the completion paths in upload.ts know to auto-open
		// the video page for a meeting. Same rule the upload was filed under.
		isMeeting: isMeetingFiling(state.mode, state.meetingRequired),
	};
	await setState(nextState);
	stopKeepAlive();
	updateBadge(nextState);
	await closeOffscreenDocument().catch(() => {});
	await finalizeUpload(durationInSecs);
	return "finalized";
}

async function handleMessage(
	message: unknown,
	_sender: chrome.runtime.MessageSender,
): Promise<unknown> {
	if (!isMessageBase(message)) return { ok: false, error: "invalid message" };

	const msg = message as Record<string, unknown>;
	const type = msg.type as string;

	switch (type) {
		// ── Popup: start instruction recording ────────────────────────────
		// Full-screen instruction capture happens in a dedicated VISIBLE tab
		// (recorder.html) where getDisplayMedia() has a real user gesture. The
		// SW only opens that tab; the page owns the MediaStream and streams
		// chunks back via the RECORDER_* protocol. We deliberately do NOT enter
		// "arming" here — the actual gesture/picker lives in the recorder tab,
		// so state advances to "recording" only when that page sends
		// RECORDER_STARTED.
		case "START_INSTRUCTION": {
			const state = await getState();
			if (isInProgress(state)) {
				return { ok: false, error: "A recording is already in progress" };
			}
			const settings = await getSettings();
			if (!settings.apiKey) {
				return { ok: false, error: "not signed in" };
			}
			// The tab the user launched from (a Meet, or any audible tab). The
			// recorder page will pull its audio via tabCapture and mix it in.
			const sourceTabId = getNumber(msg, "sourceTabId");
			// Guaranteed-client-audio mode ("Record full-screen meeting"): set only
			// when the popup explicitly requested it while on a Meet tab.
			const meetingRequired = _getBoolean(msg, "meeting") === true;
			// The Meet meetingId (e.g. "abc-defg-hij"), sent by the popup for the
			// same guaranteed path. Stored on the ArmingState (kind stays
			// "arming"/mode stays "instruction" — this only carries an identifier
			// through, it is NOT the meeting/instruction control-flow discriminator)
			// so RECORDER_STARTED can file the upload as a meeting instead of a
			// plain instruction recording.
			const meetingId = getString(msg, "meetingId");
			await setState({
				kind: "arming",
				mode: "instruction",
				sourceTabId,
				meetingRequired,
				meetingId,
			});
			let recorderTabId: number;
			try {
				recorderTabId = await openInstructionRecorder(
					sourceTabId,
					meetingRequired,
					meetingId,
				);
			} catch (err) {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
				return {
					ok: false,
					error: `Couldn't open the recorder: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			await setState({
				kind: "arming",
				mode: "instruction",
				recorderTabId,
				sourceTabId,
				meetingRequired,
				meetingId,
			});
			return { ok: true };
		}

		// ── Popup: start meeting recording (Google Meet → tab capture) ────
		case "START_MEET": {
			const meetingId = getString(msg, "meetingId");
			const tabId = getNumber(msg, "tabId");
			const state = await getState();
			if (isInProgress(state)) {
				return { ok: false, error: "A recording is already in progress" };
			}
			if (tabId === undefined) {
				return { ok: false, error: "No Meet tab to record" };
			}
			const settings = await getSettings();
			if (!settings.apiKey) {
				return { ok: false, error: "not signed in" };
			}
			await setState({ kind: "arming", mode: "meeting", meetingId, tabId });
			let meetStreamId: string;
			try {
				// Tab capture: mint a serializable stream id for the Meet tab. This
				// is consumable in the offscreen document (chromeMediaSource: tab).
				meetStreamId = await getTabMediaStreamId(tabId);
			} catch (err) {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
				return {
					ok: false,
					error: `Couldn't capture the meeting tab: ${err instanceof Error ? err.message : String(err)}`,
				};
			}
			await ensureOffscreenDocument();
			await sendToOffscreen({
				type: "START_CAPTURE",
				streamId: meetStreamId,
				meetingId,
				tabId,
				micEnabled: settings.micEnabled,
				...(settings.micEnabled ? { micDeviceId: settings.micDeviceId } : {}),
			});
			return { ok: true };
		}

		// ── Popup: stop ───────────────────────────────────────────────────
		case "STOP": {
			// Deliberate stop — the watchdog must not treat the resulting
			// tabCapture teardown as a tab-audio loss (Codex FIX B).
			intentionalStop = true;
			const stopState = await getState();
			const stopTabId =
				stopState.kind === "recording" && stopState.mode === "instruction"
					? stopState.recorderTabId
					: stopState.kind === "arming" && stopState.mode === "instruction"
					  ? stopState.recorderTabId
					  : undefined;
			const contentStopTabId =
				stopState.kind === "recording" && stopState.contentRecorderTabId !== undefined
					? stopState.contentRecorderTabId
					: stopState.kind === "arming" && stopState.contentRecorderTabId !== undefined
					  ? stopState.contentRecorderTabId
					  : undefined;
			let stopDelivered: boolean;
			if (stopTabId !== undefined) {
				// Instruction recording: tell the recorder tab to stop.
				// SW state advances only when the tab sends RECORDER_STOPPED.
				stopDelivered = await sendControlWithRetry(
					() => chrome.tabs.sendMessage(stopTabId, { type: "STOP_CAPTURE" }),
					"STOP_CAPTURE→tab",
				);
			} else if (contentStopTabId !== undefined) {
				stopDelivered = await sendControlWithRetry(
					() =>
						chrome.tabs.sendMessage(contentStopTabId, { type: "STOP_CAPTURE" }),
					"STOP_CAPTURE→tab",
				);
			} else {
				stopDelivered = await sendControlWithRetry(
					() => sendToOffscreen({ type: "STOP_CAPTURE" }),
					"STOP_CAPTURE→offscreen",
				);
			}
			// (R8) The recorder never received the stop (crashed offscreen document,
			// closed recorder tab, dead listener). Nothing else will ever emit
			// RECORDER_STOPPED, so without this the recording sits in "recording"
			// forever, its already-uploaded parts are never completed, and the
			// user's natural next move (CANCEL) destroys them = meeting lost.
			// Finalize here instead: serialized, and finalizeRecording no-ops unless
			// the state is still a live recording.
			if (!stopDelivered) {
				await enqueueRecorder(() => finalizeRecording());
			}
			return { ok: true };
		}

		// ── Popup: pause ──────────────────────────────────────────────────
		case "PAUSE": {
			const pauseState = await getState();
			const pauseTabId =
				pauseState.kind === "recording" && pauseState.mode === "instruction"
					? pauseState.recorderTabId
					: undefined;
			// (M) The persisted flag must follow the RECORDER, not the intent. It
			// used to be written unconditionally, so a control message that never
			// arrived (dead offscreen document, closed recorder tab) left the popup
			// showing "Paused" over a recorder that was still merrily recording.
			let pauseDelivered: boolean;
			if (pauseTabId !== undefined) {
				pauseDelivered = await sendControlWithRetry(
					() => chrome.tabs.sendMessage(pauseTabId, { type: "PAUSE_CAPTURE" }),
					"PAUSE_CAPTURE→tab",
				);
			} else if (
				pauseState.kind === "recording" &&
				pauseState.contentRecorderTabId !== undefined
			) {
				pauseDelivered = await sendControlWithRetry(
					() =>
						chrome.tabs.sendMessage(pauseState.contentRecorderTabId!, {
							type: "PAUSE_CAPTURE",
						}),
					"PAUSE_CAPTURE→tab",
				);
			} else {
				pauseDelivered = await sendControlWithRetry(
					() => sendToOffscreen({ type: "PAUSE_CAPTURE" }),
					"PAUSE_CAPTURE→offscreen",
				);
			}
			if (!pauseDelivered) return { ok: false };
			if (pauseState.kind === "recording") {
				// (R2) Serialize the state write through enqueueRecorder and re-read
				// FRESH inside it. sendControlWithRetry above is a multi-hundred-ms
				// window in which handleChunk (also serialized on this queue) can
				// record a new part; writing back the stale pre-send snapshot dropped
				// that part from state.parts and rewound nextPartNumber, so the next
				// part reused its number and overwrote 5 MiB in R2. Mutate only the
				// pause fields.
				await enqueueRecorder(async () => {
					const fresh = await getState();
					if (fresh.kind !== "recording") return;
					const nextState = { ...fresh, paused: true, pausedAt: Date.now() };
					await setState(nextState);
					updateBadge(nextState);
				});
			}
			return { ok: true };
		}

		// ── Popup: resume ─────────────────────────────────────────────────
		case "RESUME": {
			const resumeState = await getState();
			const resumeTabId =
				resumeState.kind === "recording" && resumeState.mode === "instruction"
					? resumeState.recorderTabId
					: undefined;
			// (M) Same as PAUSE: an undelivered RESUME_CAPTURE must not clear the
			// persisted pause, or the popup shows "Recording" over a recorder that
			// is still paused and producing nothing.
			let resumeDelivered: boolean;
			if (resumeTabId !== undefined) {
				resumeDelivered = await sendControlWithRetry(
					() => chrome.tabs.sendMessage(resumeTabId, { type: "RESUME_CAPTURE" }),
					"RESUME_CAPTURE→tab",
				);
			} else if (
				resumeState.kind === "recording" &&
				resumeState.contentRecorderTabId !== undefined
			) {
				resumeDelivered = await sendControlWithRetry(
					() =>
						chrome.tabs.sendMessage(resumeState.contentRecorderTabId!, {
							type: "RESUME_CAPTURE",
						}),
					"RESUME_CAPTURE→tab",
				);
			} else {
				resumeDelivered = await sendControlWithRetry(
					() => sendToOffscreen({ type: "RESUME_CAPTURE" }),
					"RESUME_CAPTURE→offscreen",
				);
			}
			if (!resumeDelivered) return { ok: false };
			if (resumeState.kind === "recording") {
				// (R2) Same lost-update race as PAUSE — serialize through
				// enqueueRecorder and re-read fresh so a part recorded during the
				// resume-control window is not clobbered. Mutate only the pause fields.
				await enqueueRecorder(async () => {
					const fresh = await getState();
					if (fresh.kind !== "recording") return;
					const nextState = {
						...fresh,
						paused: false,
						pausedAt: undefined,
						pausedAccumMs:
							(fresh.pausedAccumMs ?? 0) +
							(fresh.pausedAt ? Date.now() - fresh.pausedAt : 0),
					};
					await setState(nextState);
					updateBadge(nextState);
				});
			}
			return { ok: true };
		}

		// ── Recorder tab: instruction capture aborted before it began ─────
		// The visible recorder tab cancelled the screen picker or was closed
		// before recording started. Release the "arming" lock — but ONLY if we
		// are still arming an instruction, so an active recording (meeting or a
		// running instruction) is never disrupted.
		case "INSTRUCTION_CANCEL": {
			const state = await getState();
			if (state.kind === "arming" && state.mode === "instruction") {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
			}
			return { ok: true };
		}

		// ── In-page recorder: the nudge's capture was aborted before it began ──
		//
		// The in-page path arms with mode "meeting" (MEET_NUDGE_CAPTURE_READY), so
		// INSTRUCTION_CANCEL above — which only releases an "instruction" arming —
		// could never clear it. A user who declined the "record without client
		// audio?" confirm left the SW armed, and a leftover recorder.html tab's
		// later RECORDER_STARTED would then inherit that stale arming: it recorded
		// with contentRecorderTabId pointing at the MEET tab, so a popup STOP was
		// routed to a tab that owned no capture, forcing a truncated finalize while
		// the real recorder carried on into a dropped-chunk void.
		// SENDER-SCOPED: only the very tab that armed it may release it, so this
		// can never be used to wipe another path's arming.
		case "MEET_NUDGE_CANCEL": {
			const state = await getState();
			if (
				state.kind === "arming" &&
				state.contentRecorderTabId !== undefined &&
				state.contentRecorderTabId === _sender.tab?.id
			) {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
			}
			return { ok: true };
		}

		// ── Popup: cancel ─────────────────────────────────────────────────
		case "CANCEL": {
			// Deliberate disarm — see the STOP case for why this guards the
			// tab-audio-loss watchdog.
			intentionalStop = true;
			const cancelState = await getState();
			// (F2b) The cancelled recording's recorder must never act again.
			if (cancelState.kind === "recording") {
				retireSession(cancelState.recorderSessionId);
			}
			const cancelTabId =
				cancelState.kind === "recording" && cancelState.mode === "instruction"
					? cancelState.recorderTabId
					: cancelState.kind === "arming" && cancelState.mode === "instruction"
					  ? cancelState.recorderTabId
					  : undefined;
			const contentCancelTabId =
				cancelState.kind === "recording" &&
				cancelState.contentRecorderTabId !== undefined
					? cancelState.contentRecorderTabId
					: cancelState.kind === "arming" &&
						  cancelState.contentRecorderTabId !== undefined
					  ? cancelState.contentRecorderTabId
					  : undefined;
			if (cancelTabId !== undefined) {
				// Tell the instruction recorder tab to stop so it sends RECORDER_STOPPED
				// and cleanup runs. Then also reset SW to idle immediately.
				await sendControlWithRetry(
					() => chrome.tabs.sendMessage(cancelTabId, { type: "STOP_CAPTURE" }),
					"STOP_CAPTURE→tab",
				);
			} else if (contentCancelTabId !== undefined) {
				await sendControlWithRetry(
					() =>
						chrome.tabs.sendMessage(contentCancelTabId, {
							type: "STOP_CAPTURE",
						}),
					"STOP_CAPTURE→tab",
				);
			} else {
				await sendControlWithRetry(
					() => sendToOffscreen({ type: "STOP_CAPTURE" }),
					"STOP_CAPTURE→offscreen",
				);
			}
			await closeOffscreenDocument();
			if (cancelState.kind === "recording") {
				await abortUpload(cancelState.uploadId);
			}
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
			return { ok: true };
		}

		// ── Popup: permanently discard an in-flight upload ────────────────
		// Distinct from CANCEL and from simply closing the popup. The popup's
		// non-destructive escape from "uploading" is now closing the window (the
		// upload continues in the background, which is what an impatient user
		// actually wants); THIS is the destructive one, and it is only reachable
		// behind a two-step confirmation. It must therefore actually destroy the
		// recording everywhere — local buffer, queued retries, dead letters, the
		// server-side multipart, and any object that already completed.
		case "DISCARD_UPLOAD": {
			const discardState = await getState();
			if (discardState.kind !== "uploading") {
				// Not an error the user should see: a background retry may simply
				// have moved the upload on (to finishing/complete) between the popup
				// rendering the button and the click landing. Nothing was attempted
				// and nothing was queued — the reply must say so ("noop") so the
				// popup does not falsely promise a retry (W3c).
				return { ok: false, reason: "not-uploading", outcome: "noop" };
			}
			// (Round-2 MUST-FIX) The serialized discard below waits behind a
			// running finalize/drain that can set "complete" — and auto-open the
			// video page — for THIS video before the discard's turn arrives. Veto
			// that open up front: the auto-open marker is written BEFORE
			// enqueueing (outside the queue, so it lands no matter how long the
			// queued work takes), and the completion tail's
			// maybeAutoOpenMeetingVideo then no-ops. The user must never see a
			// tab for a recording they chose to destroy. Best-effort by design
			// (suppressAutoOpen swallows errors): this must never block or fail
			// the discard itself.
			await suppressAutoOpen(discardState.videoId);
			// The recording is going away on purpose — suppress the watchdog
			// notifications that would otherwise announce it as a loss.
			intentionalStop = true;
			// (P1.5 / M4) Serialized like every other retry-queue writer: an
			// unserialized purge could race the alarm's drain and lose the update,
			// leaving exactly the queued retries this discard exists to remove.
			const { serverCleaned } = await enqueueRecorder(() =>
				discardUpload(discardState.videoId, discardState.uploadId),
			);
			// stillOurs (upload.ts uses the same pattern): the guard above read state
			// BEFORE enqueueing, and the discard's server calls take seconds. In that
			// window the drain can legitimately flip state to complete/error, and the
			// user can start a NEW recording from there — the error copy literally
			// tells them to re-record. An unconditional reset to idle then landed on
			// top of the LIVE recording B: handleChunk requires kind === "recording",
			// so every later chunk was dropped and finalize no-opped. Proved by an
			// adversarial test driving the real handlers: state went recording(vid-B)
			// -> idle when A's discard resolved. That is the owner's #1 failure —
			// a meeting lost, silently — caused by the button meant to be safe.
			const afterDiscard = await getState();
			const stillOurs =
				afterDiscard.kind === "uploading" &&
				afterDiscard.videoId === discardState.videoId &&
				afterDiscard.uploadId === discardState.uploadId;
			if (stillOurs) {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
			} else {
				// Residual case of the same race (same recording, no recording B):
				// the drain can also legitimately finish resolving THIS discarded
				// upload into a TERMINAL state — "complete" with a real share link,
				// or "error" telling the user to re-record — while discardUpload's
				// own abort/delete calls above were still resolving. cleanUpDiscard-
				// edVideoOnServer's delete-permanent runs even when the multipart had
				// already completed, so a "complete" seen here is already a dead
				// link server-side; showing it (or an unrelated "please re-record")
				// misleads the user about a recording they deliberately destroyed.
				// Only overwrite when the terminal state's OWN videoId still matches
				// THIS discard — a different videoId means recording B is the one in
				// progress/done and must be left completely alone, exactly like the
				// stillOurs guard above (see its comment + adversarial test).
				const terminalVideoId =
					afterDiscard.kind === "complete"
						? afterDiscard.videoId
						: afterDiscard.kind === "error"
						  ? afterDiscard.previousVideoId
						  : undefined;
				if (
					(afterDiscard.kind === "complete" ||
						afterDiscard.kind === "error") &&
					terminalVideoId === discardState.videoId
				) {
					const discardedState: ExtensionState = {
						kind: "error",
						reason: "This recording was permanently discarded.",
						recoverable: false,
					};
					await setState(discardedState);
					updateBadge(discardedState);
				}
			}
			if (!serverCleaned) {
				// Do not claim more than we did. The local side is genuinely gone,
				// but bytes may still be in storage, and for a confidential meeting
				// that difference is the whole point of the button. The cleanup is now
				// a durable queued task (survives a restart, retried for ~28h), so we
				// promise the retry instead of handing the user a chore — a promise we
				// may only make because discardUpload actually enqueued it.
				chrome.notifications.create("discard-partial", {
					type: "basic",
					iconUrl: "icons/icon-128.png",
					title: "Recording discarded on this device",
					message:
						"We couldn't reach the server yet. Deleting it there is queued and will keep retrying automatically.",
				});
			}
			// (W3c) Name the real outcome so the popup renders exactly what
			// happened: fully deleted, or genuinely queued for retry. Since the
			// durable discard is now queued before the network attempt and only
			// removed on full success, serverCleaned === false always means a task
			// is really pending — the retry promise is honest.
			return {
				ok: true,
				serverCleaned,
				outcome: serverCleaned ? "deleted" : "queued",
			};
		}

		// ── Popup / content: get state ────────────────────────────────────
		case "GET_STATE": {
			return await getState();
		}

		// ── Content: Meet call started ────────────────────────────────────
		case "MEET_CALL_STARTED": {
			const settings = await getSettings();
			if (settings.autoRecordOnMeet) {
				return {
					autoRecord: true,
					countdownSec: settings.autoRecordCountdownSec,
				};
			}
			return { autoRecord: false };
		}

		// ── Content: Meet call ended ──────────────────────────────────────
		case "MEET_CALL_ENDED": {
			const meetingId = getString(msg, "meetingId");
			const senderTabId = _sender.tab?.id;
			const state = await getState();
			if (
				state.kind === "recording" &&
				state.mode === "meeting" &&
				state.meetingId === meetingId &&
				(senderTabId === undefined || state.tabId === senderTabId) &&
				Date.now() - state.startedAt >= MIN_MEET_RECORDING_MS_BEFORE_AUTO_STOP
			) {
				// Deliberate stop — see the STOP case for why this guards the
				// tab-audio-loss watchdog.
				// Named in the log on purpose: this is the OTHER way an in-page
				// recording can end without the owner pressing Stop (the content
				// script stopped seeing a "Leave call" control for 5s). When a
				// recording ends unexpectedly, this line is what tells the two
				// causes apart in one glance at the service-worker console.
				console.warn(
					`[sw] stopping the recording because the content script reported the Meet call ended (meeting ${meetingId}).`,
				);
				intentionalStop = true;
				let autoStopDelivered: boolean;
				if (state.contentRecorderTabId !== undefined) {
					autoStopDelivered = await sendControlWithRetry(
						() =>
							chrome.tabs.sendMessage(state.contentRecorderTabId!, {
								type: "STOP_CAPTURE",
							}),
						"STOP_CAPTURE→tab",
					);
				} else {
					autoStopDelivered = await sendControlWithRetry(
						() => sendToOffscreen({ type: "STOP_CAPTURE" }),
						"STOP_CAPTURE→offscreen",
					);
				}
				// (R8) Same fallback as the STOP case: the meeting ended and the
				// recorder never got the stop, so finalize here rather than leave
				// the recording stuck with uncompleted parts.
				if (!autoStopDelivered) {
					await enqueueRecorder(() => finalizeRecording());
				}
			} else if (
				state.kind === "recording" &&
				state.mode === "instruction" &&
				state.meetingRequired === true &&
				state.sourceTabId !== undefined &&
				senderTabId === state.sourceTabId &&
				Date.now() - state.startedAt >= MIN_MEET_RECORDING_MS_BEFORE_AUTO_STOP
			) {
				// Guaranteed full-screen meeting: don't auto-stop (false-detection
				// risk) or silently continue — ask the admin (owner's choice).
				promptStopOnMeetEnded();
			}
			return { ok: true };
		}

		// ── Content: user clicked "Record now" nudge ──────────────────────
		// FIX A (Codex v4): chrome.action.openPopup() gives NO guarantee of
		// granting activeTab/tabCapture — only a direct click on the extension
		// icon does. This handler therefore NEVER attempts tabCapture itself
		// (that used to fail silently into a client-less recording in the rare
		// case activeTab happened to still be granted from an unrelated earlier
		// icon click). It only opens the popup as a convenience; the guarantee
		// rests entirely on the user clicking "Record full-screen meeting" there.
		case "MEET_NUDGE_RECORD_NOW": {
			const state = await getState();
			if (isInProgress(state)) {
				return { ok: false, error: "A recording is already in progress" };
			}
			const settings = await getSettings();
			if (!settings.apiKey) {
				// Not signed in — open the popup so the user can sign in.
				// Fix #2: chrome.action.openPopup() is Chrome 127+ only; the build
				// targets chrome120 where calling it throws synchronously before
				// .catch() can run, skipping the fallback. Guard with typeof check.
				try {
					if (typeof chrome.action?.openPopup === "function") {
						await (chrome.action.openPopup() as Promise<void>).catch(() => {
							chrome.runtime.openOptionsPage();
						});
					} else {
						chrome.runtime.openOptionsPage();
					}
				} catch {
					chrome.runtime.openOptionsPage();
				}
				return { ok: false, error: "not signed in" };
			}
			try {
				if (typeof chrome.action?.openPopup === "function") {
					await chrome.action.openPopup();
				}
			} catch {
				// Convenience only — ignore failures; the nudge text already told
				// the user to click the icon manually.
			}
			return { ok: true };
		}

		// Content: the in-page Meet nudge already obtained a getDisplayMedia()
		// stream from the real button gesture. Prepare SW state so its following
		// RECORDER_STARTED message initializes a meeting upload, not instruction.
		case "MEET_NUDGE_CAPTURE_READY": {
			const meetingId = getString(msg, "meetingId");
			const tabId = await resolveMeetSenderTabId(_sender);
			const state = await getState();
			if (isInProgress(state)) {
				return { ok: false, error: "A recording is already in progress" };
			}
			const settings = await getSettings();
			if (!settings.apiKey) {
				try {
					if (typeof chrome.action?.openPopup === "function") {
						await (chrome.action.openPopup() as Promise<void>).catch(() => {
							chrome.runtime.openOptionsPage();
						});
					} else {
						chrome.runtime.openOptionsPage();
					}
				} catch {
					chrome.runtime.openOptionsPage();
				}
				return { ok: false, error: "not signed in" };
			}
			if (tabId === undefined) {
				return { ok: false, error: "No Meet tab to record" };
			}
			await setState({
				kind: "arming",
				mode: "meeting",
				meetingId,
				tabId,
				contentRecorderTabId: tabId,
			});
			return {
				ok: true,
				micEnabled: settings.micEnabled,
				micDeviceId: settings.micDeviceId,
			};
		}

		case "MEET_NUDGE_LATER":
		case "MEET_NUDGE_DISMISS":
			return { ok: true };

		// ── Content: settings query ───────────────────────────────────────
		case "GET_SETTINGS": {
			const settings = await getSettings();
			return {
				autoRecordOnMeet: settings.autoRecordOnMeet,
				autoRecordCountdownSec: settings.autoRecordCountdownSec,
				soundEnabled: settings.soundEnabled,
			};
		}

		// ── Recorder tab: request the source tab's audio (remote participants) ──
		// Minted here (SW) with consumerTabId = the recorder tab, so THAT tab can
		// consume it via getUserMedia(chromeMediaSource:"tab"). No "share system
		// audio" tick needed. Returns { streamId: null } when there is no usable
		// source tab (e.g. launched from a non-capturable page) — the recorder then
		// falls back to screen + mic. `required` mirrors meetingRequired and MUST
		// be preserved on every failure branch — the recorder page fails closed
		// (never starts / hard-stops) instead of silently dropping client audio
		// when required is true.
		case "REQUEST_TAB_AUDIO": {
			// Derived from the MESSAGE, not the volatile "arming" state — arming
			// gets cleared by INSTRUCTION_CANCEL (picker cancel, error→RETRY, or
			// ANY other recorder.html tab's beforeunload) well before a retried
			// start reaches here, which used to silently turn `required` false on
			// the very next attempt. The recorder page re-sends these fields
			// (parsed once from its own URL) on every call, so the guarantee now
			// lives with THAT TAB instead. Trust requires the sender to be our own
			// recorder page (isOwnExtensionSender) — a content script cannot forge
			// this even if it sends the same field names.
			const senderIsOwnRecorderPage = isOwnExtensionSender(_sender.url);
			const sourceTabId = senderIsOwnRecorderPage
				? getNumber(msg, "sourceTabId")
				: undefined;
			const required =
				senderIsOwnRecorderPage && _getBoolean(msg, "meeting") === true;
			const consumerTabId = _sender.tab?.id;
			if (sourceTabId === undefined || consumerTabId === undefined) {
				return { streamId: null, required };
			}
			// Re-verify the source tab still exists AND is still a Meet tab before
			// minting — a stale/closed/navigated-away tab must never silently mint
			// a stream id for the wrong (or gone) content.
			try {
				const sourceTab = await chrome.tabs.get(sourceTabId);
				if (!isMeetUrl(sourceTab.url)) {
					return { streamId: null, required };
				}
			} catch {
				return { streamId: null, required };
			}
			try {
				const streamId = await getTabMediaStreamId(sourceTabId, consumerTabId);
				return { streamId, required };
			} catch (err) {
				console.warn("[sw] tab-audio streamId failed:", err);
				return { streamId: null, required };
			}
		}

		// ── Recorder tab: mid-recording tab-audio degradation detected locally ──
		// The recorder page detected the tab-audio track/context degraded but did
		// NOT stop its own recorder (see recorder-page.ts handleTabAudioDegraded —
		// owner 2026-07-15: never stop, warn + auto-recover when possible). We
		// only notify + badge — NEVER set state to "error", which would make
		// finalizeRecording() bail (state.kind !== "recording").
		case "TAB_AUDIO_DEGRADED": {
			const cause = getString(msg, "cause");
			if (
				!intentionalStop &&
				(cause === "muted" || cause === "suspended" || cause === "ended")
			) {
				notifyTabAudioDegraded(cause);
			}
			return { ok: true };
		}

		// ── Recorder tab: mid-recording tab-audio recovered (muted→unmuted, or
		// audioCtx resumed) ───────────────────────────────────────────────────
		case "TAB_AUDIO_RECOVERED": {
			if (!intentionalStop) await notifyTabAudioRecovered();
			return { ok: true };
		}

		// ── Offscreen: recorder started ───────────────────────────────────
		case "RECORDER_STARTED": {
			const mime = getString(msg, "mime") ?? "video/webm";
			const startSessionId = getString(msg, "sessionId");
			// (F2b) REQUIRE the id. Without it the recording below would be created
			// with no owner, and isForeignRecorderSession — which can only be lenient
			// when there is nothing to compare against — would then wave through every
			// message from every session, re-opening the interleaving bug completely.
			// All three recorder paths stamp this; refusing loudly beats accepting a
			// recording that silently cannot be protected.
			if (!startSessionId) {
				return { ok: false, error: "RECORDER_STARTED requires a sessionId" };
			}
			if (isRetiredSession(startSessionId)) return STALE_SESSION_REPLY;
			// (F2b) ATOMIC REGISTRATION. The guard below reads state, then awaits
			// initializeUpload (a network round-trip) before writing it back, so two
			// starts arriving together BOTH passed the guard and BOTH minted an
			// upload — the later setState won and the other upload plus its recorder
			// were orphaned. This flag is set synchronously before any await, so on a
			// single-threaded runtime the second start cannot slip through the gap.
			if (recorderStartInFlight) {
				// `reason` lets the losing sender clean up QUIETLY. If it reported this
				// as a RECORDER_ERROR instead, that error would arrive while the WINNER
				// is still arming and tear its offscreen document down — the refusal
				// would cause the very failure it exists to prevent.
				return {
					ok: false,
					reason: "start-in-flight" as const,
					error: "A recording start is already in progress.",
				};
			}
			recorderStartInFlight = true;
			try {
			const state = await getState();
			// (F1) This is the ONE message that WRITES the recording state, yet it
			// was the only start path with no in-progress guard (START_INSTRUCTION
			// / START_MEET / both nudge handlers all check isInProgress). A
			// leftover recorder.html tab parked at the idle view — normal after a
			// picker cancel/RETRY, and it STAYS idle for the whole of an
			// offscreen-path meeting recording — could overwrite a LIVE
			// recording's state with a new video: the meeting's uploaded parts are
			// orphaned forever (multipart never completed) AND the still-running
			// meeting recorder's chunks then land in the NEW upload's buffer
			// (handleChunk only checks kind === "recording", and identity now
			// matches), interleaving two MediaRecorder streams into one object.
			// Old meeting lost and new video corrupt, both silently.
			//
			// Distinguishing the legitimate sender: a normal start never reaches
			// here while isInProgress() — the state is "arming" (happy path) or
			// idle/error/complete (the cancel→retry paths), none of which are
			// in-progress — so BOTH legitimate senders (offscreen document and
			// recorder page) pass untouched. Only a re-send from the recording's
			// OWN recorder context is allowed through once a recording is live:
			// the recorder page owns it when its sender tab id equals
			// state.recorderTabId, and the offscreen document (which has no
			// sender.tab at all) owns it exactly when the live recording carries
			// no recorderTabId — so both sides compare as `undefined` only for
			// the true owner. During "uploading"/"finishing" nothing may start:
			// the recorder is already torn down, so there is no owner to re-send.
			// STRICT: no re-send is admitted while a recording is in progress.
			// An earlier version tried to admit "the recording's own recorder tab",
			// but the ownership test collapsed to `undefined === undefined` for
			// every sender failing the extension-origin check — on the offscreen
			// path (where recorderTabId is also undefined) that admitted content
			// scripts and the popup, i.e. the very hijack this guard exists to
			// stop. Deleting the allowance closes that hole and costs nothing:
			// both senders (offscreen/recorder.ts, recorder-page.ts) fire exactly
			// once, inside their start function, right before recorder.start(), so
			// no legitimate mid-recording re-send exists. Legitimate STARTS never
			// reach here either — isInProgress deliberately excludes "arming", and
			// the cancel->RETRY paths run from "idle"/"error".
			if (isInProgress(state)) {
				console.warn(
					"[sw] RECORDER_STARTED refused: a recording is already in progress",
				);
				return {
					ok: false,
					error:
						"A recording is already in progress. Stop it before starting a new one.",
				};
			}
			const mode = state.kind === "arming" ? state.mode : "instruction";
			const tabId = state.kind === "arming" ? state.tabId : undefined;
			const senderIsOwnRecorderPage = isOwnExtensionSender(_sender.url);
			// The sender IS the recorder tab, so use it when arming is gone. Without
			// this, every flow this fix rescues (cancel->retry, error->Try again)
			// recorded with recorderTabId undefined, which silently broke two things:
			// the meet-ended notification's stop button sent no STOP_CAPTURE while
			// still setting intentionalStop (recording ran on, degraded-audio warnings
			// muted), and the tabs.onRemoved finalize fallback never matched, so
			// closing the recorder tab left the state stuck in "recording" - where the
			// user's natural next move, CANCEL, destroys the uploaded parts.
			// The offscreen document has no sender.tab, so this only affects the
			// recorder page.
			const recorderTabId =
				state.kind === "arming"
					? state.recorderTabId
					: senderIsOwnRecorderPage
						? _sender.tab?.id
						: undefined;
			const contentRecorderTabId =
				state.kind === "arming" ? state.contentRecorderTabId : undefined;
			// Prefer the guarantee fields carried on THIS message (same trust rule
			// as REQUEST_TAB_AUDIO — sender must be our own recorder page) over
			// arming state: an INSTRUCTION_CANCEL/RETRY between START_INSTRUCTION
			// and this message wipes arming, and without this fallback the
			// RecordingState would lose sourceTabId/meetingRequired, silently
			// killing the mid-recording watchdogs that key off them
			// (handleSourceTabLost, the meet-ended prompt) for the rest of the
			// recording — see state.ts ArmingState.meetingRequired.
			const messageSourceTabId = senderIsOwnRecorderPage
				? getNumber(msg, "sourceTabId")
				: undefined;
			const messageMeetingRequired = senderIsOwnRecorderPage
				? _getBoolean(msg, "meeting")
				: undefined;
			// Same fallback for the meeting identifier itself (populated on the
			// message by recorder-page.ts from its own ?meetingId= URL param — see
			// openInstructionRecorder above), so it survives a cleared arming record
			// exactly like sourceTabId/meetingRequired do.
			const messageMeetingId = senderIsOwnRecorderPage
				? getString(msg, "meetingId")
				: undefined;
			const sourceTabId =
				messageSourceTabId !== undefined
					? messageSourceTabId
					: state.kind === "arming"
					  ? state.sourceTabId
					  : undefined;
			const meetingRequired =
				messageMeetingRequired !== undefined
					? messageMeetingRequired
					: state.kind === "arming"
					  ? state.meetingRequired
					  : undefined;
			const meetingId =
				messageMeetingId !== undefined
					? messageMeetingId
					: state.kind === "arming"
					  ? state.meetingId
					  : undefined;

			let videoId: string;
			let uploadId: string;
			try {
				// Upload identity only — state.mode (the STOP/PAUSE/RESUME/CANCEL and
				// tabs.onRemoved control-flow discriminator) is deliberately left
				// untouched below; this only decides how the upload is TITLED/FILED.
				// The guaranteed full-screen meeting flow keeps mode "instruction"
				// throughout but must still file as a meeting — the shared
				// isMeetingFiling helper is the ONE definition of that rule
				// (also used for the auto-open flag), so the two cannot drift.
				const result = await initializeUpload(
					isMeetingFiling(mode, meetingRequired) ? "meeting" : mode,
					meetingId,
				);
				videoId = result.videoId;
				uploadId = result.uploadId;
			} catch (err) {
				console.error("[sw] initializeUpload failed:", err);
				const errState: ExtensionState = {
					kind: "error",
					reason: `Failed to initialize upload: ${err instanceof Error ? err.message : String(err)}`,
					recoverable: true,
				};
				await setState(errState);
				updateBadge(errState);
				await closeOffscreenDocument().catch(() => {});
				return { ok: false, error: "initializeUpload failed" };
			}

			const nextState: ExtensionState = {
				kind: "recording",
				mode,
				videoId,
				uploadId,
				startedAt: Date.now(),
				parts: [],
				nextPartNumber: 1,
				totalBytes: 0,
				uploadedBytes: 0,
				meetingId,
				tabId,
				mime,
				paused: false,
				pausedAccumMs: 0,
				recorderTabId,
				contentRecorderTabId,
				sourceTabId,
				meetingRequired,
				// (F2) The recorder mints this and echoes it on every later message;
				// anything that does not match is a leftover from an EARLIER session
				// and must never touch this upload. Absent only when an older,
				// unstamped build is the sender.
				recorderSessionId: startSessionId,
			};
			// Any recording this one supersedes is over — retire it so its recorder
			// cannot act during, or after, this start.
			if (state.kind === "recording") retireSession(state.recorderSessionId);
			await setState(nextState);
			// A new recording starts clean: no stop is "in flight" yet, and any
			// prior tab-audio-degraded notification no longer applies.
			intentionalStop = false;
			tabAudioDegradedNotified = false;
			// A fresh capture always begins at the best tier; the previous
			// recording's backlog says nothing about this one's link.
			resetCaptureTierTracking();
			startKeepAlive();
			updateBadge(nextState);
			return { ok: true };
			} finally {
				recorderStartInFlight = false;
			}
		}

		// ── Offscreen: data chunk ─────────────────────────────────────────
		case "RECORDER_CHUNK": {
			const raw = msg.chunk as number[] | undefined;
			const index = getNumber(msg, "index") ?? 0;
			const mime = getString(msg, "mime") ?? "video/webm";
			const sessionId = getString(msg, "sessionId");
			// (F2b) A retired session is refused whatever the current state is —
			// including "arming", where there is no live id to compare against.
			if (isRetiredSession(sessionId)) return STALE_SESSION_REPLY;
			if (raw && Array.isArray(raw) && raw.length > 0) {
				// (F2) The ownership check lives INSIDE handleChunk, against the very
				// state it then appends to — checking out here would be
				// time-of-check/time-of-use, because CANCEL and RECORDER_STARTED write
				// state outside this queue (see upload.ts R7).
				// Counted BEFORE the queue and released the moment this chunk leaves
				// it, so adaptCaptureTier below sees the bytes still waiting behind us
				// without double-counting our own (which totalBytes now includes).
				noteChunkQueued(raw.length);
				// Where the media ends, captured at ARRIVAL: by the time the
				// finalize runs, a slow link may have held this chunk in the queue
				// for minutes (see mediaEndedAt).
				noteChunkTimestamp(sessionId, getNumber(msg, "ts"));
				let outcome: Awaited<ReturnType<typeof handleChunk>>;
				try {
					outcome = await enqueueRecorder(() =>
						handleChunk(new Uint8Array(raw).buffer, index, mime, sessionId),
					);
				} finally {
					noteChunkDequeued(raw.length);
				}
				if (outcome === "stale") return STALE_SESSION_REPLY;
				// The uploader has just reported whatever this chunk produced, so the
				// backlog is as fresh as it gets. Deliberately OUTSIDE enqueueRecorder:
				// this only reads state, and its retrying send would otherwise park the
				// queue that the next chunk's upload has to run on.
				await adaptCaptureTier(sessionId);
			}
			return { ok: true };
		}

		// ── Offscreen: recorder stopped ───────────────────────────────────
		case "RECORDER_STOPPED": {
			const stopSessionId = getString(msg, "sessionId");
			if (isRetiredSession(stopSessionId)) return STALE_SESSION_REPLY;
			const stopped = await enqueueRecorder(() =>
				finalizeRecording(stopSessionId, true),
			);
			if (stopped === "stale") return STALE_SESSION_REPLY;
			return { ok: true };
		}

		// ── Offscreen: recorder error ─────────────────────────────────────
		case "RECORDER_ERROR": {
			const error = getString(msg, "error") ?? "Unknown recorder error";
			const errorSessionId = getString(msg, "sessionId");
			// (F2b) THE arming hole: with no recording live there is no id to compare
			// against, so a dead session's error used to flip a NEW attempt that was
			// still arming into "error" and close its offscreen document. Judging the
			// message by its own retired id needs no live state at all.
			if (isRetiredSession(errorSessionId)) return STALE_SESSION_REPLY;

			const errOutcome = await enqueueRecorder(async () => {
				// (P1.1 / M2) Route the WHOLE handler through enqueueRecorder: this
				// mutates state and (via finalizeUpload) the retry queue, and
				// handleChunk's loop bails on kind !== "recording" mid-part-upload
				// — an un-serialized error write here could drop parts that were
				// still being uploaded.
				const stateBefore = await getState();
				// (F2c) RE-CHECK retirement in the queue, not only at the handler edge:
				// this job can sit behind a slow chunk while a CANCEL retires its
				// session, and by the time it runs the edge verdict is out of date.
				if (isRetiredSession(errorSessionId)) {
					console.warn(
						`[sw] ignored RECORDER_ERROR from a session retired while queued (${errorSessionId})`,
					);
					return "stale" as const;
				}
				// (F2) A stale recorder's error is the most destructive of the three
				// stray messages: below it flips state to "error", runs a salvage
				// finalizeUpload and closes the offscreen document — i.e. it would
				// tear down a recording that is alive and well. Checked against this
				// job's own state read, inside the queue.
				// Same strictness as RECORDER_STOPPED above, for the same falsified
				// reason: an UNSTAMPED error message counts as foreign once the live
				// recording carries an id. Internal error paths do not come through
				// here, so nothing legitimate is refused.
				if (
					stateBefore.kind === "recording" &&
					isForeignRecorderSession(stateBefore, errorSessionId)
				) {
					console.warn(
						`[sw] ignored RECORDER_ERROR from a stale recorder session (${errorSessionId}); live=${stateBefore.recorderSessionId}`,
					);
					return "stale" as const;
				}
				// (F2c) THE ARMING WINDOW. A session that was never admitted is never
				// retired, so the retired-list cannot judge it — and while a NEW attempt
				// is arming there is no live id either. Left open, a stray recorder's
				// error flips the arming attempt to "error" and closes the offscreen
				// document it is still acquiring media into. During arming the only
				// legitimate error comes from the CONTEXT THAT ARMED IT, so identify the
				// sender instead: the recorder page by its tab id, the offscreen document
				// by having no tab at all (matching the ownership convention used by
				// RECORDER_STARTED above).
				if (stateBefore.kind === "arming") {
					const senderTabId = _sender.tab?.id;
					const armedTabId =
						stateBefore.recorderTabId ?? stateBefore.contentRecorderTabId;
					if (senderTabId !== armedTabId) {
						console.warn(
							`[sw] ignored RECORDER_ERROR from a foreign sender while arming (session ${errorSessionId ?? "unstamped"})`,
						);
						return "stale" as const;
					}
				}
				// Accepted as genuine: this recording is over, so retire its session.
				if (stateBefore.kind === "recording") {
					retireSession(stateBefore.recorderSessionId);
				}
				const wasRecording = stateBefore.kind === "recording";
				const previousVideoId = wasRecording
					? stateBefore.videoId
					: undefined;
				const bytesBefore = wasRecording ? stateBefore.uploadedBytes : 0;

				stopKeepAlive();
				await closeOffscreenDocument().catch(() => {});

				// (M1) Salvage first — every part already uploaded (potentially a
				// long meeting) must not be abandoned mid-multipart just because
				// the recorder itself errored out.
				if (wasRecording) {
					await finalizeUpload();
				}

				const stateAfter = await getState();

				if (stateAfter.kind === "complete") {
					updateBadge(stateAfter);
					chrome.notifications.create("recorder-error", {
						type: "basic",
						iconUrl: "icons/icon-128.png",
						title: "Recording error — saved",
						message: `A recording error occurred (${error}), but ${bytesBefore} bytes were salvaged and saved.`,
					});
					return;
				}

				if (stateAfter.kind === "uploading") {
					// (P1.6) finalizeUpload left a durable, retryable "complete"
					// record because some parts are still queued — do not stomp
					// this with a generic error state; it will keep draining.
					updateBadge(stateAfter);
					chrome.notifications.create("recorder-error", {
						type: "basic",
						iconUrl: "icons/icon-128.png",
						title: "Recording error — retrying upload",
						message: `A recording error occurred (${error}); the upload is retrying in the background.`,
					});
					return;
				}

				if (stateAfter.kind === "error") {
					// finalizeUpload already set a more specific reason (no durable
					// video data, retry failed, ...) — keep it rather than
					// overwriting.
					updateBadge(stateAfter);
					chrome.notifications.create("recorder-error", {
						type: "basic",
						iconUrl: "icons/icon-128.png",
						title: "Recording error",
						message: stateAfter.reason,
					});
					return;
				}

				// Nothing was recording (or finalizeUpload didn't run) — fall back
				// to a plain error report.
				const nextState: ExtensionState = {
					kind: "error",
					reason: error,
					recoverable: true,
					previousVideoId,
				};
				await setState(nextState);
				updateBadge(nextState);
				chrome.notifications.create("recorder-error", {
					type: "basic",
					iconUrl: "icons/icon-128.png",
					title: "Recording error",
					message: error,
				});
			});

			if (errOutcome === "stale") return STALE_SESSION_REPLY;
			return { ok: true };
		}

		// ── Popup: retry after error ──────────────────────────────────────
		case "RETRY": {
			const state = await getState();
			if (state.kind !== "error")
				return { ok: false, error: "not in error state" };
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
			return { ok: true };
		}

		// ── Options: save settings ────────────────────────────────────────
		case "SAVE_SETTINGS": {
			const settings = msg.settings as Partial<ExtensionSettings> | undefined;
			if (settings) {
				await setSettings(settings);
			}
			return { ok: true };
		}

		// ── Options: get all settings ─────────────────────────────────────
		case "GET_ALL_SETTINGS": {
			return await getSettings();
		}

		// ── Sign-in-with-Cap token from options page ──────────────────────
		case "CAP_EXTENSION_TOKEN": {
			const token = getString(msg, "token");
			const apiBaseUrl = getString(msg, "apiBaseUrl");
			if (token) {
				await setSettings({
					apiKey: token,
					...(apiBaseUrl ? { apiBaseUrl } : {}),
				});
			}
			return { ok: true };
		}

		// ── Popup/Options: sign in via Chrome identity (robust OAuth) ──────
		// Runs launchWebAuthFlow in the SERVICE WORKER (not the popup, which can
		// close mid-flow). The web callback redirects to chrome.identity's
		// redirect URL with the freshly-minted token in the URL fragment; we
		// extract and persist it. No reliance on externally_connectable or any
		// web→extension messaging, so it works on any deploy URL and for any user.
		case "START_SIGNIN": {
			const settings = await getSettings();
			const baseUrl = settings.apiBaseUrl || DEFAULT_API_BASE_URL;
			const redirectUri = chrome.identity.getRedirectURL();
			const url = `${baseUrl}/extension/callback?redirect=${encodeURIComponent(
				redirectUri,
			)}`;
			let responseUrl: string | undefined;
			try {
				responseUrl = await new Promise<string | undefined>(
					(resolve, reject) => {
						chrome.identity.launchWebAuthFlow(
							{ url, interactive: true },
							(r) => {
								if (chrome.runtime.lastError) {
									reject(new Error(chrome.runtime.lastError.message));
								} else {
									resolve(r ?? undefined);
								}
							},
						);
					},
				);
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : "sign-in failed",
				};
			}
			if (!responseUrl) return { ok: false, error: "sign-in cancelled" };
			let signInToken: string | undefined;
			try {
				const hash = new URL(responseUrl).hash.replace(/^#/, "");
				signInToken = new URLSearchParams(hash).get("token") ?? undefined;
			} catch {
				signInToken = undefined;
			}
			if (!signInToken) return { ok: false, error: "no token returned" };
			await setSettings({ apiKey: signInToken, apiBaseUrl: baseUrl });
			return { ok: true };
		}

		default:
			return { ok: false, error: `unknown message type: ${type}` };
	}
}

// ── External message handler (sign-in-with-Cap callback page) ─────────────

chrome.runtime.onMessageExternal.addListener(
	(message: unknown, _sender, sendResponse) => {
		if (!isMessageBase(message)) {
			sendResponse({ ok: false });
			return false;
		}
		const msg = message as Record<string, unknown>;
		if (msg.type === "CAP_EXTENSION_TOKEN") {
			const token = getString(msg, "token");
			const apiBaseUrl = getString(msg, "apiBaseUrl");
			// Security: only accept a token write from a page whose origin matches
			// the configured Cap server (or the well-known cloud / localhost dev
			// origins). externally_connectable wildcards *.up.railway.app, so an
			// untrusted subdomain page could otherwise hijack apiKey + apiBaseUrl.
			getSettings()
				.then((settings) => {
					if (!isTrustedTokenSender(_sender.url, settings.apiBaseUrl)) {
						console.warn(
							"Rejected CAP_EXTENSION_TOKEN from untrusted origin:",
							_sender.url,
						);
						sendResponse({ ok: false, error: "untrusted origin" });
						return;
					}
					// Guard against a trusted sender repointing uploads to a different
					// backend: if the message carries an apiBaseUrl whose origin differs
					// from the sender's own origin, reject the write.
					if (apiBaseUrl) {
						const senderOrigin = originOf(_sender.url);
						const requestedOrigin = originOf(apiBaseUrl);
						if (
							!senderOrigin ||
							!requestedOrigin ||
							senderOrigin !== requestedOrigin
						) {
							console.warn(
								"Rejected CAP_EXTENSION_TOKEN: apiBaseUrl origin mismatch",
								{ senderOrigin, requestedOrigin },
							);
							sendResponse({
								ok: false,
								error: "apiBaseUrl/origin mismatch",
							});
							return;
						}
					}
					setSettings({
						apiKey: token ?? "",
						...(apiBaseUrl ? { apiBaseUrl } : {}),
					}).then(() => {
						// Relay internally so an open popup/options page auto-updates
						// instead of waiting for its 20s fallback timeout.
						chrome.runtime
							.sendMessage({ type: "CAP_EXTENSION_TOKEN", token, apiBaseUrl })
							.catch(() => {});
						sendResponse({ ok: true });
					});
				})
				.catch(() => {
					sendResponse({ ok: false, error: "settings read failed" });
				});
			return true;
		}
		sendResponse({ ok: false });
		return false;
	},
);

// ── Internal message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
	(message: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
		handleMessage(message, sender)
			.then(sendResponse)
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				sendResponse({ ok: false, error: msg });
			});
		return true;
	},
);

// ── Keyboard command: one-key meeting recording ───────────────────────────
// Ctrl+Shift+9 (manifest `commands`) on a Meet tab = the same guaranteed
// full-screen meeting flow the popup auto-fire starts. Commands are an official
// activeTab-granting invocation surface, so tabCapture works exactly as it does
// after a toolbar-icon click — one keypress instead of icon+popup. (Also the
// invocation surface the e2e audio-proof harness drives.)
chrome.commands.onCommand.addListener((command) => {
	if (command !== "start-meeting-recording") return;
	void (async () => {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		const meetingId = getMeetingId(tab?.url);
		if (tab?.id === undefined || meetingId === null) return; // not a Meet tab
		// Same message the popup sends; sender unused by this case.
		await handleMessage(
			{
				type: "START_INSTRUCTION",
				sourceTabId: tab.id,
				meeting: true,
				meetingId,
			},
			{} as chrome.runtime.MessageSender,
		).catch(() => {});
	})();
});

// ── Alarms ────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
	if (isKeepAliveAlarm(alarm.name)) {
		chrome.storage.local.get("capExtState");
	}
	if (isRetryAlarm(alarm.name)) {
		// (P1.5 / M4) Routed through enqueueRecorder — the SAME serialization
		// chain as handleChunk/finalizeRecording — so a drain can never race a
		// live recording's addToRetryQueue call. Without this, getRetryQueue/
		// setRetryQueue's get-then-set would be a classic lost update: a part
		// queued by a live recording mid-drain could silently vanish.
		enqueueRecorder(() => retryPendingUploads()).catch(() => {});
	}
});

// ── SW startup recovery ────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
	const state = await getState();

	// (W3b) A pending discard means the user permanently destroyed this recording
	// and the browser died before the server cleanup finished — so state is still
	// an in-progress kind AND a durable discard task is queued. NONE of the revive
	// branches below may run: finalizeUpload / resumeInterruptedFinishing would
	// complete the multipart and publish a share link for a recording the user
	// killed. Release the UI to idle and let the queued discard (drained at the
	// end) finish the destruction — mirroring the normal discard's idle+cleanup.
	const inProgressVideoId =
		state.kind === "recording" ||
		state.kind === "uploading" ||
		state.kind === "finishing"
			? state.videoId
			: undefined;
	if (inProgressVideoId && (await hasPendingDiscard(inProgressVideoId))) {
		// The marker is planted before the local cleanup, so the browser may have
		// died in between — finish the local half here (idempotent) or the drain
		// below would re-upload parts of a recording the user destroyed.
		await finishLocalDiscardTraces(inProgressVideoId);
		await setState({ kind: "idle" });
		updateBadge({ kind: "idle" });
		await enqueueRecorder(() => retryPendingUploads());
		return;
	}

	if (state.kind === "recording") {
		chrome.notifications.create("recording-interrupted", {
			type: "basic",
			iconUrl: "icons/icon-128.png",
			title: "Recording interrupted",
			message:
				"The browser restarted during recording. Uploading what was captured...",
		});
		const nextState: ExtensionState = {
			kind: "uploading",
			videoId: state.videoId,
			uploadId: state.uploadId,
			parts: state.parts,
			totalBytes: state.totalBytes,
			uploadedBytes: state.uploadedBytes,
			// Same meeting flag as finalizeRecording's transition — kept through
			// the restart so the eventual completion still auto-opens.
			isMeeting: isMeetingFiling(state.mode, state.meetingRequired),
		};
		await setState(nextState);
		updateBadge(nextState);
	}

	if (state.kind === "recording" || state.kind === "uploading") {
		startKeepAlive();
		// state was read once above and never reassigned, so when it was
		// originally "recording" this narrowing still holds here — compute the
		// duration from it before it's lost (same reasoning as finalizeRecording;
		// a state that was already "uploading" at startup never carried timing
		// fields, so there is nothing to compute).
		const durationInSecs =
			state.kind === "recording"
				? computeDurationInSecs(
						state.startedAt,
						state.pausedAccumMs,
						state.paused,
						state.pausedAt,
					)
				: undefined;
		// (P1.2 / M5) Widened past the "recording" branch: a persisted
		// "uploading" state (crash mid-finalize) needs this exactly as much —
		// finalizeUpload already accepts it. Without this, state parked at
		// "uploading" forever and isInProgress() refused every future
		// recording until the user found CANCEL.
		await enqueueRecorder(() => finalizeUpload(durationInSecs));
	} else if (state.kind === "finishing") {
		// (R9) A crash during completeMultipart. Every byte is already in R2, so
		// re-queue the finalize durably instead of writing the recording off —
		// the drain below finishes it (and R6's horizon lets it survive a long
		// outage). The state is still released to a recoverable error so
		// isInProgress() stops refusing new recordings; when the queued complete
		// lands, the drain flips it to "complete" with the share link (its
		// stillOurs guard accepts error + previousVideoId).
		// (P1.2 / M5) A legacy persisted state carries no snapshot — nothing to
		// resume from, so it keeps the original write-off message.
		// (F3) Routed through enqueueRecorder — the SAME serialization chain as
		// the alarm's drain (chrome.alarms.onAlarm above) — because this was the
		// only capExtRetryQueue writer left running unserialized. A persisted
		// overdue retry alarm fires at browser startup too, and it exists
		// precisely when the queue is non-empty, so its drain can be mid
		// get→await→set while this addToRetryQueue read-modify-writes the same
		// key: a classic lost update in which the re-queued "complete" is
		// clobbered by the drain's stale write-back. Every byte would already be
		// in R2 with the multipart never completed, while the state promises the
		// user "we're completing it in the background" with nothing behind it.
		// Do NOT await the chain here. Awaiting held the in-progress lock behind
		// whatever was already queued — and at startup the overdue retry alarm
		// (which exists precisely because the queue is non-empty) usually claims
		// the chain first. Measured: state sat at "finishing", so START_INSTRUCTION
		// answered "A recording is already in progress" and the extension REFUSED
		// TO RECORD A MEETING — the owner's #1 requirement, broken by its own fix.
		// It also never queued the "complete" it exists to queue (queueLen=1 across
		// three restarts vs 2 before). `resumed` is a pure predicate of these
		// arguments (see resumeInterruptedFinishing), so compute it here, release
		// the state immediately, and let the queue WRITE stay serialized — which
		// was F3's actual point.
		// Residual, accepted for now: dying between this setState and the queued
		// write loses the re-queue. The proper fix is a fine-grained mutex on
		// capExtRetryQueue instead of the coarse recorder chain that also
		// serializes multi-MiB uploads. Filed, deliberately not done here.
		const resumed = !!(
			state.uploadId &&
			state.parts &&
			state.parts.length > 0
		);
		void enqueueRecorder(() =>
			resumeInterruptedFinishing(
				state.videoId,
				state.uploadId,
				state.parts,
				state.durationInSecs,
				state.isMeeting,
			),
		).catch(() => {});
		const nextState: ExtensionState = {
			kind: "error",
			reason: resumed
				? "The browser restarted while finishing an upload — we're completing it in the background. You can start a new recording."
				: "The browser restarted while finishing an upload. Check your dashboard — the recording may have completed; otherwise please re-record.",
			recoverable: true,
			previousVideoId: state.videoId,
		};
		await setState(nextState);
		updateBadge(nextState);
	}

	await enqueueRecorder(() => retryPendingUploads());
});

// ── Install hook: hydrate badge from persisted state ──────────────────────

chrome.runtime.onInstalled.addListener(async () => {
	const state = await getState();
	updateBadge(state);
});

// ── Tab removed: recover from instruction recorder tab closure ─────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
	const state = await getState();
	if (state.kind === "arming" && state.mode === "instruction" && state.recorderTabId === tabId) {
		// Tab closed before recording started — release the arming lock.
		await setState({ kind: "idle" });
		updateBadge({ kind: "idle" });
	} else if (
		state.kind === "recording" &&
		state.mode === "instruction" &&
		state.recorderTabId === tabId
	) {
		// Tab closed mid-recording — finalize with whatever chunks arrived.
		await enqueueRecorder(() => finalizeRecording()).catch(() => {});
	}
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
	const state = await getState();
	if (
		state.kind === "arming" &&
		state.mode === "meeting" &&
		state.contentRecorderTabId === tabId
	) {
		await setState({ kind: "idle" });
		updateBadge({ kind: "idle" });
	} else if (
		state.kind === "recording" &&
		state.mode === "meeting" &&
		state.contentRecorderTabId === tabId
	) {
		await enqueueRecorder(() => finalizeRecording()).catch(() => {});
	}
});

// ── Guaranteed client audio: source (Meet) tab closed or navigated away ────
// Independent of the recorder-page's own tab-track watchdog — belt-and-
// suspenders in case that page-side detection is slow or missed.

chrome.tabs.onRemoved.addListener((tabId) => {
	handleSourceTabLost(tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.url === undefined || isMeetUrl(changeInfo.url)) return;
	handleSourceTabLost(tabId).catch(() => {});
});

// ── In-page recorder: the Meet tab RELOADED mid-recording ──────────────────
//
// The in-page path's MediaRecorder lives in the Meet page itself, so a reload
// (F5 — common when Meet glitches) destroys it. Nothing else catches this:
// `beforeunload` calls recorder.stop() but a dying document never runs the
// resulting ondataavailable/onstop, so RECORDER_STOPPED is never sent;
// tabs.onRemoved does not fire for a reload; and the onUpdated watcher above
// only reacts to a URL CHANGE, which a reload is not. The state used to sit at
// "recording" forever: badge REC, keepalive running, the reloaded page showing
// a fresh "Record this meeting?" nudge whose click is refused with "a recording
// is already in progress", and everything after the reload unrecorded.
// Finalize instead — the first half is uploaded and the owner can start again.
//
// ⚠️ `status:"loading"` is NOT proof of a reload. Chromium fires it for
// SAME-DOCUMENT history navigations too, and Google Meet pushes a history entry
// for its in-call dialogs (that is why the back button closes "Add people").
// Opening Add people therefore killed a live recording — observed by the owner
// 2026-07-28 on a real call, twice: once seconds in (the upload then failed with
// "Recording was too short", 1200 durable bytes = an mp4 header and nothing
// else) and once a minute in (saved, but the recording stopped). So the signal
// must be CONFIRMED before acting: ask the tab whether its in-page recorder is
// still running. A real reload destroys that document, so nothing answers (or
// the freshly-injected content script answers "not recording"); a dialog leaves
// it recording. The recheck delay exists because the OLD document can still be
// alive for a moment after "loading" fires — by then a real reload is gone.
// An independent review (2026-07-28) falsified a one-shot probe in both
// directions, so the probe is polled and its THREE outcomes are kept apart:
//   • "gone"      — sendMessage rejected (no receiving end: the document is
//                   destroyed) or a freshly-injected content script answered
//                   `recording:false`. This is the only real proof of a reload.
//   • "recording" — the document answered: still recording. A dialog.
//   • "unknown"   — no answer in time. A Meet call renders on a busy main
//                   thread, so a slow reply must NEVER be read as "gone" — that
//                   would kill a live recording under exactly the load the
//                   original bug happens under.
// A slow reload can still answer "recording" from the OLD document for a moment
// after "loading" fires, so one "recording" answer is not proof either: poll
// until something is definite. Only an all-inconclusive run keeps the recording
// — stranding is recoverable by pressing Stop; a killed meeting is not.
const RELOAD_PROBE_TIMEOUT_MS = 1500;
const RELOAD_PROBE_INTERVAL_MS = 2500;
const RELOAD_PROBE_ATTEMPTS = 4;

async function probeInPageRecorder(
	tabId: number,
): Promise<"recording" | "gone" | "unknown"> {
	try {
		const reply = await Promise.race([
			chrome.tabs.sendMessage(tabId, { type: "IS_INPAGE_RECORDING" }),
			new Promise((resolve) =>
				setTimeout(() => resolve("__timeout__"), RELOAD_PROBE_TIMEOUT_MS),
			),
		]);
		if (reply === "__timeout__" || reply === undefined) return "unknown";
		return (reply as { recording?: boolean }).recording === true
			? "recording"
			: "gone";
	} catch {
		return "gone";
	}
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status !== "loading") return;
	void (async () => {
		const state = await getState();
		if (
			state.kind === "recording" &&
			state.contentRecorderTabId === tabId
		) {
			let verdict: "recording" | "gone" | "unknown" = "unknown";
			for (let attempt = 0; attempt < RELOAD_PROBE_ATTEMPTS; attempt++) {
				await new Promise((resolve) =>
					setTimeout(resolve, RELOAD_PROBE_INTERVAL_MS),
				);
				// A normal Stop while we poll ends this: nothing to decide any more.
				const now = await getState();
				if (
					now.kind !== "recording" ||
					now.contentRecorderTabId !== tabId
				) {
					return;
				}
				verdict = await probeInPageRecorder(tabId);
				if (verdict === "gone") break;
			}
			if (verdict !== "gone") {
				console.warn(
					`[sw] tab ${tabId} reported "loading" but its in-page recorder never proved gone (last probe: ${verdict}) — treating it as a same-document navigation (a Meet dialog). Recording kept.`,
				);
				return;
			}
			// Re-read: the recording may have been stopped normally while we polled.
			const stillLive = await getState();
			if (
				stillLive.kind !== "recording" ||
				stillLive.contentRecorderTabId !== tabId
			) {
				return;
			}
			intentionalStop = true;
			await enqueueRecorder(() => finalizeRecording()).catch(() => {});
			chrome.notifications.create("meet-tab-reloaded", {
				type: "basic",
				iconUrl: "icons/icon-128.png",
				title: "Recording saved",
				message:
					"The Meet page reloaded — what was recorded so far has been saved. Start again to keep recording.",
			});
		}
	})();
});

// Meeting-ended prompt: button 0 = stop & save, button 1 = keep recording.
chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
	if (notifId !== MEET_ENDED_PROMPT_ID) return;
	chrome.notifications.clear(MEET_ENDED_PROMPT_ID);
	if (btnIdx === 0) stopInstructionDeliberate().catch(() => {});
});

// Advisory only (Codex FIX B): this fires "stopped" on normal stops too, so it
// must never independently trigger the loss alert — the trustworthy signals
// are the recorder-page track events and the tabs.onRemoved/onUpdated
// listeners above. Kept only for diagnostics.
if (chrome.tabCapture?.onStatusChanged) {
	chrome.tabCapture.onStatusChanged.addListener((info) => {
		if (intentionalStop) return;
		if (info.status !== "stopped" && info.status !== "error") return;
		console.warn("[sw] tabCapture.onStatusChanged (advisory only):", info);
	});
}
