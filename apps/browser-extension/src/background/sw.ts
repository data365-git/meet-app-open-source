import { isKeepAliveAlarm, startKeepAlive, stopKeepAlive } from "./keepalive";
import type { ExtensionSettings, ExtensionState } from "./state";
import { getSettings, getState, setSettings, setState } from "./state";
import { DEFAULT_API_BASE_URL } from "../shared/config";
import {
	abortUpload,
	discardUpload,
	finalizeUpload,
	finishLocalDiscardTraces,
	handleChunk,
	hasPendingDiscard,
	initializeUpload,
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
): Promise<number> {
	const base = chrome.runtime.getURL("recorder.html");
	// The guarantee travels with the TAB from here on (see state.ts
	// ArmingState.meetingRequired comment) — only the guaranteed path gets the
	// params; a plain screen recording opens with none.
	const url =
		meeting === true && sourceTabId !== undefined
			? `${base}?source=${sourceTabId}&meeting=1`
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
async function sendControlWithRetry(
	send: () => Promise<unknown>,
	label: string,
	attempts = 4,
	delayMs = 150,
): Promise<boolean> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			await send();
			return true;
		} catch (err) {
			if (attempt === attempts) {
				console.warn(
					`[sw] control send failed after ${attempts} attempts: ${label}`,
					err,
				);
				return false;
			}
			await new Promise((r) => setTimeout(r, delayMs));
		}
	}
	return false;
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
		title: "Yig'ilish tugadi",
		message:
			"Google Meet qo'ng'irog'i tugadi. Yozuvni to'xtatasizmi, yoki ekran yozuvini davom ettirasizmi?",
		buttons: [{ title: "To'xtatish va saqlash" }, { title: "Davom ettirish" }],
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

/** Shared finalization logic called from RECORDER_STOPPED and the tabs.onRemoved handler. */
async function finalizeRecording(): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording") return;
	const videoId = state.videoId;
	const uploadId = state.uploadId;
	const parts = state.parts;
	const totalBytes = state.totalBytes;
	const uploadedBytes = state.uploadedBytes;

	const nextState: ExtensionState = {
		kind: "uploading",
		videoId,
		uploadId,
		parts,
		totalBytes,
		uploadedBytes,
	};
	await setState(nextState);
	stopKeepAlive();
	updateBadge(nextState);
	await closeOffscreenDocument().catch(() => {});
	await finalizeUpload();
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
			await setState({
				kind: "arming",
				mode: "instruction",
				sourceTabId,
				meetingRequired,
			});
			let recorderTabId: number;
			try {
				recorderTabId = await openInstructionRecorder(
					sourceTabId,
					meetingRequired,
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

		// ── Popup: cancel ─────────────────────────────────────────────────
		case "CANCEL": {
			// Deliberate disarm — see the STOP case for why this guards the
			// tab-audio-loss watchdog.
			intentionalStop = true;
			const cancelState = await getState();
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
			const meetingId = state.kind === "arming" ? state.meetingId : undefined;
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

			let videoId: string;
			let uploadId: string;
			try {
				const result = await initializeUpload(mode, meetingId);
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
			};
			await setState(nextState);
			// A new recording starts clean: no stop is "in flight" yet, and any
			// prior tab-audio-degraded notification no longer applies.
			intentionalStop = false;
			tabAudioDegradedNotified = false;
			startKeepAlive();
			updateBadge(nextState);
			return { ok: true };
		}

		// ── Offscreen: data chunk ─────────────────────────────────────────
		case "RECORDER_CHUNK": {
			const raw = msg.chunk as number[] | undefined;
			const index = getNumber(msg, "index") ?? 0;
			const mime = getString(msg, "mime") ?? "video/webm";
			if (raw && Array.isArray(raw) && raw.length > 0) {
				await enqueueRecorder(() =>
					handleChunk(new Uint8Array(raw).buffer, index, mime),
				);
			}
			return { ok: true };
		}

		// ── Offscreen: recorder stopped ───────────────────────────────────
		case "RECORDER_STOPPED": {
			await enqueueRecorder(() => finalizeRecording());
			return { ok: true };
		}

		// ── Offscreen: recorder error ─────────────────────────────────────
		case "RECORDER_ERROR": {
			const error = getString(msg, "error") ?? "Unknown recorder error";

			await enqueueRecorder(async () => {
				// (P1.1 / M2) Route the WHOLE handler through enqueueRecorder: this
				// mutates state and (via finalizeUpload) the retry queue, and
				// handleChunk's loop bails on kind !== "recording" mid-part-upload
				// — an un-serialized error write here could drop parts that were
				// still being uploaded.
				const stateBefore = await getState();
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
					// finalizeUpload already set a more specific reason (too short,
					// retry failed, ...) — keep it rather than overwriting.
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
		};
		await setState(nextState);
		updateBadge(nextState);
	}

	if (state.kind === "recording" || state.kind === "uploading") {
		startKeepAlive();
		// (P1.2 / M5) Widened past the "recording" branch: a persisted
		// "uploading" state (crash mid-finalize) needs this exactly as much —
		// finalizeUpload already accepts it. Without this, state parked at
		// "uploading" forever and isInProgress() refused every future
		// recording until the user found CANCEL.
		await enqueueRecorder(() => finalizeUpload());
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
			resumeInterruptedFinishing(state.videoId, state.uploadId, state.parts),
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
