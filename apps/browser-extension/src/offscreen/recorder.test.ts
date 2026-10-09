import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTierFor } from "../shared/recording-quality";

// ── Fake-DOM harness for the offscreen tab-capture recorder ─────────────────
//
// offscreen/recorder.ts is a pure side-effect module: importing it registers a
// chrome.runtime.onMessage listener and nothing else is exported. These tests
// therefore stub the media globals it touches, import the REAL module once per
// test (fresh stubs + vi.resetModules), capture the listener, and drive it with
// the same START_CAPTURE message the service worker sends.
//
// What is under test is the product's core promise on the "Record Meet tab
// only" path: a meeting must never be recorded WITHOUT the other participants'
// audio and then reported as a success.

type TrackKind = "audio" | "video";

class FakeTrack {
	kind: TrackKind;
	readyState: "live" | "ended" = "live";
	muted = false;
	onended: (() => void) | null = null;
	onmute: (() => void) | null = null;
	onunmute: (() => void) | null = null;
	stopped = false;
	/** Every constraint set this track accepted, in order. */
	applied: MediaTrackConstraints[] = [];
	/** Make applyConstraints reject (OverconstrainedError) for matching steps. */
	refuse: ((c: MediaTrackConstraints) => boolean) | null = null;
	applyConstraints = vi.fn(async (c: MediaTrackConstraints) => {
		if (this.refuse?.(c)) throw new Error("OverconstrainedError");
		this.applied.push(c);
	});

	constructor(kind: TrackKind, init?: { muted?: boolean; ended?: boolean }) {
		this.kind = kind;
		if (init?.muted) this.muted = true;
		if (init?.ended) this.readyState = "ended";
	}

	stop(): void {
		this.stopped = true;
		this.readyState = "ended";
	}

	/** Drive a real tab-strip mute: the source stops delivering, the track stays. */
	mute(): void {
		this.muted = true;
		this.onmute?.();
	}

	unmute(): void {
		this.muted = false;
		this.onunmute?.();
	}
}

class FakeStream {
	private tracks: FakeTrack[];
	constructor(tracks: FakeTrack[] = []) {
		this.tracks = tracks;
	}
	getTracks(): FakeTrack[] {
		return this.tracks;
	}
	getAudioTracks(): FakeTrack[] {
		return this.tracks.filter((t) => t.kind === "audio");
	}
	getVideoTracks(): FakeTrack[] {
		return this.tracks.filter((t) => t.kind === "video");
	}
}

class FakeRecorder {
	static isTypeSupported(): boolean {
		return true;
	}
	state: "inactive" | "recording" | "paused" = "inactive";
	mimeType: string;
	ondataavailable:
		| ((e: {
				data: { size: number; arrayBuffer: () => Promise<ArrayBuffer> };
		  }) => void)
		| null = null;
	onerror: (() => void) | null = null;
	onstop: (() => void) | null = null;
	startCalls = 0;
	stopCalls = 0;

	constructor(_stream: unknown, opts: { mimeType: string }) {
		this.mimeType = opts.mimeType;
		FakeRecorder.last = this;
		FakeRecorder.constructed++;
	}
	static last: FakeRecorder | null = null;
	/** How many MediaRecorder objects have been built. A tier change must never
	 * increase this: a second encoder mid-upload interleaves two fMP4 streams. */
	static constructed = 0;

	start(): void {
		this.startCalls++;
		this.state = "recording";
	}
	stop(): void {
		this.stopCalls++;
		this.state = "inactive";
		this.onstop?.();
	}
	pause(): void {
		this.state = "paused";
	}
	resume(): void {
		this.state = "recording";
	}
}

class FakeAudioContext {
	state: "running" | "suspended" = "running";
	destination = {};
	private destStream = new FakeStream([new FakeTrack("audio")]);

	createMediaStreamDestination() {
		return { stream: this.destStream };
	}
	createMediaStreamSource() {
		// connect() returns the destination node so a chained
		// `src.connect(gain).connect(dest)` works, like the real Web Audio API.
		return { connect: (node?: unknown) => node };
	}
	/** The recorded copy of the tab audio is lifted through a GainNode
	 * (TAB_AUDIO_GAIN) because remote voices arrive quieter than the local mic. */
	createGain() {
		return { gain: { value: 1 }, connect: (node?: unknown) => node };
	}
	/** The recorded mix passes through a DynamicsCompressor limiter (see
	 * shared/recording-quality.ts createMixLimiter) before it reaches the
	 * MediaStream the MediaRecorder encodes. */
	createDynamicsCompressor() {
		return {
			threshold: { value: 0 },
			knee: { value: 0 },
			ratio: { value: 1 },
			attack: { value: 0 },
			release: { value: 0 },
			connect: (node?: unknown) => node,
		};
	}
	async close(): Promise<void> {}
	async resume(): Promise<void> {}
}

interface Harness {
	sent: Array<Record<string, unknown>>;
	listener: (
		msg: unknown,
		sender: unknown,
		sendResponse: (r: unknown) => void,
	) => void;
	displayTracks: { audio: FakeTrack | null; video: FakeTrack };
}

/**
 * @param audioInit  how the tab's audio track behaves, or "throw" to make the
 *                   audio+video getUserMedia reject (a tab exposing no audio),
 *                   or "none" to resolve WITHOUT an audio track.
 */
async function setup(
	audioInit: { muted?: boolean; ended?: boolean } | "throw" | "none" = {},
): Promise<Harness> {
	vi.resetModules();

	const sent: Array<Record<string, unknown>> = [];
	const captured: { fn?: Harness["listener"] } = {};

	const videoTrack = new FakeTrack("video");
	const audioTrack =
		audioInit === "throw" || audioInit === "none"
			? null
			: new FakeTrack("audio", audioInit);

	const chromeStub = {
		runtime: {
			lastError: undefined,
			sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
				sent.push(msg);
				if (cb) {
					// The SW replies ok:true to RECORDER_STARTED once the upload
					// session is armed.
					cb({ ok: true });
					return undefined;
				}
				return Promise.resolve(undefined);
			},
			onMessage: {
				addListener: (fn: Harness["listener"]) => {
					captured.fn = fn;
				},
			},
		},
	};

	const getUserMedia = vi.fn(
		async (constraints: { audio?: unknown; video?: unknown }) => {
			if (constraints.audio && constraints.video) {
				if (audioInit === "throw") {
					throw new Error("NotFoundError: tab has no audio");
				}
				if (audioInit === "none") return new FakeStream([videoTrack]);
				return new FakeStream([videoTrack, audioTrack as FakeTrack]);
			}
			// Video-only re-request (the old silent fallback) or the mic request.
			if (constraints.video) return new FakeStream([videoTrack]);
			return new FakeStream([new FakeTrack("audio")]);
		},
	);

	vi.stubGlobal("chrome", chromeStub);
	vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("MediaStream", FakeStream);
	FakeRecorder.last = null;
	FakeRecorder.constructed = 0;

	await import("./recorder");

	if (!captured.fn) throw new Error("offscreen recorder registered no listener");
	return {
		sent,
		listener: captured.fn,
		displayTracks: { audio: audioTrack, video: videoTrack },
	};
}

/** The session id THIS document minted for its live capture — every control
 * message from the SW is addressed to it. */
function sessionIdOf(h: Harness): string {
	const started = h.sent.find((m) => m.type === "RECORDER_STARTED");
	const id = started?.sessionId;
	if (typeof id !== "string") throw new Error("no session id: capture never started");
	return id;
}

/** Fire CAPTURE_TIER the way sendCaptureTier() in background/sw.ts does, and
 * return whatever this document answered (or "NO_RESPONSE" when it stayed
 * silent, which is itself the honest answer for a context that owns no capture). */
async function sendTier(
	h: Harness,
	tier: unknown,
	sessionId: string | undefined,
): Promise<unknown> {
	let responded: unknown = "NO_RESPONSE";
	h.listener({ type: "CAPTURE_TIER", sessionId, tier }, {}, (r) => {
		responded = r;
	});
	for (let i = 0; i < 10; i++) await Promise.resolve();
	return responded;
}

/** Fire START_CAPTURE and let the async startCapture chain settle. */
async function startCapture(h: Harness): Promise<void> {
	h.listener(
		{ type: "START_CAPTURE", streamId: "tab-stream-1", micEnabled: false },
		{},
		() => undefined,
	);
	// startCapture awaits getUserMedia + the RECORDER_STARTED round-trip.
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function errorsFrom(h: Harness): string[] {
	return h.sent
		.filter((m) => m.type === "RECORDER_ERROR")
		.map((m) => String(m.error));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('"Record Meet tab only" refuses to record a meeting without client audio', () => {
	// THE CASE THE LAST ATTEMPT MISSED. A Meet tab the user already muted from
	// Chrome's tab strip still hands back an audio TRACK — it is simply `muted`.
	// A guard that only counts tracks passes, the meeting records with none of
	// the other participants' voices, and no `mute` transition ever fires so the
	// watchdog never trips either. Nothing about this is visible to the user.
	it("refuses to start when the tab audio track exists but is MUTED", async () => {
		const h = await setup({ muted: true });
		await startCapture(h);

		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STARTED");
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(errorsFrom(h).join(" ")).toMatch(/muted/i);
	});

	it("refuses to start when the tab audio track has already ENDED", async () => {
		const h = await setup({ ended: true });
		await startCapture(h);

		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STARTED");
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(errorsFrom(h)).toHaveLength(1);
	});

	// The original defect: audio+video getUserMedia fails, the recorder silently
	// re-requests VIDEO ONLY and reports a completely ordinary success.
	it("refuses to start (never falls back to video-only) when tab audio capture fails", async () => {
		const h = await setup("throw");
		await startCapture(h);

		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STARTED");
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(errorsFrom(h)).toHaveLength(1);
	});

	it("refuses to start when the stream resolves with no audio track at all", async () => {
		const h = await setup("none");
		await startCapture(h);

		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STARTED");
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(errorsFrom(h)).toHaveLength(1);
	});

	it("starts normally when the tab audio is genuinely live", async () => {
		const h = await setup({});
		await startCapture(h);

		expect(h.sent.map((m) => m.type)).toContain("RECORDER_STARTED");
		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(errorsFrom(h)).toHaveLength(0);
	});
});

describe("mid-recording client-audio loss on the Meet-tab-only path", () => {
	it("warns when the Meet tab is muted while recording", async () => {
		const h = await setup({});
		await startCapture(h);
		// Fake timers only AFTER the start handshake — startCapture awaits a real
		// macrotask, which a frozen clock would never deliver.
		vi.useFakeTimers();
		expect(FakeRecorder.last?.state).toBe("recording");

		h.displayTracks.audio?.mute();
		await vi.advanceTimersByTimeAsync(2000);

		const degraded = h.sent.filter((m) => m.type === "TAB_AUDIO_DEGRADED");
		expect(degraded).toHaveLength(1);
		expect(degraded[0].cause).toBe("muted");

		h.displayTracks.audio?.unmute();
		await vi.advanceTimersByTimeAsync(10);
		expect(h.sent.filter((m) => m.type === "TAB_AUDIO_RECOVERED")).toHaveLength(
			1,
		);
	});

	// F5: the recheck used to be gated on `recorder.state === "recording"`. A
	// tab muted while the recording is PAUSED fires onmute ONCE (mute is an
	// edge, not a level), the 1.5s recheck then saw "paused" and suppressed the
	// warning, and nothing re-fires on resume — so the rest of the meeting kept
	// recording with no client audio and no warning ever shown. The recorder-page
	// twin (recorder-page.ts) already warns while paused, excluding only
	// "inactive" — this proves the offscreen path matches it.
	it("warns when the Meet tab is muted while the recording is PAUSED", async () => {
		const h = await setup({});
		await startCapture(h);
		vi.useFakeTimers();
		expect(FakeRecorder.last?.state).toBe("recording");

		h.listener({ type: "PAUSE_CAPTURE" }, {}, () => undefined);
		expect(FakeRecorder.last?.state).toBe("paused");

		h.displayTracks.audio?.mute();
		await vi.advanceTimersByTimeAsync(2000);

		const degraded = h.sent.filter((m) => m.type === "TAB_AUDIO_DEGRADED");
		expect(degraded).toHaveLength(1);
		expect(degraded[0].cause).toBe("muted");
	});

	// A recording that is simply ENDING drops its tab audio as a matter of
	// course. The dangerous window is between recorder.stop() and the chunk
	// drain: a chunk is still in flight, so the recording state object is very
	// much alive and every "is this still my recording?" check passes — only
	// `recorder.state` distinguishes "the tab was muted" from "we are stopping".
	// Debouncing on the track alone fires a false "your Meet tab was muted"
	// alarm on a perfectly good recording.
	it("does NOT warn when the tab audio drops between stop() and the chunk drain", async () => {
		const h = await setup({});
		await startCapture(h);
		const rec = FakeRecorder.last;
		if (!rec) throw new Error("no recorder");

		// Park one chunk mid-flight so the stop cannot finish draining: this is
		// what keeps the recording state alive across the stop.
		rec.ondataavailable?.({
			data: { size: 1024, arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) },
		});
		await Promise.resolve();

		vi.useFakeTimers();
		h.listener({ type: "STOP_CAPTURE" }, {}, () => undefined);
		expect(rec.state).toBe("inactive");

		h.displayTracks.audio?.mute();
		await vi.advanceTimersByTimeAsync(2000);

		expect(h.sent.filter((m) => m.type === "TAB_AUDIO_DEGRADED")).toHaveLength(
			0,
		);
		// Guard the guard: if the state object had already been torn down, this
		// test would pass for the wrong reason and prove nothing.
		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STOPPED");
	});
});

describe("control-message acks are honest", () => {
	// PAUSE_CAPTURE/RESUME_CAPTURE reach every extension context by broadcast.
	// An idle offscreen document answering "ok" told the service worker the
	// pause was delivered, so it persisted "Paused" over a recorder that was
	// still recording somewhere else.
	it("does not ack PAUSE_CAPTURE when there is nothing to pause", async () => {
		const h = await setup({});
		let responded: unknown = "NO_RESPONSE";
		h.listener({ type: "PAUSE_CAPTURE" }, {}, (r) => {
			responded = r;
		});
		expect(responded).toBe("NO_RESPONSE");
	});

	it("does not ack RESUME_CAPTURE when nothing is paused", async () => {
		const h = await setup({});
		await startCapture(h);
		let responded: unknown = "NO_RESPONSE";
		// Recording, not paused - a resume here is a no-op and must not ack.
		h.listener({ type: "RESUME_CAPTURE" }, {}, (r) => {
			responded = r;
		});
		expect(responded).toBe("NO_RESPONSE");
	});

	it("does not ack CAPTURE_TIER when this document owns no capture", async () => {
		// An idle offscreen document that answered "ok" would tell the SW the
		// capture had stepped down when nothing here stepped anywhere: the SW would
		// commit a tier the recording is NOT running at and tell the user about a
		// quality change that never happened.
		const h = await setup({});
		expect(await sendTier(h, captureTierFor("reduced"), "sess-anything")).toBe(
			"NO_RESPONSE",
		);
	});

	it("acks PAUSE_CAPTURE when it really paused the recorder", async () => {
		const h = await setup({});
		await startCapture(h);
		let responded: unknown = "NO_RESPONSE";
		h.listener({ type: "PAUSE_CAPTURE" }, {}, (r) => {
			responded = r;
		});
		expect(responded).toEqual({ ok: true });
		expect(FakeRecorder.last?.state).toBe("paused");
	});
});

// ── Adaptive capture tier on the "Record Meet tab only" path ────────────────
//
// The SW is willing to route CAPTURE_TIER to the offscreen document (it is the
// fallback route in sendCaptureTier), so this path MUST be able to apply it.
// While it could not, the ack gate correctly refused to commit — which means a
// meeting recorded here could never adapt to a slow link at all, and a 6-minute
// recording on an 800 kbit/s connection left the user waiting after Stop.
describe("CAPTURE_TIER on the offscreen tab-capture recorder", () => {
	it("applies the tier to the LIVE video track — frame rate first, then the height cap", async () => {
		const h = await setup({});
		await startCapture(h);
		const reduced = captureTierFor("reduced");

		const ack = await sendTier(h, reduced, sessionIdOf(h));

		expect(ack).toEqual({ ok: true, sessionId: sessionIdOf(h) });
		// It is the track the recorder is actually encoding, not a copy.
		expect(h.displayTracks.video.applied).toEqual([
			{ frameRate: { max: reduced.frameRate } },
			{
				frameRate: { max: reduced.frameRate },
				width: { max: reduced.maxWidth },
				height: { max: reduced.maxHeight },
			},
		]);
		expect(h.displayTracks.video.readyState).toBe("live");
	});

	it("never stops or recreates the MediaRecorder across tier changes", async () => {
		const h = await setup({});
		await startCapture(h);
		const before = FakeRecorder.last;
		if (!before) throw new Error("no recorder");
		const builtAtStart = FakeRecorder.constructed;
		const sessionId = sessionIdOf(h);

		await sendTier(h, captureTierFor("reduced"), sessionId);
		await sendTier(h, captureTierFor("minimal"), sessionId);
		await sendTier(h, captureTierFor("full"), sessionId); // and back up

		// Object identity — not "a recorder exists", but THE SAME ONE. A second
		// encoder mid-upload emits a fresh fMP4 init segment and interleaves two
		// byte streams into a file no player can open.
		expect(FakeRecorder.last).toBe(before);
		expect(FakeRecorder.constructed).toBe(builtAtStart);
		expect(before.stopCalls).toBe(0);
		expect(before.startCalls).toBe(1);
		expect(before.state).toBe("recording");
		// The capture itself is still alive and was re-constrained in place.
		expect(h.displayTracks.video.stopped).toBe(false);
		expect(h.displayTracks.video.applied).toHaveLength(6);
		// And the upload was never told anything happened.
		expect(h.sent.map((m) => m.type)).not.toContain("RECORDER_STOPPED");
	});

	it("never touches the audio tracks", async () => {
		// On this path the audio IS the meeting — the other participants' voices.
		const h = await setup({});
		await startCapture(h);
		const audio = h.displayTracks.audio;
		if (!audio) throw new Error("no tab audio track");

		await sendTier(h, captureTierFor("minimal"), sessionIdOf(h));

		expect(audio.applyConstraints).not.toHaveBeenCalled();
		expect(audio.applied).toEqual([]);
		expect(audio.stopped).toBe(false);
		expect(audio.readyState).toBe("live");
	});

	it("keeps the frame-rate step when the source refuses the resolution cap", async () => {
		const h = await setup({});
		await startCapture(h);
		h.displayTracks.video.refuse = (c) => "height" in c;
		const minimal = captureTierFor("minimal");

		const ack = await sendTier(h, minimal, sessionIdOf(h));

		// Still a truthful yes: output really was reduced by the frame-rate cap.
		expect(ack).toEqual({ ok: true, sessionId: sessionIdOf(h) });
		expect(h.displayTracks.video.applied).toEqual([
			{ frameRate: { max: minimal.frameRate } },
		]);
	});

	it("answers ok:false — never a false yes — when the source refuses everything", async () => {
		const h = await setup({});
		await startCapture(h);
		h.displayTracks.video.refuse = () => true;

		const ack = await sendTier(h, captureTierFor("minimal"), sessionIdOf(h));

		expect(ack).toEqual({ ok: false, sessionId: sessionIdOf(h) });
		expect(h.displayTracks.video.applied).toEqual([]);
		expect(FakeRecorder.last?.stopCalls).toBe(0);
	});

	it("refuses a tier addressed to a DIFFERENT recorder session", async () => {
		// A decision computed for a finished recording must never reconfigure the
		// capture that is live now.
		const h = await setup({});
		await startCapture(h);

		const ack = await sendTier(h, captureTierFor("minimal"), "sess-from-an-old-recording");

		expect(ack).toEqual({ ok: false, sessionId: "sess-from-an-old-recording" });
		expect(h.displayTracks.video.applied).toEqual([]);
	});

	it("refuses a message that names no tier we know, instead of restoring quality", async () => {
		const h = await setup({});
		await startCapture(h);

		expect(await sendTier(h, {}, sessionIdOf(h))).toEqual({
			ok: false,
			sessionId: sessionIdOf(h),
		});
		expect(await sendTier(h, { name: "ultra" }, sessionIdOf(h))).toEqual({
			ok: false,
			sessionId: sessionIdOf(h),
		});
		expect(h.displayTracks.video.applied).toEqual([]);
	});

	it("does nothing once the share has ended", async () => {
		const h = await setup({});
		await startCapture(h);
		h.displayTracks.video.readyState = "ended";

		const ack = await sendTier(h, captureTierFor("minimal"), sessionIdOf(h));

		expect(ack).toEqual({ ok: false, sessionId: sessionIdOf(h) });
		expect(h.displayTracks.video.applied).toEqual([]);
	});
});
