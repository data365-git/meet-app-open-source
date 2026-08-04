// ── Offscreen recorder ──────────────────────────────────────────────────────
//
// This document runs ONLY the Google Meet (tab-capture) recording path.
//
// Why offscreen + tabCapture (and NOT desktopCapture / getDisplayMedia here):
//   • The service worker calls chrome.tabCapture.getMediaStreamId({ targetTabId })
//     which returns a *serializable* streamId.
//   • That streamId is handed to THIS document, which calls getUserMedia with
//     chromeMediaSource: "tab". Tab streamIds ARE consumable inside an offscreen
//     document — unlike desktopCapture streamIds, which are blocked here.
//   • getDisplayMedia() is impossible in a programmatic offscreen document (no
//     user gesture / activation), so full-screen INSTRUCTION recording lives in
//     the visible recorder.html page instead — NOT here.
//
// The message protocol to the service worker (RECORDER_STARTED / RECORDER_CHUNK /
// RECORDER_STOPPED / RECORDER_ERROR) is shared with recorder.html so the upload
// pipeline in the SW is identical for both paths.

import {
	TAB_AUDIO_PROBLEM,
	isTabAudioLive,
	tabAudioStatus,
} from "../shared/client-audio";
import {
	AUDIO_BITS_PER_SECOND,
	TAB_AUDIO_GAIN,
	VIDEO_BITS_PER_SECOND,
	micAudioConstraints,
	pickMimeType,
} from "../shared/recording-quality";
import { newSessionId } from "../shared/recorder-session";

interface StartCaptureMsg {
	type: "START_CAPTURE";
	streamId: string;
	micEnabled?: boolean;
	micDeviceId?: string;
}

interface StopCaptureMsg {
	type: "STOP_CAPTURE";
}

interface PauseCaptureMsg {
	type: "PAUSE_CAPTURE";
}

interface ResumeCaptureMsg {
	type: "RESUME_CAPTURE";
}

type InboundMsg =
	| StartCaptureMsg
	| StopCaptureMsg
	| PauseCaptureMsg
	| ResumeCaptureMsg;

interface RecordingState {
	/** (F2) Identity of THIS capture session — see shared/recorder-session.ts. */
	sessionId: string;
	recorder: MediaRecorder;
	audioCtx: AudioContext;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	chunkIndex: number;
}

let state: RecordingState | null = null;
/** (F2d) True from the first line of startCapture until it settles. There is ONE
 * offscreen document, so two overlapping START_CAPTUREs would both acquire media
 * inside it and race to register — the losing attempt then strands or replaces
 * the winner's recording. `state` cannot express this: it stays null for the
 * whole media-acquisition window, which is exactly when the overlap happens. */
let startInFlight = false;

// getUserMedia does not resolve while Chrome's mic permission prompt is open —
// it waits for the human. This document is INVISIBLE (offscreen, no UI, no
// user activation), so a stuck prompt hangs startCapture() forever with
// nothing on screen to explain why. Same twin bug, same fix as
// content/inpage-recorder.ts (MIC_ACQUIRE_TIMEOUT_MS + withTimeout) — the mic
// is best-effort with a deadline; past it we record the tab without it. Does
// NOT apply to the tab-capture getUserMedia in startCapture() below: that
// consumes a pre-granted tabCapture streamId, which resolves immediately with
// no prompt.
const MIC_ACQUIRE_TIMEOUT_MS = 8000;

function withTimeout(
	p: Promise<MediaStream>,
	ms: number,
): Promise<MediaStream | null> {
	let settled = false;
	const guarded = p
		.then((stream) => {
			// The user clicked "Allow" AFTER we gave up. Nobody owns this stream, so
			// without stopping it the mic-in-use indicator stays lit for the rest of
			// the session — a recorder that looks like it is eavesdropping.
			if (settled) {
				for (const t of stream.getTracks()) t.stop();
				return null;
			}
			return stream;
		})
		.catch(() => null);
	return Promise.race([
		guarded,
		new Promise<null>((resolve) =>
			setTimeout(() => {
				settled = true;
				resolve(null);
			}, ms),
		),
	]);
}

// (H1) "Record Meet tab only" is a MEETING recording by construction — the popup
// only offers it on a Meet tab. Capturing that tab without its audio means the
// other participants are not recorded at all, which is the one outcome this
// product must never produce silently. Unlike the full-screen path
// (recorder.html) there is no UI here to warn in or ask with — an offscreen
// document is invisible and has no user activation — so the only honest outcome
// is to refuse and let the service worker surface the reason. The full-screen
// path remains available and CAN ask, so the user is never left with no way to
// record the meeting.
function noClientAudioError(problem: string): Error {
	return new Error(
		`Can't record this meeting: ${problem}, so the other participants wouldn't be recorded. Unmute the tab and try again, or use "Record full-screen meeting".`,
	);
}


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

function cleanup(s: RecordingState): void {
	for (const t of s.displayStream.getTracks()) t.stop();
	if (s.micStream) for (const t of s.micStream.getTracks()) t.stop();
	s.audioCtx.close().catch(() => {});
}

async function startCapture(msg: StartCaptureMsg): Promise<void> {
	if (startInFlight) {
		console.warn("[offscreen] START_CAPTURE ignored: a start is already running");
		return;
	}
	startInFlight = true;
	try {
	if (state) {
		cleanup(state);
		state = null;
	}
	// (F2) Minted BEFORE any await so every callback and message below belongs to
	// one identifiable session, even if a second startCapture arrives while this
	// one is still acquiring media (state is null throughout that window, so the
	// guard above cannot see the overlap).
	const mySessionId = newSessionId();
	// (F2b) This attempt's own hardware, tracked at function scope so a failure or
	// a lost race can always release it — even when the module `state` belongs to
	// another session and must not be touched.
	let ownDisplayStream: MediaStream | null = null;
	let ownMicStream: MediaStream | null = null;
	let ownAudioCtx: AudioContext | null = null;
	const releaseOwnMedia = (): void => {
		if (ownDisplayStream) for (const t of ownDisplayStream.getTracks()) t.stop();
		if (ownMicStream) for (const t of ownMicStream.getTracks()) t.stop();
		ownAudioCtx?.close().catch(() => {});
		ownDisplayStream = null;
		ownMicStream = null;
		ownAudioCtx = null;
	};

	try {
		if (!msg.streamId) throw new Error("streamId required for tab capture");

		// Tab capture: consume the streamId minted by tabCapture.getMediaStreamId
		// in the service worker. Audio + video share the same streamId.
		let displayStream: MediaStream;
		try {
			displayStream = await navigator.mediaDevices.getUserMedia({
				video: {
					mandatory: {
						chromeMediaSource: "tab",
						chromeMediaSourceId: msg.streamId,
					},
				} as unknown as MediaTrackConstraints,
				audio: {
					mandatory: {
						chromeMediaSource: "tab",
						chromeMediaSourceId: msg.streamId,
					},
				} as unknown as MediaTrackConstraints,
			});
		} catch (err) {
			// (H1) This used to silently retry VIDEO-ONLY and then report a
			// perfectly ordinary successful start — a meeting recorded with none of
			// the other participants' voices, presented to the user as a win.
			throw noClientAudioError(
				`${TAB_AUDIO_PROBLEM.missing} (${err instanceof Error ? err.message : String(err)})`,
			);
		}

		// (H1) LIVENESS GATE — the same decision the full-screen path makes before
		// recorder.start() (recorder-page.ts), via the ONE shared rule in
		// shared/client-audio.ts. Counting audio tracks is not enough: a Meet tab
		// the user already muted from Chrome's tab strip hands back a track that
		// EXISTS but is `muted`, and since no `mute` transition ever fires, the
		// watchdog wired below would never trip either.
		ownDisplayStream = displayStream;
		const startStatus = tabAudioStatus(displayStream.getAudioTracks()[0]);
		if (startStatus !== "live") {
			for (const t of displayStream.getTracks()) t.stop();
			throw noClientAudioError(TAB_AUDIO_PROBLEM[startStatus]);
		}

		let micStream: MediaStream | null = null;
		if (msg.micEnabled !== false) {
			// Use the specific device when one was chosen; otherwise capture the
			// system default mic so an enabled mic is never silently dropped.
			micStream = await withTimeout(
				navigator.mediaDevices.getUserMedia({
					audio: micAudioConstraints(msg.micDeviceId),
				}),
				MIC_ACQUIRE_TIMEOUT_MS,
			);
			if (!micStream) {
				micStream = await withTimeout(
					navigator.mediaDevices.getUserMedia({
						audio: micAudioConstraints(),
					}),
					MIC_ACQUIRE_TIMEOUT_MS,
				);
			}
		}

		ownMicStream = micStream;
		const audioCtx = new AudioContext({ sampleRate: 48000 });
		ownAudioCtx = audioCtx;
		const dest = audioCtx.createMediaStreamDestination();

		if (displayStream.getAudioTracks().length > 0) {
			const displaySrc = audioCtx.createMediaStreamSource(displayStream);
			// Same remote-voices-are-quieter lift as the full-screen path, on the
			// RECORDED copy only (see TAB_AUDIO_GAIN) — the monitor path below
			// stays at unity so the live call sounds unchanged. Kept in sync with
			// recorder-page.ts on purpose: these two are the twin capture paths.
			const tabGain = audioCtx.createGain();
			tabGain.gain.value = TAB_AUDIO_GAIN;
			displaySrc.connect(tabGain).connect(dest);
			// Tab capture mutes the tab for the user by default; route the captured
			// tab audio back to the speakers so the meeting is still audible.
			displaySrc.connect(audioCtx.destination);
		}

		if (micStream && micStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(micStream).connect(dest);
		}

		const recordStream = new MediaStream([
			...displayStream.getVideoTracks(),
			...dest.stream.getAudioTracks(),
		]);

		const mime = pickMimeType();
		const recorder = new MediaRecorder(recordStream, {
			mimeType: mime,
			videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
			audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
		});

		let chunkIndex = 0;
		let pendingChunks = 0;
		let stopRequested = false;

		// (F2) See shared/recorder-session.ts. These callbacks used to act on the
		// module-level `state` whatever it had become, so a late callback from an
		// OLD capture could tear down the CURRENT one and its chunks could be
		// appended to the current upload. Both are keyed off this session's id now.
		const isMine = () => state !== null && state.sessionId === mySessionId;
		/** Release THIS capture's hardware when it no longer owns the module state. */
		const retireOrphan = () => {
			try {
				if (recorder.state !== "inactive") recorder.stop();
			} catch {}
			for (const t of displayStream.getTracks()) t.stop();
			if (micStream) for (const t of micStream.getTracks()) t.stop();
			audioCtx.close().catch(() => {});
		};

		const finishStop = () => {
			if (!isMine()) {
				retireOrphan();
				return;
			}
			if (state) {
				cleanup(state);
				state = null;
			}
			sendMsg({ type: "RECORDER_STOPPED", sessionId: mySessionId });
		};

		recorder.ondataavailable = async (e) => {
			if (e.data.size <= 0) {
				if (stopRequested && pendingChunks === 0) finishStop();
				return;
			}
			pendingChunks++;
			try {
				const buffer = await e.data.arrayBuffer();
				// arrayBuffer() is async — the capture may have been replaced while it
				// resolved, which is precisely how a stale chunk reaches the SW.
				if (!isMine()) {
					retireOrphan();
					return;
				}
				const reply = (await sendMsgAwait({
					type: "RECORDER_CHUNK",
					chunk: Array.from(new Uint8Array(buffer)),
					index: chunkIndex++,
					mime: recorder.mimeType,
					ts: Date.now(),
					sessionId: mySessionId,
				})) as { reason?: string } | undefined;
				if (reply?.reason === "stale-session") retireOrphan();
			} finally {
				pendingChunks--;
				if (stopRequested && pendingChunks === 0) finishStop();
			}
		};

		recorder.onerror = () => {
			if (!isMine()) {
				retireOrphan();
				return;
			}
			sendMsg({
				type: "RECORDER_ERROR",
				error: "MediaRecorder error",
				sessionId: mySessionId,
			});
			if (state) {
				cleanup(state);
				state = null;
			}
		};

		recorder.onstop = () => {
			stopRequested = true;
			if (pendingChunks === 0) finishStop();
		};

		const videoTracks = displayStream.getVideoTracks();
		if (videoTracks.length > 0) {
			videoTracks[0].onended = () => {
				// (F2b) Only OUR capture ending may stop OUR recorder. Reading the
				// global state let a superseded attempt's dying track stop the
				// recording that replaced it.
				if (state && state.sessionId === mySessionId) {
					if (state.recorder.state !== "inactive") state.recorder.stop();
					return;
				}
				if (recorder.state !== "inactive") {
					try {
						recorder.stop();
					} catch {}
				}
				for (const t of displayStream.getTracks()) t.stop();
			};
		}

		state = {
			sessionId: mySessionId,
			recorder,
			audioCtx,
			displayStream,
			micStream,
			chunkIndex,
		};

		// (H1) MID-RECORDING WATCHDOG. Client-audio loss after start (typically the
		// user muting the Meet tab from Chrome's tab strip) was completely
		// invisible on this path. The user-facing DECISION is not re-implemented
		// here: the SW already owns it for the full-screen path
		// (TAB_AUDIO_DEGRADED / TAB_AUDIO_RECOVERED → notifyTabAudioDegraded,
		// including the intentionalStop gate), so this only emits the signal.
		//
		// Debounced 1.5s like the full-screen path: a merely SILENT participant
		// does not mute a tabCapture track, so this cannot false-trip on a quiet
		// meeting, but a momentary blip shouldn't nag either. Only "muted" is
		// wired: on a tab-only capture the audio and video come from the SAME tab,
		// so a genuine "ended" takes the video track with it and the existing
		// videoTracks[0].onended already stops and finalizes the recording — there
		// is no screen+mic remainder left to keep warning about.
		const tabAudioTrack = displayStream.getAudioTracks()[0];
		if (tabAudioTrack) {
			// A stale timer from a PREVIOUS capture must not speak for this one.
			const isThisRecording = () => state?.displayStream === displayStream;
			tabAudioTrack.onmute = () => {
				setTimeout(() => {
					// `recorder.state === "recording"` is load-bearing, not belt-and-
					// braces: a recording that is simply ENDING drops its tab audio as
					// a matter of course, and in the window between recorder.stop() and
					// the chunk drain the state object is still alive. Re-checking only
					// the track there fires a false "your Meet tab was muted" alarm on
					// a perfectly good recording.
					// "recording" was too narrow and diverged from the twin it was
					// written to match: a tab muted while PAUSED fires onmute once, the
					// recheck sees "paused" and suppresses, and nothing re-fires on
					// resume — so the rest of the meeting recorded with no client audio
					// and no warning. The recorder-page twin warns while paused
					// (handleTabAudioDegraded excludes only "inactive").
					// "!== inactive" keeps the false-alarm protection this guard exists
					// for — MediaRecorder.stop() flips to "inactive" immediately, which
					// is what the ending-window test relies on — while closing the pause
					// hole.
					if (
						isThisRecording() &&
						state?.recorder.state !== undefined &&
						state.recorder.state !== "inactive" &&
						!isTabAudioLive(tabAudioTrack)
					) {
						sendMsg({ type: "TAB_AUDIO_DEGRADED", cause: "muted" });
					}
				}, 1500);
			};
			tabAudioTrack.onunmute = () => {
				// Deliberately NOT gated on "recording" (unlike the warning): a stale
				// banner must still clear if the tab is unmuted while paused.
				if (
					isThisRecording() &&
					state?.recorder.state !== "inactive" &&
					isTabAudioLive(tabAudioTrack)
				) {
					sendMsg({ type: "TAB_AUDIO_RECOVERED" });
				}
			};
		}

		// Wait for the SW to initialize the upload (state → "recording") BEFORE
		// capturing. If we started immediately, the first tab-capture chunks
		// would arrive while the SW is still "arming" and be dropped → 0 bytes.
		const startResp = (await sendMsgAwait({
			type: "RECORDER_STARTED",
			mime,
			hasVideo: displayStream.getVideoTracks().length > 0,
			hasAudio: dest.stream.getAudioTracks().length > 0,
			// (F2) Registers THIS session as the owner of the upload.
			sessionId: mySessionId,
		})) as { ok?: boolean; error?: string } | undefined;

		if (!startResp?.ok) {
			// (F2c) A refusal that names a reason is not OUR failure to report: the
			// winner of a start race (or the live recording) must not be torn down by
			// an error message from the attempt that lost. Bow out quietly.
			const quiet =
				(startResp as { reason?: string } | undefined)?.reason ===
					"start-in-flight" ||
				(startResp as { reason?: string } | undefined)?.reason ===
					"stale-session";
			// (F2) Only tear down the module state if it is still OURS. Two
			// overlapping START_CAPTUREs are possible because `state` stays null
			// while media is being acquired, so the loser must never clean up the
			// winner's capture — that would orphan a recording the SW believes live.
			// (F2b) But this attempt's OWN hardware must be released either way —
			// skipping cleanup because the state belongs to someone else used to leak
			// our tracks and AudioContext, leaving the capture indicator lit.
			if (state && state.sessionId === mySessionId) {
				cleanup(state);
				state = null;
			} else {
				releaseOwnMedia();
			}
			if (!quiet) {
				sendMsg({
					type: "RECORDER_ERROR",
					error: startResp?.error ?? "Couldn't start the upload session.",
					sessionId: mySessionId,
				});
			} else {
				console.warn("[offscreen] start refused:", startResp?.error);
			}
			return;
		}

		recorder.start(200);
	} catch (err) {
		sendMsg({
			type: "RECORDER_ERROR",
			error: err instanceof Error ? err.message : String(err),
			sessionId: mySessionId,
		});
		if (state && state.sessionId === mySessionId) {
			cleanup(state);
			state = null;
		} else {
			releaseOwnMedia();
		}
	}
	} finally {
		startInFlight = false;
	}
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
	const msg = raw as InboundMsg;

	if (msg.type === "START_CAPTURE") {
		startCapture(msg).catch((err) => {
			// (F2b) Do NOT send an unstamped RECORDER_ERROR here: startCapture owns
			// the only session id in play and already reports its own failures with
			// it. An unstamped error from this wrapper could only ever be judged
			// without an owner, which is precisely what the identity work removes.
			console.error("[offscreen] startCapture failed:", err);
		});
		sendResponse({ ok: true });
		return;
	}

	if (msg.type === "STOP_CAPTURE") {
		if (!state) {
			sendResponse({ ok: true });
			return;
		}
		if (state.recorder.state !== "inactive") {
			state.recorder.stop();
		} else {
			const sessionId = state.sessionId;
			cleanup(state);
			state = null;
			sendMsg({ type: "RECORDER_STOPPED", sessionId });
		}
		sendResponse({ ok: true });
		return;
	}

	// (M) Ack ONLY when we actually acted. PAUSE_CAPTURE/RESUME_CAPTURE arrive by
	// broadcast, so an idle context used to answer "ok" for a pause that never
	// happened — sendControlWithRetry reported delivery and the SW persisted
	// "paused" over a recorder that kept recording. Same reasoning as the
	// conditional STOP_CAPTURE ack in recorder-page.ts: staying silent is the
	// honest signal, and Chrome only raises lastError when NO listener answers.
	if (msg.type === "PAUSE_CAPTURE") {
		if (state && state.recorder.state === "recording") {
			state.recorder.pause();
			sendResponse({ ok: true });
		}
		return;
	}

	if (msg.type === "RESUME_CAPTURE") {
		if (state && state.recorder.state === "paused") {
			state.recorder.resume();
			sendResponse({ ok: true });
		}
		return;
	}
});
