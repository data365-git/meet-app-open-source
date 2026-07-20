// ── In-page recording (TWO-STEP path) ──────────────────────────────────────
//
// Owner's target flow: click "Record now" inside the Meet page → Chrome's screen
// picker opens → done. Two actions. The shortcut path (Ctrl+Shift+9 → recorder
// tab → "Boshlash" → picker) needs three, because that page's button exists only
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
	TAB_AUDIO_GAIN,
	VIDEO_BITS_PER_SECOND,
} from "../shared/recording-quality";

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

interface PageAudioTap {
	stream: MediaStream;
	source: MediaStreamAudioSourceNode;
}

interface InPageState {
	recorder: MediaRecorder;
	audioCtx: AudioContext;
	dest: MediaStreamAudioDestinationNode;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	pageGain: GainNode;
	analyser: AnalyserNode | null;
	taps: Map<HTMLMediaElement, PageAudioTap>;
	rescan: MutationObserver | null;
	watchdog: ReturnType<typeof setInterval> | null;
	host: InPageRecorderHost;
}

let state: InPageState | null = null;
let intentionalStop = false;
let clientAudioWaived = false;

const SURFACE_NOT_MONITOR_MSG =
	"To'liq ekranni tanlang — \"Entire Screen\". Tab yoki oyna tanlansa, " +
	"suhbat to'liq yozilmaydi. Qaytadan urinib ko'ring.";

const NO_CLIENT_AUDIO_MSG =
	"Mijoz ovozi olinmadi — yozuv bekor qilindi. Ctrl+Shift+9 bilan urinib ko'ring.";

const SILENCE_WARN_MSG =
	"⚠️ Mijoz ovozi eshitilmayapti — Meet tabi ochiq va ovozi yoqilganini tekshiring.";

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

function friendlyStartError(error: unknown): string {
	const raw = typeof error === "string" ? error.toLowerCase() : "";
	if (raw.includes("already")) return "Yozuv allaqachon ketmoqda.";
	if (raw.includes("not signed")) {
		return "Avval data365 belgisini bosib hisobga ulaning.";
	}
	if (raw.includes("meet tab") || raw.includes("tab")) {
		return "Shu Meet tabini oching va Record now'ni qayta bosing.";
	}
	return "Yozuvni boshlab bo'lmadi. Ctrl+Shift+9 bilan urinib ko'ring.";
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
function attachPageAudio(s: InPageState): number {
	let added = 0;
	const media = document.querySelectorAll<HTMLMediaElement>("audio, video");
	for (const el of media) {
		if (s.taps.has(el)) continue;
		const stream = captureFrom(el);
		if (!stream) continue;
		let source: MediaStreamAudioSourceNode;
		try {
			source = s.audioCtx.createMediaStreamSource(stream);
		} catch {
			for (const t of stream.getTracks()) t.stop();
			continue;
		}
		// Into the gain node (recorded copy only). There is NO monitor path here:
		// unlike chrome.tabCapture, captureStream() does not mute the element, so
		// the user already hears the call normally. Routing it to
		// audioCtx.destination as the recorder page does would double it.
		source.connect(s.pageGain);
		if (s.analyser) source.connect(s.analyser);
		s.taps.set(el, { stream, source });
		added++;
	}
	return added;
}

function detachAllPageAudio(s: InPageState): void {
	for (const tap of s.taps.values()) {
		try {
			tap.source.disconnect();
		} catch {}
		for (const t of tap.stream.getTracks()) t.stop();
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
		cleanup(state);
		state = null;
		sendMsg({ type: "RECORDER_STOPPED" });
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
// is a button stuck on "Boshlanmoqda…". Measured by the in-page proof, which hung
// exactly there on a profile with no mic grant. A meeting recording must never be
// lost to a mic prompt, so the mic is best-effort with a deadline: past it we
// record screen + the other participants without it.
const MIC_ACQUIRE_TIMEOUT_MS = 8000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([
		p.catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
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
				audio: { deviceId: { exact: micDeviceId } },
			}),
			MIC_ACQUIRE_TIMEOUT_MS,
		);
		if (exact) return exact;
	}
	return withTimeout(
		navigator.mediaDevices.getUserMedia({ audio: true }),
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
	if (state) {
		host.note("Yozuv allaqachon ketmoqda.", true);
		host.onFailed();
		return;
	}
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
			audio: true,
			surfaceSwitching: "exclude",
			monitorTypeSurfaces: "include",
		} as unknown as DisplayMediaStreamOptions);
	} catch (err) {
		const name = err instanceof Error ? err.name : "";
		host.note(
			name === "NotAllowedError" || name === "AbortError"
				? "Ekran ulashish bekor qilindi. Qaytadan bosing."
				: `Ekranni ulab bo'lmadi: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
		host.onFailed();
		return;
	}

	if (displayStream.getVideoTracks().length === 0) {
		for (const t of displayStream.getTracks()) t.stop();
		host.note("Video oqimi kelmadi. Qaytadan urinib ko'ring.", true);
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

		const micStream = await getOptionalMicStream(
			ready.micEnabled !== false,
			ready.micDeviceId ?? "",
		);

		const audioCtx = new AudioContext({ sampleRate: 48000 });
		const dest = audioCtx.createMediaStreamDestination();
		const pageGain = audioCtx.createGain();
		// The remote voices arrive attenuated relative to the local mic — same
		// reason and same constant as the tabCapture path.
		pageGain.gain.value = TAB_AUDIO_GAIN;
		pageGain.connect(dest);
		const analyser = audioCtx.createAnalyser();
		analyser.fftSize = 2048;

		pending = {
			recorder: undefined as unknown as MediaRecorder, // set below
			audioCtx,
			dest,
			displayStream,
			micStream,
			pageGain,
			analyser,
			taps: new Map(),
			rescan: null,
			watchdog: null,
			host,
		};

		const tapped = attachPageAudio(pending);

		// CLIENT-AUDIO GATE. What is checked here is that a capturable audio pipe
		// EXISTS — not that sound is currently coming through it. A meeting is
		// legitimately silent at the moment you press record, and the 2026-07-19
		// probe proved that judging by a short energy window returns a confident
		// wrong answer. Energy is therefore the WATCHDOG's job (below), not the
		// gate's.
		if (tapped === 0) {
			const proceed = await host.confirmWithoutClientAudio();
			const videoTrack = displayStream.getVideoTracks()[0];
			if (!proceed || !videoTrack || videoTrack.readyState !== "live") {
				cleanup(pending);
				pending = null;
				sendMsg({ type: "INSTRUCTION_CANCEL" });
				host.note(NO_CLIENT_AUDIO_MSG, true);
				host.onFailed();
				return;
			}
			clientAudioWaived = true;
		}

		if (micStream && micStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(micStream).connect(dest);
		}
		// System audio from the picker is the SAME meeting sound as the page audio
		// when both exist — mixing both doubles it into echo. Page audio is the
		// reliable source here, so system audio is only used when we have none.
		if (tapped === 0 && displayStream.getAudioTracks().length > 0) {
			audioCtx.createMediaStreamSource(displayStream).connect(dest);
		}

		await audioCtx.resume();

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

		const finishStop = () => {
			cleanup(state);
			state = null;
			sendMsg({ type: "RECORDER_STOPPED" });
		};

		recorder.ondataavailable = async (event) => {
			if (event.data.size <= 0) {
				if (stopRequested && pendingChunks === 0) finishStop();
				return;
			}
			pendingChunks++;
			try {
				const buffer = await event.data.arrayBuffer();
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
			cleanup(state);
			state = null;
		};

		recorder.onstop = () => {
			stopRequested = true;
			if (pendingChunks === 0) finishStop();
		};

		// Chrome's native "Stop sharing" bar ends the video track — finalize the
		// upload instead of recording a dead stream.
		displayStream.getVideoTracks()[0].onended = () => {
			stopInPageRecording();
		};

		// Initialize the upload BEFORE any media data exists: the SW creates the
		// video + multipart session in its RECORDER_STARTED handler and only then
		// accepts chunks. Starting earlier drops the first chunks → totalBytes=0.
		const startResp = (await sendMsgAwait({
			type: "RECORDER_STARTED",
			mime,
			hasVideo: displayStream.getVideoTracks().length > 0,
			hasAudio: dest.stream.getAudioTracks().length > 0,
		})) as { ok?: boolean; error?: string } | undefined;

		if (!startResp?.ok) {
			cleanup(pending);
			pending = null;
			host.note(
				`Yozuvni boshlab bo'lmadi: ${startResp?.error ?? "yuklash sessiyasi ochilmadi"}`,
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

		// SILENCE WATCHDOG: warn (never stop) when no remote sound has reached the
		// mix for SILENCE_WARN_MS. Also re-scans, so a tab that lost every element
		// recovers on its own.
		const buf = new Float32Array(analyser.fftSize);
		let lastEnergyAt = Date.now();
		let warned = false;
		state.watchdog = setInterval(() => {
			const s = state;
			if (!s || intentionalStop || s.recorder.state === "inactive") return;
			if (s.taps.size === 0) attachPageAudio(s);
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
		if (clientAudioWaived) {
			host.note(
				"⚠️ Mijoz ovozisiz yozilmoqda — faqat ekran va mikrofon.",
				true,
			);
		}
	} catch (err) {
		cleanup(pending ?? state);
		pending = null;
		state = null;
		sendMsg({
			type: "RECORDER_ERROR",
			error: err instanceof Error ? err.message : String(err),
		});
		host.note(
			`Yozuvni boshlab bo'lmadi: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
		host.onFailed();
	}
}
