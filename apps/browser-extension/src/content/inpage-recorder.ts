// ── In-page recording (TWO-STEP path) ──────────────────────────────────────
//
// Owner's target flow: click "Record now" inside the Meet page → Chrome's screen
// picker opens → done. Two actions. The shortcut path (Ctrl+Shift+9 → recorder
// tab → "Start" → picker) needs three, because that page's button exists only
// to supply the user activation getDisplayMedia() requires. An in-page click IS
// that activation, so the capture can start right here.
//
// The blocker was never the video, it was the AUDIO: an in-page gesture cannot
// grant `activeTab`, so chrome.tabCapture — the recorder page's source of the
// remote participants' voices — is unavailable on this path.
//
// MEASURED 2026-07-19 on a real call (see docs/plans/2026-07-20-two-step-inpage-
// recording-SPEC.md): HTMLMediaElement.captureStream() on Meet's own <audio>/
// <video> elements DOES deliver the remote voices, with no permission and no
// activeTab grant. Peak energy ≈20% over a 60 s window with someone speaking.
// That is what this module records with.
//
// It streams chunks to the service worker over the SAME RECORDER_* protocol the
// recorder page and the offscreen document use, so the upload pipeline is
// identical for all three. The SW already knows this path exists —
// MEET_NUDGE_CAPTURE_READY arms it with `contentRecorderTabId`, which is how
// STOP/PAUSE/RESUME/CANCEL get routed back to this tab.
//
// ADDITIVE: the shortcut path is untouched. If this fails on the owner's
// machine, Ctrl+Shift+9 still records correctly.

import {
	AUDIO_BITS_PER_SECOND,
	CAPTURE_MAX_FRAME_RATE,
	CAPTURE_MAX_HEIGHT,
	CAPTURE_MAX_WIDTH,
	TAB_AUDIO_CONSTRAINTS,
	TAB_AUDIO_GAIN,
	VIDEO_BITS_PER_SECOND,
	micAudioConstraints,
	pickMimeType,
} from "../shared/recording-quality";
import { newSessionId } from "../shared/recorder-session";

/** Everything this module needs from the nudge UI, so the recorder itself owns
 * no DOM and stays testable. */
export interface InPageRecorderHost {
	/** Show a line of text inside the nudge card. */
	note(text: string, isError: boolean): void;
	/** Ask the owner whether to record WITHOUT the other participants' voices.
	 * Resolves true = start anyway, false = abort. */
	confirmWithoutClientAudio(): Promise<boolean>;
	/** Capture is live — swap the card for the recording pill. */
	onRecordingStarted(): void;
	/** Start aborted — re-enable the button. */
	onFailed(): void;
}

export interface PageAudioTap {
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
	/** id of the audio track the source node was BUILT from. A
	 * MediaStreamAudioSourceNode is bound to that one track forever, so when Meet
	 * swaps the element's source the node keeps reading a dead track — the tap is
	 * silent while everything still LOOKS connected. Comparing this id against the
	 * stream's current live track is the only way to notice. */
	trackId: string;
}

export interface InPageState {
	/** (F2) Identity of THIS recorder session, minted at start and echoed on every
	 * message to the SW. A content script outlives a recording (the Meet page is
	 * not reloaded between them), so without it the SW cannot tell a chunk from
	 * the previous session apart from a live one — that is what interleaved two
	 * fMP4 streams into one unplayable file on 2026-07-23. */
	sessionId: string;
	recorder: MediaRecorder;
	audioCtx: AudioContext;
	dest: MediaStreamAudioDestinationNode;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	pageGain: GainNode;
	/** Present only when the recording started with NO page audio and the picker
	 * gave us system audio as a stand-in. Muted the moment a real page tap
	 * attaches — see attachPageAudio. */
	systemGain: GainNode | null;
	analyser: AnalyserNode | null;
	taps: Map<HTMLMediaElement, PageAudioTap>;
	rescan: MutationObserver | null;
	watchdog: ReturnType<typeof setInterval> | null;
	host: InPageRecorderHost;
}

let state: InPageState | null = null;
/** (F2d) See offscreen/recorder.ts — one start attempt per context. `state` is
 * null for the whole picker + media-acquisition window, so it cannot stop a
 * second "Record now" click from starting a parallel attempt in this same tab. */
let startInFlight = false;
let intentionalStop = false;
let clientAudioWaived = false;

const SURFACE_NOT_MONITOR_MSG =
	"Choose \"Entire Screen\" — picking a tab or window won't record the full " +
	"call. Please try again.";

const NO_CLIENT_AUDIO_MSG =
	"The other person's audio wasn't captured — recording cancelled. Try again with Ctrl+Shift+9.";

// This fires on SILENCE, which it cannot tell apart from "nobody else is in the
// call yet" — so it must not assert a failure. The old wording did, and the
// owner hit it while alone in a Meet (2026-07-28): it read as "the other
// person's voice is not being recorded", which for a team of non-engineers is
// worse than no warning at all — it teaches them to distrust recordings that
// are in fact fine. Counting participants from Meet's DOM was considered and
// rejected: the People badge showed "2" while he was alone, because his own
// screen share counts as a participant. So the message states what is actually
// observed (no sound for two minutes) and makes the action conditional.
export const SILENCE_WARN_MSG =
	"⚠️ No sound has come through the call for 2 minutes. If someone is speaking, open the Meet tab and check it isn't muted — if you are alone or nobody is talking, ignore this.";

// How long the mix may stay completely silent on the PAGE-AUDIO side before we
// warn. Deliberately long: a meeting is legitimately silent for minutes at a
// time, and the 2026-07-19 probe proved a short window produces a confident
// WRONG answer ("6 second is less do it 60"). This warns, never stops.
const SILENCE_WARN_MS = 120_000;
const WATCHDOG_TICK_MS = 1000;
// Peak amplitude below this counts as silence (analyser floor noise).
const ENERGY_FLOOR = 0.01;

export function isInPageRecording(): boolean {
	return state !== null && state.recorder.state !== "inactive";
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


function friendlyStartError(error: unknown): string {
	const raw = typeof error === "string" ? error.toLowerCase() : "";
	if (raw.includes("already")) return "A recording is already in progress.";
	if (raw.includes("not signed")) {
		return "Sign in with data365 first by clicking the icon.";
	}
	if (raw.includes("meet tab") || raw.includes("tab")) {
		return "Open this Meet tab and press \"Record now\" again.";
	}
	return "Couldn't start recording. Try again with Ctrl+Shift+9.";
}

// ── Page audio (the remote participants) ───────────────────────────────────

function captureFrom(el: HTMLMediaElement): MediaStream | null {
	const capturable = el as HTMLMediaElement & {
		captureStream?: () => MediaStream;
		mozCaptureStream?: () => MediaStream;
	};
	const grab = capturable.captureStream ?? capturable.mozCaptureStream;
	if (typeof grab !== "function") return null;
	try {
		const stream = grab.call(capturable);
		return stream.getAudioTracks().length > 0 ? stream : null;
	} catch {
		return null;
	}
}

/** Tap every <audio>/<video> in the page that isn't tapped yet and wire it into
 * the mix. Returns how many NEW taps were attached.
 *
 * Meet creates and destroys these elements as people join and leave, so this
 * runs once before the start AND on every DOM mutation while recording — a
 * participant who joins after the start would otherwise be silent in the file. */
export function attachPageAudio(s: InPageState): number {
	let added = 0;
	const media = document.querySelectorAll<HTMLMediaElement>("audio, video");
	for (const el of media) {
		if (!el.isConnected) continue;
		const stream = captureFrom(el);
		if (!stream) continue;
		const track = stream
			.getAudioTracks()
			.find((t) => t.readyState === "live");
		if (!track) continue;
		const existing = s.taps.get(el);
		// Already tapped AND still reading the track that is actually live → done.
		if (existing && existing.trackId === track.id) continue;
		if (existing) {
			// Same element, DIFFERENT track: Meet swapped the source. Rebuild the
			// node, because a MediaStreamAudioSourceNode never follows that swap.
			try {
				existing.source.disconnect();
			} catch {}
		}
		let source: MediaStreamAudioSourceNode;
		try {
			// Bind to a stream holding exactly the CURRENT live track. Passing the
			// element's own capture stream is what caused the drift: Chrome keeps
			// handing back the same MediaStream object across source changes, so the
			// node silently stayed on the retired track.
			source = s.audioCtx.createMediaStreamSource(new MediaStream([track]));
		} catch {
			continue;
		}
		// Into the gain node (recorded copy only). There is NO monitor path here:
		// unlike chrome.tabCapture, captureStream() does not mute the element, so
		// the user already hears the call normally. Routing it to
		// audioCtx.destination as the recorder page does would double it.
		source.connect(s.pageGain);
		if (s.analyser) source.connect(s.analyser);
		s.taps.set(el, { stream, source, trackId: track.id });
		added++;
	}
	// The picker's system audio was only ever a STAND-IN for a call that had no
	// page audio yet (the owner starts recording alone, before anyone joins). The
	// moment real page audio arrives, the same voices would be in the mix twice —
	// once tapped, once through the system loopback, offset by pipeline latency:
	// echo for the rest of the call. Mute the stand-in instead of stopping it, so
	// the graph stays simple and a later re-check can never resurrect it.
	if (added > 0 && s.systemGain) {
		s.systemGain.gain.value = 0;
		s.systemGain = null;
	}
	return added;
}

/** Forget taps whose ELEMENT is gone from the page (a participant left). Taps
 * whose track merely changed are repaired in place by attachPageAudio; this only
 * stops the map growing for the whole call. Returns how many were dropped. */
export function pruneDeadTaps(s: InPageState): number {
	let pruned = 0;
	for (const [el, tap] of s.taps) {
		if (el.isConnected) continue;
		try {
			tap.source.disconnect();
		} catch {}
		s.taps.delete(el);
		pruned++;
	}
	return pruned;
}

export function detachAllPageAudio(s: InPageState): void {
	for (const tap of s.taps.values()) {
		try {
			tap.source.disconnect();
		} catch {}
		// Do NOT stop() these tracks. On the srcObject path (real Meet) captureStream()
		// wraps the ELEMENT'S OWN live WebRTC track, so stop() terminally kills a track the
		// extension never owned — and any LATER recording on the same page then finds only
		// dead ("ended") tracks, shows "the other person's audio wasn't captured", and records without the remote
		// voices (the 2026-07-22 prod bug). Disconnecting our source node is all we must undo
		// here; cleanup() closes the whole AudioContext, releasing everything we actually own.
	}
	s.taps.clear();
}

/** Peak amplitude across the currently tapped page audio, 0..1. */
function pageAudioPeak(s: InPageState, buf: Float32Array): number {
	if (!s.analyser) return 0;
	s.analyser.getFloatTimeDomainData(buf);
	let peak = 0;
	for (const v of buf) {
		const a = Math.abs(v);
		if (a > peak) peak = a;
	}
	return peak;
}

// ── Teardown ───────────────────────────────────────────────────────────────

function cleanup(s: InPageState | null): void {
	if (!s) return;
	if (s.watchdog !== null) clearInterval(s.watchdog);
	s.rescan?.disconnect();
	detachAllPageAudio(s);
	for (const t of s.displayStream.getTracks()) t.stop();
	if (s.micStream) for (const t of s.micStream.getTracks()) t.stop();
	s.audioCtx.close().catch(() => {});
}

export function stopInPageRecording(): void {
	intentionalStop = true;
	if (state && state.recorder.state !== "inactive") {
		state.recorder.stop();
	} else if (state) {
		const sessionId = state.sessionId;
		cleanup(state);
		state = null;
		sendMsg({ type: "RECORDER_STOPPED", sessionId });
	}
}

export function pauseInPageRecording(): boolean {
	if (state && state.recorder.state === "recording") {
		state.recorder.pause();
		return true;
	}
	return false;
}

export function resumeInPageRecording(): boolean {
	if (state && state.recorder.state === "paused") {
		state.recorder.resume();
		return true;
	}
	return false;
}

// ── Start ──────────────────────────────────────────────────────────────────

// getUserMedia does not resolve while Chrome's mic permission prompt is open —
// it waits for the human. On the recorder page that is harmless (it is a page
// the user is looking at), but here the user is in a CALL and the only feedback
// is a button stuck on "Starting…". Measured by the in-page proof, which hung
// exactly there on a profile with no mic grant. A meeting recording must never be
// lost to a mic prompt, so the mic is best-effort with a deadline: past it we
// record screen + the other participants without it.
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

async function getOptionalMicStream(
	micEnabled: boolean,
	micDeviceId: string,
): Promise<MediaStream | null> {
	if (!micEnabled) return null;
	if (micDeviceId) {
		const exact = await withTimeout(
			navigator.mediaDevices.getUserMedia({
				audio: micAudioConstraints(micDeviceId),
			}),
			MIC_ACQUIRE_TIMEOUT_MS,
		);
		if (exact) return exact;
	}
	return withTimeout(
		navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() }),
		MIC_ACQUIRE_TIMEOUT_MS,
	);
}

/**
 * MUST be called synchronously from a real click handler — getDisplayMedia()
 * consumes the user activation, and any awaited work before it would lose it.
 */
export async function startInPageRecording(
	meetingId: string | null,
	host: InPageRecorderHost,
): Promise<void> {
	if (state || startInFlight) {
		host.note("A recording is already in progress.", true);
		host.onFailed();
		return;
	}
	startInFlight = true;
	try {
	// (F2b) Minted FIRST, before any await and before the first callback is wired,
	// so every callback belonging to THIS attempt can tell whether the module still
	// belongs to it. Wiring a callback that reads the global `state` is how an old
	// attempt ends up stopping the CURRENT recording.
	const mySessionId = newSessionId();
	// (F2b) Function-scope so the catch can close it even when the throw happened
	// before the session object existed.
	let openedAudioCtx: AudioContext | null = null;
	let openedMicStream: MediaStream | null = null;
	intentionalStop = false;
	clientAudioWaived = false;

	// STEP 2 of the two steps: the picker, straight off the click.
	let displayStream: MediaStream;
	try {
		displayStream = await navigator.mediaDevices.getDisplayMedia({
			video: {
				displaySurface: "monitor",
				width: { max: CAPTURE_MAX_WIDTH },
				height: { max: CAPTURE_MAX_HEIGHT },
				frameRate: { max: CAPTURE_MAX_FRAME_RATE },
			},
			// Never let the browser "clean up" the display audio: its AEC would
			// treat the other participant's voice (which IS the speaker output)
			// as echo and gate it out. See TAB_AUDIO_CONSTRAINTS.
			audio: { ...TAB_AUDIO_CONSTRAINTS },
			surfaceSwitching: "exclude",
			monitorTypeSurfaces: "include",
		} as unknown as DisplayMediaStreamOptions);
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		host.note(
			name === "NotAllowedError" || name === "AbortError"
				? "Screen sharing was cancelled. Click again to retry."
				: `Couldn't share the screen: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
		host.onFailed();
		return;
	}

	if (displayStream.getVideoTracks().length === 0) {
		for (const t of displayStream.getTracks()) t.stop();
		host.note("No video stream arrived. Please try again.", true);
		host.onFailed();
		return;
	}

	// SURFACE GATE — same rule as the recorder page: reject ONLY what is
	// affirmatively wrong ("browser"/"window") and allow monitor/unknown, because
	// a false refusal breaks 100% of meetings while a missed detection only
	// returns us to the previous behaviour.
	const surface = displayStream.getVideoTracks()[0]?.getSettings().displaySurface;
	if (surface === "browser" || surface === "window") {
		for (const t of displayStream.getTracks()) t.stop();
		host.note(SURFACE_NOT_MONITOR_MSG, true);
		host.onFailed();
		return;
	}

	// WIRE THE NATIVE "Stop sharing" BAR NOW, not after the awaits below. The
	// start path can sit for seconds (SW round-trip, up to 8s of mic acquisition,
	// an unbounded confirm modal); a user who hits Chrome's Stop-sharing bar
	// during that window ends the video track BEFORE any handler exists, and the
	// recording used to start anyway — audio-only, never auto-stopping, while the
	// user believed they had stopped it. The recorder page wires its equivalent
	// before its modal for the same reason.
	const videoTrack = displayStream.getVideoTracks()[0];
	videoTrack.onended = () => {
		// Only OUR recording may be stopped by OUR track ending. Without this an
		// attempt that was superseded stops whatever is recording now.
		if (state && state.sessionId === mySessionId) {
			stopInPageRecording();
			return;
		}
		// Not ours (or nothing live): release this attempt's own capture so the
		// screen-share indicator does not stay lit.
		for (const t of displayStream.getTracks()) t.stop();
	};

	let pending: InPageState | null = null;
	try {
		// Arm the SW: this is what makes the upload file under MEETINGS (mode
		// "meeting" + meetingId) and registers THIS tab as contentRecorderTabId so
		// STOP/PAUSE/RESUME/CANCEL are routed back here.
		const ready = (await sendMsgAwait({
			type: "MEET_NUDGE_CAPTURE_READY",
			meetingId: meetingId ?? "",
		})) as
			| { ok?: boolean; error?: string; micEnabled?: boolean; micDeviceId?: string }
			| undefined;

		if (!ready?.ok) {
			for (const t of displayStream.getTracks()) t.stop();
			host.note(friendlyStartError(ready?.error), true);
			host.onFailed();
			return;
		}

		const micStream: MediaStream | null = await getOptionalMicStream(
			ready.micEnabled !== false,
			ready.micDeviceId ?? "",
		);

		openedMicStream = micStream;
		const audioCtx = new AudioContext({ sampleRate: 48000 });
		openedAudioCtx = audioCtx;
		const dest = audioCtx.createMediaStreamDestination();
		const pageGain = audioCtx.createGain();
		// The remote voices arrive attenuated relative to the local mic — same
		// reason and same constant as the tabCapture path.
		pageGain.gain.value = TAB_AUDIO_GAIN;
		pageGain.connect(dest);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 2048;

		pending = {
			sessionId: mySessionId,
			recorder: undefined as unknown as MediaRecorder, // set below
			audioCtx,
			dest,
			displayStream,
			micStream,
			pageGain,
			systemGain: null,
			analyser,
			taps: new Map(),
			rescan: null,
			watchdog: null,
			host,
		};

		const tapped = attachPageAudio(pending);

		// Did the user share the picker's system (loopback) audio? On Windows that
		// carries everything the machine plays — including the remote voices from
		// Meet — so it is a valid stand-in when no live page tap exists yet.
		const hasSystemAudio = displayStream.getAudioTracks().length > 0;
		// Start with NO live page tap but system audio WILL carry the voices via the
		// stand-in wired below. Drives the honest note at the end.
		const usingSystemAudioForClient = tapped === 0 && hasSystemAudio;

		// CLIENT-AUDIO GATE. What is checked here is that a capturable audio pipe
		// EXISTS — not that sound is currently coming through it. A meeting is
		// legitimately silent at the moment you press record, and the 2026-07-19
		// probe proved that judging by a short energy window returns a confident
		// wrong answer. Energy is therefore the WATCHDOG's job (below), not the
		// gate's.
		if (tapped === 0) {
			// Only raise the alarming "record without the other voices?" question when
			// the voice is GENUINELY absent — no page tap AND no system audio. When
			// system audio was shared it already carries the remote voices (stand-in
			// below), so the confirm would be a false alarm — the exact 2026-07-22
			// complaint where a 2nd recording showed "the other person's audio wasn't captured" while the
			// voice was in fact being recorded.
			if (!hasSystemAudio) {
				const proceed = await host.confirmWithoutClientAudio();
				if (!proceed) {
					cleanup(pending);
					pending = null;
					sendMsg({ type: "MEET_NUDGE_CANCEL" });
					host.note(NO_CLIENT_AUDIO_MSG, true);
					host.onFailed();
					return;
				}
			}
			// User waived it, or system audio will carry the voice — either way the
			// silence watchdog must not treat the quiet page-tap side as a fault.
			clientAudioWaived = true;
		}

		if (micStream && micStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(micStream).connect(dest);
		}
		// System audio from the picker is the SAME meeting sound as the page audio
		// when both exist — mixing both doubles it into echo. So it is only a
		// STAND-IN for a call with no page audio yet, and it goes through its own
		// gain node that attachPageAudio() mutes the instant real page audio shows
		// up (the owner starts recording alone; the client joins a minute later).
		if (usingSystemAudioForClient) {
			const systemGain = audioCtx.createGain();
			systemGain.connect(dest);
			audioCtx.createMediaStreamSource(displayStream).connect(systemGain);
			pending.systemGain = systemGain;
		}

		await audioCtx.resume();

		// The share may have been stopped while the confirm modal or the mic
		// prompt was up (its onended fired into a still-null `state`). Recording a
		// dead track produces an audio-only file that never stops on its own.
		if (videoTrack.readyState !== "live") {
			cleanup(pending);
			pending = null;
			sendMsg({ type: "MEET_NUDGE_CANCEL" });
			host.note("Screen sharing stopped. Click again to retry.", true);
			host.onFailed();
			return;
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
		pending.recorder = recorder;

		let chunkIndex = 0;
		let pendingChunks = 0;
		let stopRequested = false;

		// (F2) EVERY callback below belongs to THIS session. They used to read the
		// module-level `state`, so a late callback from an OLD recorder ran
		// cleanup(state)/state = null against whatever recording was live BY THEN —
		// tearing down a healthy session. `mine` is captured once and compared
		// before anything shared is touched.
		const mine = pending;
		/** True while this session is still the one the module owns. */
		const isMine = () => state === mine;
		/** Release THIS session's hardware even though it no longer owns the module
		 * state — an orphan that is merely ignored keeps the screen-share/mic
		 * indicator lit and goes on encoding forever. */
		const retireOrphan = () => {
			try {
				if (mine.recorder.state !== "inactive") mine.recorder.stop();
			} catch {}
			cleanup(mine);
		};

		const finishStop = () => {
			if (!isMine()) {
				retireOrphan();
				return;
			}
			cleanup(state);
			state = null;
			sendMsg({ type: "RECORDER_STOPPED", sessionId: mySessionId });
		};

		recorder.ondataavailable = async (event) => {
			if (event.data.size <= 0) {
				if (stopRequested && pendingChunks === 0) finishStop();
				return;
			}
			pendingChunks++;
			try {
				const buffer = await event.data.arrayBuffer();
				// arrayBuffer() is async: the session may have been replaced while it
				// resolved, which is exactly how a stale chunk reaches the SW.
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
				// The SW is the authority on which session owns the upload. If it says
				// this one is stale, stop rather than keep emitting rejected chunks.
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
			cleanup(state);
			state = null;
		};

		recorder.onstop = () => {
			stopRequested = true;
			if (pendingChunks === 0) finishStop();
		};

		// Initialize the upload BEFORE any media data exists: the SW creates the
		// video + multipart session in its RECORDER_STARTED handler and only then
		// accepts chunks. Starting earlier drops the first chunks → totalBytes=0.
		const startResp = (await sendMsgAwait({
			type: "RECORDER_STARTED",
			mime,
			hasVideo: displayStream.getVideoTracks().length > 0,
			hasAudio: dest.stream.getAudioTracks().length > 0,
			// (F2) Registers THIS session as the owner of the upload the SW is about
			// to create; every later message must carry the same id.
			sessionId: mySessionId,
		})) as { ok?: boolean; error?: string } | undefined;

		if (!startResp?.ok) {
			// (F2c) No RECORDER_ERROR is sent on this path — it only notes to the
			// host — so a refused start here cannot tear down the winner.
			cleanup(pending);
			pending = null;
			host.note(
				`Couldn't start recording: ${startResp?.error ?? "upload session didn't open"}`,
				true,
			);
			host.onFailed();
			return;
		}

		state = pending;
		pending = null;

		// LATE JOINERS: Meet swaps its media elements as people come and go, so
		// keep tapping new ones for the whole recording.
		const rescan = new MutationObserver(() => {
			if (!state) return;
			attachPageAudio(state);
		});
		rescan.observe(document.body, { childList: true, subtree: true });
		state.rescan = rescan;

		// SILENCE WATCHDOG + TAP REPAIR. Warns (never stops) when no remote sound
		// has reached the mix for SILENCE_WARN_MS, and — more importantly — repairs
		// the taps every tick: Meet reuses its media elements and swaps their
		// srcObject, which kills a tap while leaving the element in place. Pruning
		// the dead ones and re-scanning UNCONDITIONALLY is what makes the recovery
		// real; gating the re-scan on "no taps left" never fired, because dead taps
		// were still counted.
		const buf = new Float32Array(analyser.fftSize);
		let lastEnergyAt = Date.now();
		let warned = false;
		state.watchdog = setInterval(() => {
			const s = state;
			if (!s || intentionalStop || s.recorder.state === "inactive") return;
			pruneDeadTaps(s);
			const attached = attachPageAudio(s);
			// Client audio arrived after a waived start — re-arm the guarantee so
			// the watchdog stops treating silence as expected.
			if (attached > 0 && clientAudioWaived) {
				clientAudioWaived = false;
				lastEnergyAt = Date.now();
			}
			const peak = pageAudioPeak(s, buf);
			if (peak > ENERGY_FLOOR) {
				lastEnergyAt = Date.now();
				if (warned) {
					warned = false;
					s.host.note("", false);
				}
				return;
			}
			if (!warned && !clientAudioWaived && Date.now() - lastEnergyAt > SILENCE_WARN_MS) {
				warned = true;
				s.host.note(SILENCE_WARN_MSG, true);
			}
		}, WATCHDOG_TICK_MS);

		recorder.start(200);
		host.onRecordingStarted();
		// The mic is deliberately best-effort with an 8s deadline, so a denied or
		// unanswered permission prompt can never hang the start. But it used to be
		// SILENT: the recording ran without the owner's OWN voice and reported an
		// ordinary success — a partial failure presented as a win, which is the one
		// thing this product must not do. Ranked below the remote-voice notes: those
		// concern the other participants, which matter more.
		const micWanted = ready?.micEnabled !== false;
		const micMissing = micWanted && !micStream;
		if (usingSystemAudioForClient) {
			// NOT a warning: the remote voices ARE being recorded, via system audio.
			host.note("The other person's audio is being recorded via system audio.", false);
		} else if (clientAudioWaived) {
			host.note(
				"⚠️ Recording without the other person's audio. Stop and re-record with 'Share system audio' enabled.",
				true,
			);
		} else if (micMissing) {
			host.note(
				"⚠️ Your microphone isn't being recorded — permission was denied or not answered. The other person's audio is still captured.",
				true,
			);
		}
	} catch (err) {
		// (F2b) Clean up ONLY this attempt. An earlier draft used `pending ?? state`,
		// which is exactly wrong: once this attempt had handed its object over (or
		// been superseded), `state` is the OTHER session — so the failing attempt
		// tore down the live recording and reported the error under ITS id, which
		// the SW then accepted as genuine. Review caught it; this is the fix.
		const mineNow =
			pending ?? (state && state.sessionId === mySessionId ? state : null);
		if (mineNow) {
			cleanup(mineNow);
			if (state === mineNow) state = null;
		} else {
			// Nothing was constructed yet — still release everything this attempt had
			// already opened. Stopping only the display stream left the mic live and
			// the AudioContext open when the throw happened between the two.
			for (const t of displayStream.getTracks()) t.stop();
			if (openedMicStream)
				for (const t of openedMicStream.getTracks()) t.stop();
			openedAudioCtx?.close().catch(() => {});
		}
		pending = null;
		sendMsg({
			type: "RECORDER_ERROR",
			error: err instanceof Error ? err.message : String(err),
			sessionId: mySessionId,
		});
		host.note(
			`Couldn't start recording: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
		host.onFailed();
	}
	} finally {
		startInFlight = false;
	}
}
