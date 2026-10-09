import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTierFor } from "../shared/recording-quality";

// ── Fake-DOM harness for the VISIBLE recorder page ──────────────────────────
//
// recorder/recorder-page.ts is a side-effect module: importing it runs
// showView("view-idle") + applyMeetingCopy() + wire() against `document`,
// `location`, `window` and `chrome`. vitest.config.ts sets environment "node"
// and jsdom is not a dependency of this package, so these tests stub a minimal
// DOM the same way offscreen/recorder.test.ts stubs the media globals, import
// the REAL module once per test (vi.resetModules), and drive it by firing the
// captured "btn-start" click handler.
//
// What is under test: `displaySurface: "monitor"` in the getDisplayMedia
// constraints is only a PICKER HINT. The user can still pick a Chrome tab or a
// single window, the promise resolves normally, and the meeting then records
// without the other participants' voices. In meeting mode that must not start.

type TrackKind = "audio" | "video";

class FakeTrack {
	kind: TrackKind;
	readyState: "live" | "ended" = "live";
	muted = false;
	onended: (() => void) | null = null;
	onmute: (() => void) | null = null;
	onunmute: (() => void) | null = null;
	stopped = false;
	private surface: string | undefined;
	/** Every constraint set this track accepted, in order. */
	applied: MediaTrackConstraints[] = [];
	/** Make applyConstraints reject (OverconstrainedError) for matching steps. */
	refuse: ((c: MediaTrackConstraints) => boolean) | null = null;
	applyConstraints = vi.fn(async (c: MediaTrackConstraints) => {
		if (this.refuse?.(c)) throw new Error("OverconstrainedError");
		this.applied.push(c);
	});

	constructor(
		kind: TrackKind,
		init?: { muted?: boolean; ended?: boolean; displaySurface?: string },
	) {
		this.kind = kind;
		if (init?.muted) this.muted = true;
		if (init?.ended) this.readyState = "ended";
		this.surface = init?.displaySurface;
	}

	/** Chrome populates displaySurface on the video track of a display capture. */
	getSettings(): { displaySurface?: string } {
		return this.surface === undefined ? {} : { displaySurface: this.surface };
	}

	stop(): void {
		this.stopped = true;
		this.readyState = "ended";
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
	ondataavailable: ((e: unknown) => void) | null = null;
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
	onstatechange: (() => void) | null = null;
	private destStream = new FakeStream([new FakeTrack("audio")]);

	createMediaStreamDestination() {
		return { stream: this.destStream };
	}
	createMediaStreamSource() {
		// connect() returns its argument so `src.connect(gain).connect(dest)`
		// chains like the real Web Audio API.
		return { connect: (node?: unknown) => node };
	}
	/** Tab audio is recorded through a GainNode (TAB_AUDIO_GAIN): the remote
	 * voices arrive quieter than the local mic. */
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

// ── Minimal DOM ─────────────────────────────────────────────────────────────

class FakeElement {
	id: string;
	textContent = "";
	disabled = false;
	private classes = new Set<string>();
	handlers = new Map<string, Array<() => void>>();

	constructor(id: string) {
		this.id = id;
	}

	classList = {
		add: (c: string) => {
			this.classes.add(c);
		},
		remove: (c: string) => {
			this.classes.delete(c);
		},
		contains: (c: string) => this.classes.has(c),
		toggle: (c: string, force?: boolean) => {
			const on = force === undefined ? !this.classes.has(c) : force;
			if (on) this.classes.add(c);
			else this.classes.delete(c);
			return on;
		},
	};

	addEventListener(type: string, fn: () => void): void {
		const list = this.handlers.get(type) ?? [];
		list.push(fn);
		this.handlers.set(type, list);
	}

	fire(type: string): void {
		for (const fn of this.handlers.get(type) ?? []) fn();
	}

	get hidden(): boolean {
		return this.classes.has("hidden");
	}
}

type PageListener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => void;

interface Harness {
	sent: Array<Record<string, unknown>>;
	el: (id: string) => FakeElement;
	displayStream: FakeStream;
	click: (id: string) => void;
	/** The chrome.runtime.onMessage listener this page registered — how the SW's
	 * STOP/PAUSE/RESUME/CAPTURE_TIER broadcasts actually reach it. */
	listener: () => PageListener;
}

interface SetupOpts {
	/** "" for the plain "Record screen" path, "?source=7&meeting=1" for meeting. */
	search: string;
	/** What the picker actually returned: "monitor" | "browser" | "window". */
	displaySurface?: string;
	/** Whether the source tab yields live audio (the other participants). */
	tabAudio?: "live" | "none";
	/** Whether the user ticked "Also share system audio". */
	systemAudio?: boolean;
	/** Whether the mic toggle is on (GET_ALL_SETTINGS.micEnabled). Defaults to
	 * false, matching every pre-existing test in this file. */
	micEnabled?: boolean;
	/** Make the MIC getUserMedia() call never resolve, like an unanswered
	 * Chrome permission prompt — everything else (tab audio, display media)
	 * still resolves normally. */
	micHang?: boolean;
}

async function setup(opts: SetupOpts): Promise<Harness> {
	vi.resetModules();

	const sent: Array<Record<string, unknown>> = [];
	const captured: { fn?: PageListener } = {};
	const elements = new Map<string, FakeElement>();
	const el = (id: string): FakeElement => {
		let e = elements.get(id);
		if (!e) {
			e = new FakeElement(id);
			elements.set(id, e);
		}
		return e;
	};

	const videoTrack = new FakeTrack("video", {
		displaySurface: opts.displaySurface,
	});
	const displayTracks: FakeTrack[] = [videoTrack];
	if (opts.systemAudio) displayTracks.push(new FakeTrack("audio"));
	const displayStream = new FakeStream(displayTracks);

	const chromeStub = {
		runtime: {
			lastError: undefined,
			sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
				sent.push(msg);
				if (!cb) return Promise.resolve(undefined);
				if (msg.type === "GET_ALL_SETTINGS")
					cb({ micEnabled: opts.micEnabled ?? false });
				else if (msg.type === "REQUEST_TAB_AUDIO") {
					cb(
						opts.tabAudio === "live"
							? { streamId: "tab-stream-1", required: true }
							: { streamId: null, required: opts.search.includes("meeting=1") },
					);
				} else cb({ ok: true });
				return undefined;
			},
			onMessage: {
				addListener: (fn: PageListener) => {
					captured.fn = fn;
				},
			},
		},
	};

	const getUserMedia = vi.fn((constraints?: { audio?: unknown }) => {
		// The tab-audio call (chromeMediaSource: "tab") consumes a pre-granted
		// streamId and never shows a permission prompt — only the plain mic
		// constraints ({ audio: true } / { audio: { deviceId } }) can hang on an
		// unanswered "Allow microphone?" dialog, so only THOSE are made to hang.
		const audioConstraint = constraints?.audio;
		const isTabAudio =
			typeof audioConstraint === "object" &&
			audioConstraint !== null &&
			"mandatory" in (audioConstraint as Record<string, unknown>);
		if (opts.micHang && !isTabAudio) {
			return new Promise<MediaStream>(() => {}); // the prompt just sits there
		}
		return Promise.resolve(new FakeStream([new FakeTrack("audio")]) as unknown as MediaStream);
	});
	const getDisplayMedia = vi.fn(async () => displayStream);

	vi.stubGlobal("chrome", chromeStub);
	vi.stubGlobal("document", {
		title: "",
		getElementById: (id: string) => el(id),
	});
	vi.stubGlobal("location", { search: opts.search });
	vi.stubGlobal("window", { addEventListener: () => undefined, close: () => undefined });
	vi.stubGlobal("navigator", { mediaDevices: { getUserMedia, getDisplayMedia } });
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("MediaStream", FakeStream);
	// The on-screen timer would otherwise leave a live 1s interval per test.
	vi.stubGlobal("setInterval", () => 0);
	vi.stubGlobal("clearInterval", () => undefined);
	FakeRecorder.last = null;
	FakeRecorder.constructed = 0;

	await import("./recorder-page");

	return {
		sent,
		el,
		displayStream,
		click: (id: string) => el(id).fire("click"),
		listener: () => {
			if (!captured.fn) throw new Error("recorder page registered no listener");
			return captured.fn;
		},
	};
}

/** The session id THIS page minted for its live recording — every control
 * message from the SW is addressed to it. */
function sessionIdOf(h: Harness): string {
	const started = h.sent.find((m) => m.type === "RECORDER_STARTED");
	const id = started?.sessionId;
	if (typeof id !== "string") throw new Error("no session id: recording never started");
	return id;
}

/** Fire CAPTURE_TIER the way sendCaptureTier() in background/sw.ts does, and
 * return whatever this page answered ("NO_RESPONSE" when it stayed silent —
 * itself the honest answer for a tab that owns no capture). */
async function sendTier(
	h: Harness,
	tier: unknown,
	sessionId: string | undefined,
): Promise<unknown> {
	let responded: unknown = "NO_RESPONSE";
	h.listener()({ type: "CAPTURE_TIER", sessionId, tier }, {}, (r) => {
		responded = r;
	});
	for (let i = 0; i < 10; i++) await Promise.resolve();
	return responded;
}

/** Let the whole async startRecording chain settle. */
async function drain(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
}

function types(h: Harness): string[] {
	return h.sent.map((m) => String(m.type));
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("meeting mode validates the surface the user actually picked", () => {
	// THE DEFECT. `displaySurface: "monitor"` in the video constraints only
	// pre-selects the "Entire Screen" pane of Chrome's picker — the user is free
	// to switch to "Chrome Tab", and getDisplayMedia resolves perfectly happily.
	// Nothing downstream ever re-read the resolved track, so a meeting recorded
	// from a single tab (no other participants' voices) reported plain success.
	it("refuses to start a meeting recording when the user picked a TAB", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "browser",
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		// Nothing recorded, and the SW was never told a recording began.
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(types(h)).not.toContain("RECORDER_STARTED");
		// The SW arming lock is released so the next attempt is possible.
		expect(types(h)).toContain("INSTRUCTION_CANCEL");
		// No leaked capture.
		for (const t of h.displayStream.getTracks()) expect(t.stopped).toBe(true);
		// The owner's copy, on the idle view, with the button live again — a
		// re-ask, not a dead end.
		expect(h.el("idle-msg").textContent).toMatch(/Choose "Entire Screen"/);
		expect(h.el("btn-start").disabled).toBe(false);
		expect(h.el("view-idle").hidden).toBe(false);
		expect(h.el("view-error").hidden).toBe(true);
	});

	it("refuses to start a meeting recording when the user picked a WINDOW", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "window",
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(types(h)).not.toContain("RECORDER_STARTED");
		expect(types(h)).toContain("INSTRUCTION_CANCEL");
		expect(h.el("idle-msg").textContent).toMatch(/Choose "Entire Screen"/);
	});

	// GUARD THE GUARD. Without this, a broken harness in which recording never
	// starts at all would make every "must not start" assertion above pass
	// vacuously and prove nothing.
	it("starts normally when the user really picked the entire screen", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "monitor",
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
		expect(h.el("view-recording").hidden).toBe(false);
	});

	// FAIL OPEN ON UNKNOWN, CLOSED ONLY ON KNOWN-BAD. It is NOT verified that
	// real Chrome reports displaySurface === "monitor" for an entire-screen pick
	// under this exact constraint set, and the native picker cannot be driven
	// headlessly to confirm it. A gate that rejected every non-"monitor" value
	// would refuse 100% of meetings the instant Chrome returned undefined / "" /
	// some other token — a total outage strictly worse than the bug. So an
	// unrecognised surface must START (and warn), not block. Reverting the gate
	// to `surface !== "monitor"` makes each of the three tests below fail.
	it("starts a meeting recording when displaySurface is undefined (fail-open)", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			// displaySurface omitted → getSettings() returns {} (undefined),
			// exactly like a Chrome build that doesn't populate the field.
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
		expect(types(h)).not.toContain("INSTRUCTION_CANCEL");
		expect(h.el("view-recording").hidden).toBe(false);
	});

	it("starts a meeting recording when displaySurface is an empty string (fail-open)", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "",
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
		expect(types(h)).not.toContain("INSTRUCTION_CANCEL");
	});

	it("starts a meeting recording on an unrecognised surface token, and warns", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "screencast",
			tabAudio: "live",
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
		// The fail-open is never silent: a warning naming the observed value.
		expect(warn).toHaveBeenCalled();
		expect(warn.mock.calls.flat().join(" ")).toContain("screencast");
		warn.mockRestore();
	});

	// REGRESSION GUARD. The plain "Record screen" button (popup.ts omits
	// meeting/sourceTabId for non-Meet tabs) lands on this SAME page with no
	// ?meeting=1. Recording a single tab or window there is legitimate — an
	// unconditional surface gate would silently delete that feature.
	it("does NOT gate the plain 'Record screen' path — a tab capture still records", async () => {
		const h = await setup({
			search: "",
			displaySurface: "browser",
			tabAudio: "none",
			systemAudio: true,
		});
		h.click("btn-start");
		await drain();

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
	});
});

describe("mic acquisition never blocks the start path (B2)", () => {
	// THE DEFECT this guards against: getUserMedia() does not resolve while
	// Chrome's mic permission prompt sits unanswered. inpage-recorder.ts already
	// has MIC_ACQUIRE_TIMEOUT_MS + withTimeout for exactly this; this twin path
	// (Ctrl+Shift+9 → recorder.html) had none, so an unanswered prompt hung
	// startRecording() forever with the native "Stop sharing" bar already live.
	it("proceeds WITHOUT the mic ~8s after an unanswered mic prompt, instead of hanging forever", async () => {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "monitor",
			tabAudio: "live",
			micEnabled: true,
			micHang: true,
		});
		vi.useFakeTimers();
		h.click("btn-start");

		// Flush the microtask chain up to the point where the mic getUserMedia
		// race schedules its real (now fake) 8s timer.
		await vi.advanceTimersByTimeAsync(0);
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);

		// GUARD THE GUARD: must still be waiting just short of the deadline —
		// otherwise this test would pass even if the timeout were removed
		// entirely and something else happened to unblock it early.
		await vi.advanceTimersByTimeAsync(7999);
		expect(FakeRecorder.last?.startCalls ?? 0).toBe(0);
		expect(types(h)).not.toContain("RECORDER_STARTED");

		// Cross the 8000ms mic deadline and let the rest of the start chain
		// (tab audio + RECORDER_STARTED round-trip, all real microtasks) settle.
		await vi.advanceTimersByTimeAsync(50);

		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(types(h)).toContain("RECORDER_STARTED");
		expect(h.el("view-recording").hidden).toBe(false);
	});
});

// ── Adaptive capture tier on the full-screen INSTRUCTION path ───────────────
//
// The SW routes CAPTURE_TIER to THIS tab first whenever the recording is an
// instruction/full-screen one (background/sw.ts sendCaptureTier). While this
// page had no handler the message resolved `undefined`, the ack gate correctly
// refused to commit, and the recording could not adapt to a slow link at all —
// which is exactly the case that left a 6-minute recording still uploading long
// after Stop on an 800 kbit/s connection.
describe("CAPTURE_TIER on the visible recorder page", () => {
	async function recording(): Promise<Harness> {
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "monitor",
			tabAudio: "live",
			systemAudio: true,
		});
		h.click("btn-start");
		await drain();
		if ((FakeRecorder.last?.startCalls ?? 0) !== 1) {
			throw new Error("harness: the recording never started");
		}
		return h;
	}

	function videoTrackOf(h: Harness): FakeTrack {
		return h.displayStream.getVideoTracks()[0];
	}

	it("applies the tier to the LIVE video track — frame rate first, then the height cap", async () => {
		const h = await recording();
		const reduced = captureTierFor("reduced");

		const ack = await sendTier(h, reduced, sessionIdOf(h));

		expect(ack).toEqual({ ok: true, sessionId: sessionIdOf(h) });
		expect(videoTrackOf(h).applied).toEqual([
			{ frameRate: { max: reduced.frameRate } },
			{
				frameRate: { max: reduced.frameRate },
				width: { max: reduced.maxWidth },
				height: { max: reduced.maxHeight },
			},
		]);
		expect(videoTrackOf(h).readyState).toBe("live");
	});

	it("never stops or recreates the MediaRecorder across tier changes", async () => {
		const h = await recording();
		const before = FakeRecorder.last;
		if (!before) throw new Error("no recorder");
		const builtAtStart = FakeRecorder.constructed;
		const sessionId = sessionIdOf(h);

		await sendTier(h, captureTierFor("reduced"), sessionId);
		await sendTier(h, captureTierFor("minimal"), sessionId);
		await sendTier(h, captureTierFor("full"), sessionId); // and back up

		// Object identity — not "a recorder exists", but THE SAME ONE.
		expect(FakeRecorder.last).toBe(before);
		expect(FakeRecorder.constructed).toBe(builtAtStart);
		expect(before.stopCalls).toBe(0);
		expect(before.startCalls).toBe(1);
		expect(before.state).toBe("recording");
		expect(videoTrackOf(h).stopped).toBe(false);
		expect(videoTrackOf(h).applied).toHaveLength(6);
		// The upload was never told anything happened, and the user was not thrown
		// off the recording view.
		expect(types(h)).not.toContain("RECORDER_STOPPED");
		expect(h.el("view-recording").hidden).toBe(false);
	});

	it("never touches the audio tracks", async () => {
		const h = await recording();
		const audioTracks = h.displayStream.getAudioTracks();
		expect(audioTracks.length).toBeGreaterThan(0); // guard the guard

		await sendTier(h, captureTierFor("minimal"), sessionIdOf(h));

		for (const t of audioTracks) {
			expect(t.applyConstraints).not.toHaveBeenCalled();
			expect(t.applied).toEqual([]);
			expect(t.stopped).toBe(false);
			expect(t.readyState).toBe("live");
		}
	});

	it("keeps the frame-rate step when the source refuses the resolution cap", async () => {
		const h = await recording();
		videoTrackOf(h).refuse = (c) => "height" in c;
		const minimal = captureTierFor("minimal");

		const ack = await sendTier(h, minimal, sessionIdOf(h));

		expect(ack).toEqual({ ok: true, sessionId: sessionIdOf(h) });
		expect(videoTrackOf(h).applied).toEqual([
			{ frameRate: { max: minimal.frameRate } },
		]);
	});

	it("answers ok:false — never a false yes — when the source refuses everything", async () => {
		const h = await recording();
		videoTrackOf(h).refuse = () => true;

		const ack = await sendTier(h, captureTierFor("minimal"), sessionIdOf(h));

		expect(ack).toEqual({ ok: false, sessionId: sessionIdOf(h) });
		expect(videoTrackOf(h).applied).toEqual([]);
		expect(FakeRecorder.last?.stopCalls).toBe(0);
	});

	it("refuses a tier addressed to a DIFFERENT recorder session", async () => {
		const h = await recording();

		const ack = await sendTier(h, captureTierFor("minimal"), "sess-from-an-old-recording");

		expect(ack).toEqual({ ok: false, sessionId: "sess-from-an-old-recording" });
		expect(videoTrackOf(h).applied).toEqual([]);
	});

	it("refuses a message that names no tier we know, instead of restoring quality", async () => {
		const h = await recording();

		expect(await sendTier(h, {}, sessionIdOf(h))).toEqual({
			ok: false,
			sessionId: sessionIdOf(h),
		});
		expect(await sendTier(h, { name: "ultra" }, sessionIdOf(h))).toEqual({
			ok: false,
			sessionId: sessionIdOf(h),
		});
		expect(videoTrackOf(h).applied).toEqual([]);
	});

	it("does not ack when this tab owns no capture", async () => {
		// A leftover recorder tab sitting at the idle view receives the broadcast
		// too. Answering "ok" would commit a tier the live recording — running in
		// some OTHER context — is not actually at.
		const h = await setup({
			search: "?source=7&meeting=1",
			displaySurface: "monitor",
			tabAudio: "live",
		});
		expect(await sendTier(h, captureTierFor("reduced"), "sess-somewhere-else")).toBe(
			"NO_RESPONSE",
		);
		expect(h.displayStream.getVideoTracks()[0].applied).toEqual([]);
	});
});
