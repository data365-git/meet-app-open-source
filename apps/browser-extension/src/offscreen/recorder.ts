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
	pickMimeType,
} from "../shared/recording-quality";

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
	recorder: MediaRecorder;
	audioCtx: AudioContext;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	chunkIndex: number;
}

let state: RecordingState | null = null;

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
	if (state) {
		cleanup(state);
		state = null;
	}

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
		const startStatus = tabAudioStatus(displayStream.getAudioTracks()[0]);
		if (startStatus !== "live") {
			for (const t of displayStream.getTracks()) t.stop();
			throw noClientAudioError(TAB_AUDIO_PROBLEM[startStatus]);
		}

		let micStream: MediaStream | null = null;
		if (msg.micEnabled !== false) {
			try {
				// Use the specific device when one was chosen; otherwise capture the
				// system default mic so an enabled mic is never silently dropped.
				micStream = await navigator.mediaDevices.getUserMedia({
					audio: msg.micDeviceId
						? { deviceId: { exact: msg.micDeviceId } }
						: true,
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
		}

		const audioCtx = new AudioContext({ sampleRate: 48000 });
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

		const finishStop = () => {
			if (state) {
				cleanup(state);
				state = null;
			}
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

		const videoTracks = displayStream.getVideoTracks();
		if (videoTracks.length > 0) {
			videoTracks[0].onended = () => {
				if (state && state.recorder.state !== "inactive") {
					state.recorder.stop();
				}
			};
		}

		state = { recorder, audioCtx, displayStream, micStream, chunkIndex };

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
		})) as { ok?: boolean; error?: string } | undefined;

		if (!startResp?.ok) {
			if (state) {
				cleanup(state);
				state = null;
			}
			sendMsg({
				type: "RECORDER_ERROR",
				error: startResp?.error ?? "Couldn't start the upload session.",
			});
			return;
		}

		recorder.start(200);
	} catch (err) {
		sendMsg({
			type: "RECORDER_ERROR",
			error: err instanceof Error ? err.message : String(err),
		});
		if (state) {
			cleanup(state);
			state = null;
		}
	}
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
	const msg = raw as InboundMsg;

	if (msg.type === "START_CAPTURE") {
		startCapture(msg).catch((err) => {
			sendMsg({
				type: "RECORDER_ERROR",
				error: err instanceof Error ? err.message : String(err),
			});
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
			cleanup(state);
			state = null;
			sendMsg({ type: "RECORDER_STOPPED" });
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
