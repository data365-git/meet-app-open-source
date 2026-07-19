import { afterEach, describe, expect, it, vi } from "vitest";

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

	constructor(_stream: unknown, opts: { mimeType: string }) {
		this.mimeType = opts.mimeType;
		FakeRecorder.last = this;
	}
	static last: FakeRecorder | null = null;

	start(): void {
		this.startCalls++;
		this.state = "recording";
	}
	stop(): void {
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

interface Harness {
	sent: Array<Record<string, unknown>>;
	el: (id: string) => FakeElement;
	displayStream: FakeStream;
	click: (id: string) => void;
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
}

async function setup(opts: SetupOpts): Promise<Harness> {
	vi.resetModules();

	const sent: Array<Record<string, unknown>> = [];
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
				if (msg.type === "GET_ALL_SETTINGS") cb({ micEnabled: false });
				else if (msg.type === "REQUEST_TAB_AUDIO") {
					cb(
						opts.tabAudio === "live"
							? { streamId: "tab-stream-1", required: true }
							: { streamId: null, required: opts.search.includes("meeting=1") },
					);
				} else cb({ ok: true });
				return undefined;
			},
			onMessage: { addListener: () => undefined },
		},
	};

	const getUserMedia = vi.fn(async () => new FakeStream([new FakeTrack("audio")]));
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

	await import("./recorder-page");

	return {
		sent,
		el,
		displayStream,
		click: (id: string) => el(id).fire("click"),
	};
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
		expect(h.el("idle-msg").textContent).toMatch(/To'liq ekranni tanlang/);
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
		expect(h.el("idle-msg").textContent).toMatch(/To'liq ekranni tanlang/);
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
