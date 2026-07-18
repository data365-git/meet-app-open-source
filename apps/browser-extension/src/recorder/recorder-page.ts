// ── Visible recorder page (INSTRUCTION path) ────────────────────────────────
//
// Full-screen instruction recording REQUIRES getDisplayMedia(), which can only
// run in a VISIBLE page with a real user gesture — it is impossible in a
// service worker or a programmatic offscreen document. So this dedicated
// extension tab owns the entire capture:
//
//   1. User clicks "Choose screen & start"  → real user gesture.
//   2. navigator.mediaDevices.getDisplayMedia(...) → MediaStream lives HERE.
//   3. MediaRecorder runs HERE; chunks are streamed to the service worker using
//      the SAME protocol the offscreen recorder uses (RECORDER_STARTED /
//      RECORDER_CHUNK / RECORDER_STOPPED / RECORDER_ERROR), so the SW upload
//      pipeline is identical for both paths.
//
// The MediaStream is NOT serializable, so it can never be created elsewhere and
// posted in — that is exactly why the capture must originate from this page.
// This tab must stay open for the duration of the recording.

interface RecorderSettings {
	micEnabled: boolean;
	micDeviceId: string;
}

// ── Guaranteed-audio params (travel with THIS TAB, not the volatile SW
// "arming" state) ────────────────────────────────────────────────────────
//
// The SW opens this tab with ?source=<tabId>&meeting=1 for the guaranteed
// path (background/sw.ts openInstructionRecorder). Parsed once here at load
// so an INSTRUCTION_CANCEL (picker cancel, error→RETRY, or another recorder
// tab's beforeunload) that wipes the SW's arming record can never downgrade
// THIS tab's own guarantee — REQUEST_TAB_AUDIO and RECORDER_STARTED send
// these values on every call instead of relying on SW state to remember them.
const _recorderUrlParams = new URLSearchParams(location.search);
const sourceTabIdParam = _recorderUrlParams.get("source");
const sourceTabId = sourceTabIdParam ? Number(sourceTabIdParam) : undefined;
const meetingRequiredParam = _recorderUrlParams.get("meeting") === "1";

interface RecordingState {
	recorder: MediaRecorder;
	audioCtx: AudioContext;
	dest: MediaStreamAudioDestinationNode;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	tabAudioStream: MediaStream | null;
}

let state: RecordingState | null = null;
let startedAt = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let lastShareUrl = "";
// Paused-time accounting (R3) — mirrors the popup's recordingElapsedMs
// approach (see popup.ts) so the on-screen timer excludes paused spans and
// matches the actual recorded media duration.
let pausedAt: number | null = null;
let pausedAccumMs = 0;

// ── Guaranteed client audio (meeting mode) ──────────────────────────────────
//
// `intentionalStop` is set true BEFORE any deliberate stop begins (Stop &
// upload button, SW-initiated STOP_CAPTURE, this tab closing) so the mid-
// recording watchdog below never mistakes an ordinary stop for a tab-audio
// loss. `clientAudioWaived` records the Item-1 "Boshla anyway" decision (at
// most one confirm per start — see resolveClientAudioGap). Both reset at the
// start of each new recording.
let intentionalStop = false;
let clientAudioWaived = false;

// ── Audio warning banner state machine ──────────────────────────────────────
//
// #rec-audio-warn has several potential writers (the mic-only fallback warning
// at recording start, Item 1's persistent "waived" warning, Item 2's rotating
// degraded-cause warnings) that must not clobber each other. `activeAudioWarn`
// holds every currently-active cause; the highest-priority one is rendered.
type AudioWarnCause = "ended" | "muted" | "suspended" | "waived" | "mic-only";

const AUDIO_WARN_TEXT: Record<AudioWarnCause, string> = {
	ended:
		"⚠️ Meet tab yopildi — qayta oching va extension'ni bosing, yoki yozuvni to'xtating.",
	muted: "⚠️ Mijoz ovozi o'chirilgan — Meet tab ovozini yoqing.",
	suspended: "⚠️ Mijoz ovozi vaqtincha uzildi — tiklanmoqda…",
	waived: "⚠️ Mijoz ovozi olinmayapti — faqat ekran va mikrofon yozilmoqda.",
	"mic-only":
		"⚠️ System audio is NOT shared — other people's voices won't be recorded (only your mic). Stop, start again, and tick “Also share system audio” in the picker.",
};

// Higher wins when more than one cause is simultaneously active.
const AUDIO_WARN_PRIORITY: Record<AudioWarnCause, number> = {
	ended: 5,
	muted: 4,
	suspended: 3,
	waived: 2,
	"mic-only": 1,
};

const activeAudioWarn = new Set<AudioWarnCause>();

function renderAudioWarn(): void {
	const warn = $("rec-audio-warn");
	if (!warn) return;
	let top: AudioWarnCause | null = null;
	for (const c of activeAudioWarn) {
		if (top === null || AUDIO_WARN_PRIORITY[c] > AUDIO_WARN_PRIORITY[top]) top = c;
	}
	if (top === null) {
		warn.classList.add("hidden");
		warn.textContent = "";
	} else {
		warn.textContent = AUDIO_WARN_TEXT[top];
		warn.classList.remove("hidden");
	}
}

function setAudioWarn(cause: AudioWarnCause, active: boolean): void {
	if (active) activeAudioWarn.add(cause);
	else activeAudioWarn.delete(cause);
	renderAudioWarn();
}

// ── Mid-recording tab-audio degradation (non-fatal, owner 2026-07-15) ──────
//
// Tab-audio loss no longer stops the recording. `degradedCauses` tracks which
// causes are CURRENTLY active (unlike the old one-shot flag) so a recovery
// (unmute / audioCtx resume) followed by a second loss re-warns. "ended" is
// unrecoverable and never clears — re-capturing tab audio after the source
// tab has closed is architecturally impossible here (no live invocation to
// re-arm from), so we don't pretend otherwise with a fake retry.
const degradedCauses = new Set<"muted" | "suspended" | "ended">();

function handleTabAudioDegraded(cause: "muted" | "suspended" | "ended"): void {
	if (intentionalStop || !state || state.recorder.state === "inactive") return;
	if (degradedCauses.has(cause)) return;
	degradedCauses.add(cause);
	setAudioWarn(cause, true);
	sendMsg({ type: "TAB_AUDIO_DEGRADED", cause });
}

function handleTabAudioRecovered(cause: "muted" | "suspended" | "ended"): void {
	if (intentionalStop || cause === "ended" || !degradedCauses.has(cause)) return;
	degradedCauses.delete(cause);
	setAudioWarn(cause, false);
	if (degradedCauses.size === 0) sendMsg({ type: "TAB_AUDIO_RECOVERED" });
}

/** audioCtx suspending mid-recording silences the whole mix (mic included),
 * not just the tab track — unlike a truly ended tab this is recoverable via
 * resume(). Race-guarded: a deliberate stop may land while we await. */
async function attemptAudioCtxResume(audioCtx: AudioContext): Promise<void> {
	try {
		await audioCtx.resume();
	} catch {
		// Banner stays up; the next onstatechange (or another watchdog tick)
		// will retry. Not a fatal condition.
		return;
	}
	if (intentionalStop || !state || state.recorder.state === "inactive") return;
	if (audioCtx.state === "running") handleTabAudioRecovered("suspended");
}

// ── View switching ──────────────────────────────────────────────────────────

const VIEWS = [
	"view-idle",
	"view-confirm",
	"view-recording",
	"view-uploading",
	"view-complete",
	"view-error",
] as const;
type ViewId = (typeof VIEWS)[number];

function showView(id: ViewId): void {
	for (const v of VIEWS) {
		const el = document.getElementById(v);
		if (el) el.classList.toggle("hidden", v !== id);
	}
}

function $(id: string): HTMLElement | null {
	return document.getElementById(id);
}

function setIdleMsg(text: string, isError: boolean): void {
	const el = $("idle-msg");
	if (!el) return;
	el.textContent = text;
	el.classList.toggle("msg-error", isError);
}

// ── SW messaging ────────────────────────────────────────────────────────────

function sendMsg(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function sendMsgAwait(msg: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(msg, (response: unknown) => {
			if (chrome.runtime.lastError) {
				resolve({ ok: false, error: chrome.runtime.lastError.message });
			} else {
				resolve(response);
			}
		});
	});
}

// ── Timer ───────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function elapsedMs(): number {
	return Math.max(0, Date.now() - startedAt - pausedAccumMs);
}

function startTimer(): void {
	stopTimer();
	startedAt = Date.now();
	pausedAt = null;
	pausedAccumMs = 0;
	const el = $("timer");
	if (el) el.textContent = "00:00";
	timerInterval = setInterval(() => {
		const t = $("timer");
		if (t) t.textContent = formatElapsed(elapsedMs());
	}, 1000);
}

function stopTimer(): void {
	if (timerInterval !== null) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
}

// Freeze the displayed timer at the moment pause begins (does not touch
// startedAt/pausedAccumMs — resumeTimer() below settles the accounting).
function pauseTimer(): void {
	if (pausedAt !== null) return;
	pausedAt = Date.now();
	stopTimer();
	const t = $("timer");
	if (t) t.textContent = formatElapsed(elapsedMs());
}

// Fold the just-finished paused span into pausedAccumMs so elapsedMs() (and
// therefore the displayed time) excludes it going forward, then restart the
// tick — same accounting concept as the popup's pausedAccumMs.
function resumeTimer(): void {
	if (pausedAt === null) return;
	pausedAccumMs += Date.now() - pausedAt;
	pausedAt = null;
	timerInterval = setInterval(() => {
		const t = $("timer");
		if (t) t.textContent = formatElapsed(elapsedMs());
	}, 1000);
}

// ── Recorder helpers ────────────────────────────────────────────────────────

function pickMimeType(): string {
	const candidates = [
		"video/mp4;codecs=h264",
		"video/mp4",
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
	];
	for (const mime of candidates) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return "video/webm";
}

function cleanup(s: RecordingState): void {
	for (const t of s.displayStream.getTracks()) t.stop();
	if (s.micStream) for (const t of s.micStream.getTracks()) t.stop();
	if (s.tabAudioStream) for (const t of s.tabAudioStream.getTracks()) t.stop();
	s.audioCtx.close().catch(() => {});
}

async function getSettings(): Promise<RecorderSettings> {
	const resp = (await sendMsgAwait({ type: "GET_ALL_SETTINGS" })) as
		| Record<string, unknown>
		| undefined;
	return {
		micEnabled: resp?.micEnabled !== false,
		micDeviceId: typeof resp?.micDeviceId === "string" ? resp.micDeviceId : "",
	};
}

// ── Fail-closed start (guaranteed client audio) ─────────────────────────────
//
// Meeting mode (meetingRequired) never starts client-less: if the source
// tab's audio can't be captured or isn't confirmed live, stop everything,
// release the SW arming lock, and show a clear error instead of recording.

const TAB_AUDIO_UNAVAILABLE_MSG =
	"Mijoz ovozini ulab bo'lmadi — Meet tabini yangilab, qaytadan boshlang.";

function failClosedStart(
	message: string,
	streams: {
		displayStream: MediaStream;
		micStream: MediaStream | null;
		tabAudioStream: MediaStream | null;
		audioCtx?: AudioContext;
	},
	startBtn: HTMLButtonElement | null,
): void {
	for (const t of streams.displayStream.getTracks()) t.stop();
	if (streams.micStream) for (const t of streams.micStream.getTracks()) t.stop();
	if (streams.tabAudioStream) {
		for (const t of streams.tabAudioStream.getTracks()) t.stop();
	}
	streams.audioCtx?.close().catch(() => {});
	sendMsg({ type: "INSTRUCTION_CANCEL" });
	const el = $("error-msg");
	if (el) el.textContent = message;
	showView("view-error");
	if (startBtn) startBtn.disabled = false;
}

// ── Confirm-instead-of-abort (guaranteed client audio, owner 2026-07-15) ────
//
// When the client (Meet tab) audio guarantee can't be met, ask the user
// instead of silently failing closed. The video track's `onended` (native
// "Stop sharing") is wired BEFORE the modal shows so a share-stop while the
// modal is open resolves as Bekor; `readyState` is re-checked after resolve
// too, closing the race where "Stop sharing" and the "Boshla" click land
// almost simultaneously.
function confirmProceedWithoutClientAudio(
	displayStream: MediaStream,
): Promise<boolean> {
	return new Promise((resolve) => {
		const videoTrack = displayStream.getVideoTracks()[0];
		let settled = false;
		const finish = (proceed: boolean) => {
			if (settled) return;
			settled = true;
			if (videoTrack) videoTrack.onended = null;
			resolve(proceed);
		};
		if (videoTrack) {
			videoTrack.onended = () => finish(false);
		}
		showView("view-confirm");
		$("btn-confirm-start")?.addEventListener("click", () => finish(true), {
			once: true,
		});
		$("btn-confirm-cancel")?.addEventListener("click", () => finish(false), {
			once: true,
		});
	});
}

/** Shared by both fail points (no tab audio at all, and the liveness gate).
 * Returns true when the caller should continue starting the recording
 * (the user chose Boshla and the display track is still live); false when
 * the caller must fail-closed and return (already handled here). */
async function resolveClientAudioGap(
	streams: {
		displayStream: MediaStream;
		micStream: MediaStream | null;
		tabAudioStream: MediaStream | null;
		audioCtx?: AudioContext;
	},
	startBtn: HTMLButtonElement | null,
): Promise<boolean> {
	const proceed = await confirmProceedWithoutClientAudio(streams.displayStream);
	const videoTrack = streams.displayStream.getVideoTracks()[0];
	if (!proceed || !videoTrack || videoTrack.readyState !== "live") {
		failClosedStart(TAB_AUDIO_UNAVAILABLE_MSG, streams, startBtn);
		return false;
	}
	clientAudioWaived = true;
	showView("view-idle");
	setAudioWarn("waived", true);
	return true;
}

// ── Start recording (called from a user gesture) ────────────────────────────

async function startRecording(): Promise<void> {
	setIdleMsg("", false);
	const startBtn = $("btn-start") as HTMLButtonElement | null;
	if (startBtn) startBtn.disabled = true;
	// A new recording starts clean.
	intentionalStop = false;
	clientAudioWaived = false;
	degradedCauses.clear();
	activeAudioWarn.clear();
	renderAudioWarn();

	const settings = await getSettings();

	let displayStream: MediaStream;
	try {
		displayStream = await navigator.mediaDevices.getDisplayMedia({
			video: {
				displaySurface: "monitor",
				width: { max: 1280 },
				height: { max: 720 },
				frameRate: { max: 24 },
			},
			audio: true,
			selfBrowserSurface: "exclude",
			surfaceSwitching: "exclude",
			monitorTypeSurfaces: "include",
		} as unknown as DisplayMediaStreamOptions);
	} catch (err) {
		// User cancelled the picker, or capture is blocked. NEVER silently
		// pretend success — surface a clear message and stay on the idle view.
		// Release the SW "arming" lock so future recordings aren't blocked.
		sendMsg({ type: "INSTRUCTION_CANCEL" });
		const name = err instanceof Error ? err.name : "";
		const friendly =
			name === "NotAllowedError"
				? "Screen sharing was cancelled. Click the button to try again."
				: `Couldn't start screen capture: ${err instanceof Error ? err.message : String(err)}`;
		setIdleMsg(friendly, true);
		if (startBtn) startBtn.disabled = false;
		return;
	}

	try {
		let micStream: MediaStream | null = null;
		if (settings.micEnabled && settings.micDeviceId) {
			try {
				micStream = await navigator.mediaDevices.getUserMedia({
					audio: { deviceId: { exact: settings.micDeviceId } },
				});
			} catch {
				try {
					micStream = await navigator.mediaDevices.getUserMedia({
						audio: true,
					});
				} catch {
					micStream = null;
				}
			}
		} else if (settings.micEnabled) {
			try {
				micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				micStream = null;
			}
		}

		// Pull the SOURCE TAB's audio (the other meeting participants) via a
		// tabCapture streamId minted by the SW — this captures the remote party
		// WITHOUT any "share system audio" tick. The SW mints the id with
		// consumerTabId = this tab, so it is consumable here; we mint→consume
		// back-to-back so the short-lived id never expires. In meeting-required
		// mode, any failure here fails the recording closed (below) instead of
		// silently falling back to screen + mic.
		let tabAudioStream: MediaStream | null = null;
		let meetingRequired = false;
		try {
			const resp = (await sendMsgAwait({
				type: "REQUEST_TAB_AUDIO",
				sourceTabId,
				meeting: meetingRequiredParam,
			})) as { streamId?: string | null; required?: boolean } | undefined;
			// Never let a TRANSPORT failure downgrade the guarantee. This page was
			// opened with ?meeting=1, so it already knows a meeting was requested;
			// deriving the decision only from the SW's echo means an ok:false reply
			// (service-worker wake-up hiccup, page orphaned by an extension update,
			// sender.url unset) silently reverts to the mic-only path - the exact
			// bug this whole change exists to kill, in a narrower hat.
			meetingRequired = meetingRequiredParam || resp?.required === true;
			const streamId = resp?.streamId;
			if (streamId) {
				try {
					tabAudioStream = await navigator.mediaDevices.getUserMedia({
						audio: {
							mandatory: {
								chromeMediaSource: "tab",
								chromeMediaSourceId: streamId,
							},
						} as unknown as MediaTrackConstraints,
						video: false,
					});
				} catch {
					tabAudioStream = null;
				}
			}
		} catch {
			tabAudioStream = null;
		}

		const haveTabAudio =
			!!tabAudioStream && tabAudioStream.getAudioTracks().length > 0;

		// CONFIRM, DON'T FAIL-CLOSED (owner 2026-07-15 reversal of Codex #2/#5):
		// streamId null, getUserMedia threw, or 0 audio tracks — a meeting-
		// required recording asks the user instead of silently aborting. Plain
		// mode falls back to screen + mic as before (no prompt).
		if (meetingRequired && !haveTabAudio) {
			const ok = await resolveClientAudioGap(
				{ displayStream, micStream, tabAudioStream },
				startBtn,
			);
			if (!ok) return;
		}

		const audioCtx = new AudioContext({ sampleRate: 48000 });
		const dest = audioCtx.createMediaStreamDestination();

		// System/display audio and tab audio are the SAME meeting sound when both
		// exist (the user also ticked "share system audio") — mixing both doubles
		// it into echo/clipping. Tab audio is the reliable source, so prefer it and
		// skip system audio whenever we have it.
		if (!haveTabAudio && displayStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(displayStream).connect(dest);
		}
		if (micStream && micStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(micStream).connect(dest);
		}
		if (haveTabAudio && tabAudioStream) {
			const tabSrc = audioCtx.createMediaStreamSource(tabAudioStream);
			tabSrc.connect(dest);
			// Also route the tab audio back to the speakers — tabCapture otherwise
			// mutes the source tab, so the meeting would go silent for the user.
			tabSrc.connect(audioCtx.destination);
		}

		// LIVENESS GATE (Codex #2): required before recorder.start(). A live
		// track only proves the browser hasn't closed the media object — NOT
		// that audio is truly flowing — so the mid-recording watchdog (wired
		// below, after the recorder starts) remains the ongoing guarantee.
		// Plain mode: advisory only, never blocks (no regression, Codex #5).
		await audioCtx.resume();
		// ONE decision per start (plan Item 1): skip this gate entirely once the
		// first branch above already waived client audio, so a second modal
		// never fires for the same start attempt.
		if (meetingRequired && !clientAudioWaived) {
			const tabTrack = tabAudioStream?.getAudioTracks()[0];
			const destTrack = dest.stream.getAudioTracks()[0];
			const liveOk =
				audioCtx.state === "running" &&
				!!tabTrack &&
				tabTrack.readyState === "live" &&
				!tabTrack.muted &&
				!!destTrack &&
				destTrack.readyState === "live";
			if (!liveOk) {
				const ok = await resolveClientAudioGap(
					{ displayStream, micStream, tabAudioStream, audioCtx },
					startBtn,
				);
				if (!ok) return;
			}
		}

		const recordStream = new MediaStream([
			...displayStream.getVideoTracks(),
			...dest.stream.getAudioTracks(),
		]);

		const mime = pickMimeType();
		const recorder = new MediaRecorder(recordStream, {
			mimeType: mime,
			videoBitsPerSecond: 600_000,
			audioBitsPerSecond: 96_000,
		});

		let chunkIndex = 0;
		let pendingChunks = 0;
		let stopRequested = false;

		const finishStop = () => {
			if (state) {
				cleanup(state);
				state = null;
			}
			stopTimer();
			sendMsg({ type: "RECORDER_STOPPED" });
		};

		recorder.ondataavailable = async (e) => {
			if (e.data.size <= 0) {
				if (stopRequested && pendingChunks === 0) finishStop();
				return;
			}
			pendingChunks++;
			try {
				const buffer = await e.data.arrayBuffer();
				sendMsg({
					type: "RECORDER_CHUNK",
					chunk: Array.from(new Uint8Array(buffer)),
					index: chunkIndex++,
					mime: recorder.mimeType,
					ts: Date.now(),
				});
			} finally {
				pendingChunks--;
				if (stopRequested && pendingChunks === 0) finishStop();
			}
		};

		recorder.onerror = () => {
			sendMsg({ type: "RECORDER_ERROR", error: "MediaRecorder error" });
			if (state) {
				cleanup(state);
				state = null;
			}
		};

		recorder.onstop = () => {
			stopRequested = true;
			if (pendingChunks === 0) finishStop();
		};

		// If the user clicks the browser's native "Stop sharing" control, the
		// video track ends — stop the recorder so the upload finalizes.
		const videoTracks = displayStream.getVideoTracks();
		if (videoTracks.length > 0) {
			videoTracks[0].onended = () => {
				if (state && state.recorder.state !== "inactive") {
					state.recorder.stop();
				}
			};
		}

		state = { recorder, audioCtx, dest, displayStream, micStream, tabAudioStream };

		// MID-RECORDING WATCHDOG (guaranteed client audio): belt-and-suspenders
		// signals that the client's tab audio has degraded. `onended` is
		// terminal (unrecoverable, act now); `onmute` is debounced 1.5s and
		// re-checked, since a normal SILENT client does NOT mute a tabCapture
		// track (so this won't false-trip on quiet participants) — only a real
		// Meet-side mute of the tab. `onunmute` clears the muted warning. None
		// of this stops the recording (owner 2026-07-15 reversal) — it only
		// warns + attempts recovery where possible. Tolerates tabAudioStream
		// being null (a waived start from Item 1 has no tab track to watch).
		if (meetingRequired) {
			const tabTrack = tabAudioStream?.getAudioTracks()[0];
			if (tabTrack) {
				tabTrack.onended = () => handleTabAudioDegraded("ended");
				tabTrack.onmute = () => {
					setTimeout(() => {
						if (tabTrack.muted) handleTabAudioDegraded("muted");
					}, 1500);
				};
				tabTrack.onunmute = () => handleTabAudioRecovered("muted");
			}
			audioCtx.onstatechange = () => {
				if (!state) return;
				if (audioCtx.state === "running") {
					handleTabAudioRecovered("suspended");
				} else {
					handleTabAudioDegraded("suspended");
					attemptAudioCtxResume(audioCtx);
				}
			};
		}

		// Initialize the upload BEFORE producing any media data. The SW creates
		// the video + multipart session in its RECORDER_STARTED handler and only
		// replies { ok: true } once it has set state to "recording". We MUST wait
		// for that ok before recorder.start(), otherwise the first chunks arrive
		// while the SW is still "arming" and get dropped → totalBytes=0 →
		// "No recording data was captured". (This was an intermittent failure:
		// it only struck when upload-init was slower than the first chunk.)
		const startResp = (await sendMsgAwait({
			type: "RECORDER_STARTED",
			mime,
			hasVideo: displayStream.getVideoTracks().length > 0,
			hasAudio: dest.stream.getAudioTracks().length > 0,
			sourceTabId,
			meeting: meetingRequiredParam,
		})) as { ok?: boolean; error?: string } | undefined;

		if (!startResp?.ok) {
			cleanup(state);
			state = null;
			const reason = startResp?.error ?? "Couldn't start the upload session.";
			setIdleMsg(`Couldn't start recording: ${reason}`, true);
			showView("view-idle");
			if (startBtn) startBtn.disabled = false;
			return;
		}

		// Upload session is ready and the SW is in "recording" — capture is now
		// safe; no chunk can be dropped for arriving "too early".
		recorder.start(200);

		showView("view-recording");
		// If the user didn't tick "share system audio" in the picker, the other
		// participants' voices are NOT captured (only mic) — surface it loudly so a
		// meeting is never silently recorded mic-only. Skipped when the stronger
		// "waived" warning (Item 1) is already showing for this same recording.
		if (!clientAudioWaived) {
			// Remote audio is captured if EITHER the source tab's audio came through
			// (tabCapture) OR the user shared system audio. Warn only when neither
			// did, so a meeting is never silently recorded mic-only.
			const hasRemoteAudio =
				displayStream.getAudioTracks().length > 0 ||
				(tabAudioStream?.getAudioTracks().length ?? 0) > 0;
			setAudioWarn("mic-only", !hasRemoteAudio);
		}
		startTimer();
	} catch (err) {
		if (state) {
			cleanup(state);
			state = null;
		}
		sendMsg({
			type: "RECORDER_ERROR",
			error: err instanceof Error ? err.message : String(err),
		});
		setIdleMsg(
			`Couldn't start recording: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
		showView("view-idle");
		if (startBtn) startBtn.disabled = false;
	}
}

function stopRecording(): void {
	// Deliberate stop — must not be mistaken for a tab-audio loss by the
	// watchdog above (Codex FIX B).
	intentionalStop = true;
	if (state && state.recorder.state !== "inactive") {
		state.recorder.stop();
	} else {
		stopTimer();
		sendMsg({ type: "RECORDER_STOPPED" });
	}
}

// ── State-change driven UI (uploading / complete / error) ───────────────────

interface BroadcastState {
	kind: string;
	shareUrl?: string;
	reason?: string;
	uploadedBytes?: number;
	totalBytes?: number;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function handleStateChange(s: BroadcastState): void {
	switch (s.kind) {
		case "uploading": {
			stopTimer();
			const pct =
				s.totalBytes && s.totalBytes > 0
					? Math.round(((s.uploadedBytes ?? 0) / s.totalBytes) * 100)
					: 0;
			const el = $("upload-progress");
			if (el) {
				el.textContent = `${formatBytes(s.uploadedBytes ?? 0)} uploaded (${pct}%)`;
			}
			showView("view-uploading");
			break;
		}
		case "finishing": {
			stopTimer();
			const el = $("upload-progress");
			if (el) el.textContent = "Finishing up…";
			showView("view-uploading");
			break;
		}
		case "complete": {
			stopTimer();
			lastShareUrl = s.shareUrl ?? "";
			const el = $("complete-url");
			if (el) el.textContent = lastShareUrl;
			showView("view-complete");
			break;
		}
		case "error": {
			stopTimer();
			if (state) {
				if (state.recorder.state !== "inactive") {
					try { state.recorder.stop(); } catch (_) {}
				}
				cleanup(state);
				state = null;
			}
			const el = $("error-msg");
			if (el) el.textContent = s.reason ?? "Unknown error";
			showView("view-error");
			break;
		}
		case "idle": {
			// SW reset (e.g. after dismiss). Only reset our UI if we're not
			// mid-capture in this tab.
			if (!state) {
				stopTimer();
				showView("view-idle");
				const startBtn = $("btn-start") as HTMLButtonElement | null;
				if (startBtn) startBtn.disabled = false;
				setIdleMsg("", false);
			}
			break;
		}
	}
}

// ── Wire up ─────────────────────────────────────────────────────────────────

function wire(): void {
	$("btn-start")?.addEventListener("click", () => {
		startRecording().catch((err) => {
			setIdleMsg(
				`Couldn't start: ${err instanceof Error ? err.message : String(err)}`,
				true,
			);
		});
	});

	$("btn-cancel")?.addEventListener("click", () => {
		window.close();
	});

	$("btn-stop")?.addEventListener("click", () => {
		const btn = $("btn-stop") as HTMLButtonElement | null;
		if (btn) {
			btn.disabled = true;
			btn.textContent = "Finishing…";
		}
		stopRecording();
	});

	$("btn-copy")?.addEventListener("click", () => {
		if (!lastShareUrl) return;
		navigator.clipboard.writeText(lastShareUrl).then(() => {
			const btn = $("btn-copy");
			if (btn) {
				btn.textContent = "Copied!";
				setTimeout(() => {
					btn.textContent = "Copy link";
				}, 2000);
			}
		});
	});

	$("btn-open")?.addEventListener("click", () => {
		if (lastShareUrl) chrome.tabs.create({ url: lastShareUrl });
	});

	$("btn-close")?.addEventListener("click", () => {
		sendMsg({ type: "CANCEL" });
		window.close();
	});

	$("btn-retry")?.addEventListener("click", () => {
		sendMsg({ type: "RETRY" });
		showView("view-idle");
		const startBtn = $("btn-start") as HTMLButtonElement | null;
		if (startBtn) startBtn.disabled = false;
		setIdleMsg("", false);
	});

	$("btn-close-err")?.addEventListener("click", () => {
		sendMsg({ type: "CANCEL" });
		window.close();
	});

	chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
		if (typeof message !== "object" || message === null) return;
		const msg = message as Record<string, unknown>;
		if (msg.type === "STATE_CHANGED") {
			const s = msg.state as BroadcastState;
			if (s) handleStateChange(s);
		} else if (msg.type === "STOP_CAPTURE") {
			stopRecording();
			sendResponse({ ok: true });
		} else if (msg.type === "PAUSE_CAPTURE") {
			if (state && state.recorder.state === "recording") {
				state.recorder.pause();
				pauseTimer();
			}
			sendResponse({ ok: true });
		} else if (msg.type === "RESUME_CAPTURE") {
			if (state && state.recorder.state === "paused") {
				state.recorder.resume();
				resumeTimer();
			}
			sendResponse({ ok: true });
		} else if (msg.type === "TAB_AUDIO_LOST_REMOTE") {
			// SW detected the loss independently (source tab closed/navigated
			// away) — this is always the unrecoverable "ended" cause. Route
			// through the same degraded-not-stopped handler as the local
			// watchdog, NOT stopRecording(), so it is never mistaken for an
			// intentional stop.
			handleTabAudioDegraded("ended");
			sendResponse({ ok: true });
		}
	});

	// If the user closes this tab mid-recording, stop cleanly so the SW can
	// finalize whatever was captured. If the tab is closed before recording
	// ever started, release the SW "arming" lock so it isn't stuck.
	window.addEventListener("beforeunload", () => {
		intentionalStop = true;
		if (state && state.recorder.state !== "inactive") {
			state.recorder.stop();
		} else if (!state) {
			sendMsg({ type: "INSTRUCTION_CANCEL" });
		}
	});
}

showView("view-idle");
wire();
