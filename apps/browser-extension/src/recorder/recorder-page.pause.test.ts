import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type FakeDocument, documentFromHtml } from "../test-utils/fake-dom";

// ── Pause/Resume on the persistent recorder tab ─────────────────────────────
//
// recorder-page.ts owns the full-screen capture in its own tab. It has always
// been ABLE to pause (it handles the SW's PAUSE_CAPTURE broadcast) but offered
// the user no control at all, so anyone recording via that path had to open the
// popup to pause. These tests drive the REAL module through a real start and
// then use the button the way a user does.
//
// Kept separate from recorder-page.test.ts (the surface-gate suite) because
// this harness needs two things that one does not: element ids parsed from the
// REAL recorder.html — so an assertion cannot pass unless the markup actually
// declares the control — and a captured onMessage listener, so the service
// worker's PAUSE_CAPTURE broadcast can be delivered in its true order.

const RECORDER_HTML = readFileSync(
	fileURLToPath(new URL("./recorder.html", import.meta.url)),
	"utf8",
);

type TrackKind = "audio" | "video";

class FakeTrack {
	kind: TrackKind;
	readyState: "live" | "ended" = "live";
	muted = false;
	onended: (() => void) | null = null;

	constructor(kind: TrackKind) {
		this.kind = kind;
	}

	getSettings(): { displaySurface: string } {
		return { displaySurface: "monitor" };
	}

	stop(): void {
		this.readyState = "ended";
	}
}

class FakeStream {
	private readonly tracks: FakeTrack[];
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
	static last: FakeRecorder | null = null;

	state: "inactive" | "recording" | "paused" = "inactive";
	mimeType: string;
	ondataavailable: ((e: unknown) => void) | null = null;
	onerror: (() => void) | null = null;
	onstop: (() => void) | null = null;
	startCalls = 0;
	pauseCalls = 0;
	resumeCalls = 0;

	constructor(_stream: unknown, opts: { mimeType: string }) {
		this.mimeType = opts.mimeType;
		FakeRecorder.last = this;
	}

	start(): void {
		this.startCalls++;
		this.state = "recording";
	}
	stop(): void {
		this.state = "inactive";
		this.onstop?.();
	}
	pause(): void {
		this.pauseCalls++;
		this.state = "paused";
	}
	resume(): void {
		this.resumeCalls++;
		this.state = "recording";
	}
}

class FakeAudioContext {
	state: "running" | "suspended" = "running";
	destination = {};
	onstatechange: (() => void) | null = null;
	private readonly destStream = new FakeStream([new FakeTrack("audio")]);

	createMediaStreamDestination() {
		return { stream: this.destStream };
	}
	createMediaStreamSource() {
		return { connect: (node?: unknown) => node };
	}
	createGain() {
		return { gain: { value: 1 }, connect: (node?: unknown) => node };
	}
	async close(): Promise<void> {}
	async resume(): Promise<void> {}
}

type Listener = (
	msg: unknown,
	sender: unknown,
	sendResponse: (r: unknown) => void,
) => void;

interface Harness {
	doc: FakeDocument;
	sent: Array<Record<string, unknown>>;
	/** What the fake service worker answers to PAUSE / RESUME. Mutable per test. */
	control: { reply: unknown };
}

async function setup(): Promise<Harness> {
	vi.resetModules();
	FakeRecorder.last = null;

	const doc = documentFromHtml(RECORDER_HTML);
	const sent: Array<Record<string, unknown>> = [];
	const captured: { fn?: Listener } = {};
	const control: Harness["control"] = { reply: { ok: true } };

	function replyFor(msg: Record<string, unknown>): unknown {
		switch (msg.type) {
			case "GET_ALL_SETTINGS":
				// Mic off keeps the start path down to the one thing under test.
				return { micEnabled: false, micDeviceId: "" };
			case "REQUEST_TAB_AUDIO":
				return { streamId: null, required: false };
			case "RECORDER_STARTED":
				return { ok: true };
			case "PAUSE":
			case "RESUME": {
				// FAITHFUL ORDERING: sw.ts delivers PAUSE_CAPTURE / RESUME_CAPTURE to
				// the recorder BEFORE it returns its reply, so by the time the page's
				// await resolves its own onMessage listener has already done the local
				// pause. A handler written as "await, then pause locally" double-acts —
				// which is exactly what pauseCalls/resumeCalls below assert against.
				const ok =
					typeof control.reply === "object" &&
					control.reply !== null &&
					(control.reply as { ok?: unknown }).ok === true;
				if (ok && captured.fn) {
					captured.fn(
						{ type: msg.type === "PAUSE" ? "PAUSE_CAPTURE" : "RESUME_CAPTURE" },
						{},
						() => undefined,
					);
				}
				return control.reply;
			}
			default:
				return undefined;
		}
	}

	const chromeStub = {
		runtime: {
			lastError: undefined,
			sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
				sent.push(msg);
				if (cb) {
					cb(replyFor(msg));
					return undefined;
				}
				return Promise.resolve(undefined);
			},
			onMessage: {
				addListener: (fn: Listener) => {
					captured.fn = fn;
				},
			},
		},
		tabs: { create: () => undefined },
	};

	// Video-only display stream and no tab audio, so the page's "mic-only" audio
	// warning is genuinely showing during the recording view. That is what lets
	// the failure test prove a pause error does not clobber it.
	const getDisplayMedia = vi.fn(async () => new FakeStream([new FakeTrack("video")]));
	const getUserMedia = vi.fn(async () => new FakeStream([new FakeTrack("audio")]));

	vi.stubGlobal("chrome", chromeStub);
	vi.stubGlobal("document", doc);
	vi.stubGlobal("location", { search: "" });
	vi.stubGlobal("window", {
		addEventListener: () => undefined,
		close: () => undefined,
	});
	vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia, getUserMedia } });
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("MediaStream", FakeStream);
	// The on-screen timer would otherwise leave a live 1s interval per test.
	vi.stubGlobal("setInterval", () => 0);
	vi.stubGlobal("clearInterval", () => undefined);

	await import("./recorder-page");

	if (!captured.fn) throw new Error("recorder page registered no message listener");
	return { doc, sent, control };
}

/** Let the whole async chain (start, or a pause round-trip) settle. */
async function drain(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
}

async function startRecording(h: Harness): Promise<void> {
	h.doc.getElementById("btn-start")?.click();
	await drain();
}

async function clickPause(h: Harness): Promise<void> {
	const btn = h.doc.getElementById("btn-pause");
	if (!btn) throw new Error("#btn-pause does not exist in recorder.html");
	btn.click();
	await drain();
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("recorder page Pause/Resume", () => {
	it("offers a Pause control while recording, and routes it through the service worker", async () => {
		const h = await setup();
		await startRecording(h);

		// Guard the guard: a harness where recording never starts would make the
		// assertions below vacuous.
		expect(FakeRecorder.last?.startCalls).toBe(1);
		expect(h.doc.getElementById("view-recording")?.hidden).toBe(false);

		const btn = h.doc.getElementById("btn-pause");
		expect(btn, "#btn-pause is missing from recorder.html").not.toBeNull();
		expect(btn?.hidden).toBe(false);
		expect(btn?.textContent).toBe("Pauza");

		await clickPause(h);

		// Routed through the SW, which owns the persisted paused flag and the
		// popup's view — NOT poked straight into the local recorder.
		expect(h.sent.filter((m) => m.type === "PAUSE")).toHaveLength(1);
	});

	it("pauses exactly once on success and flips the label to Resume", async () => {
		const h = await setup();
		await startRecording(h);
		await clickPause(h);

		expect(FakeRecorder.last?.state).toBe("paused");
		// The SW's broadcast performs the local pause. The button must not repeat it.
		expect(FakeRecorder.last?.pauseCalls).toBe(1);

		const btn = h.doc.getElementById("btn-pause");
		expect(btn?.textContent).toBe("Davom ettirish");
		expect(btn?.disabled).toBe(false);
		expect(h.doc.getElementById("rec-ctl-msg")?.hidden).toBe(true);
	});

	it("resumes from paused and flips the label back", async () => {
		const h = await setup();
		await startRecording(h);
		await clickPause(h);
		expect(FakeRecorder.last?.state).toBe("paused");

		await clickPause(h);

		expect(h.sent.filter((m) => m.type === "RESUME")).toHaveLength(1);
		expect(FakeRecorder.last?.state).toBe("recording");
		expect(FakeRecorder.last?.resumeCalls).toBe(1);
		expect(h.doc.getElementById("btn-pause")?.textContent).toBe("Pauza");
	});

	// THE BLOCKER. The SW already answers { ok: false } when the control message
	// never reached a live recorder. The UI must not move to the new state on
	// that answer, and must not stay silent about it either — a silent no-op is
	// indistinguishable from success.
	it("does NOT move the UI to paused when the command fails, and says why", async () => {
		const h = await setup();
		await startRecording(h);

		const warn = h.doc.getElementById("rec-audio-warn");
		const warnTextBefore = warn?.textContent;
		// Precondition, not the assertion: the mic-only warning really is showing,
		// so the "did not clobber it" check below is testing something.
		expect(warn?.hidden).toBe(false);
		expect(warnTextBefore).not.toBe("");

		h.control.reply = { ok: false };
		await clickPause(h);

		const btn = h.doc.getElementById("btn-pause");
		expect(btn?.textContent).toBe("Pauza");
		expect(btn?.disabled).toBe(false);
		expect(FakeRecorder.last?.state).toBe("recording");
		expect(FakeRecorder.last?.pauseCalls).toBe(0);

		const ctl = h.doc.getElementById("rec-ctl-msg");
		expect(ctl, "#rec-ctl-msg is missing from recorder.html").not.toBeNull();
		expect(ctl?.hidden).toBe(false);
		expect((ctl?.textContent ?? "").length).toBeGreaterThan(0);

		// ...and the failure message did not clobber the client-audio warning,
		// which is a separate, owner-mandated, persistent message with its own
		// priority state machine.
		expect(warn?.textContent).toBe(warnTextBefore);
		expect(warn?.hidden).toBe(false);
	});

	it("keeps showing Resume when a RESUME fails, and does not resume the recorder", async () => {
		const h = await setup();
		await startRecording(h);
		await clickPause(h);
		expect(h.doc.getElementById("btn-pause")?.textContent).toBe("Davom ettirish");

		h.control.reply = { ok: false };
		await clickPause(h);

		expect(FakeRecorder.last?.state).toBe("paused");
		expect(FakeRecorder.last?.resumeCalls).toBe(0);
		expect(h.doc.getElementById("btn-pause")?.textContent).toBe("Davom ettirish");
		const ctl = h.doc.getElementById("rec-ctl-msg");
		expect(ctl?.hidden).toBe(false);
		expect((ctl?.textContent ?? "").length).toBeGreaterThan(0);
	});

	// No listener answered at all — what Chrome hands back when the recorder is
	// gone and every listener closed unanswered.
	it("treats a missing reply as failure, not success", async () => {
		const h = await setup();
		await startRecording(h);

		h.control.reply = undefined;
		await clickPause(h);

		expect(FakeRecorder.last?.state).toBe("recording");
		expect(FakeRecorder.last?.pauseCalls).toBe(0);
		expect(h.doc.getElementById("btn-pause")?.textContent).toBe("Pauza");
		expect(h.doc.getElementById("rec-ctl-msg")?.hidden).toBe(false);
	});

	// The error must not outlive the failure it describes: a later successful
	// command has to clear it, or the page keeps showing a stale complaint.
	it("clears the inline error once a later command succeeds", async () => {
		const h = await setup();
		await startRecording(h);

		h.control.reply = { ok: false };
		await clickPause(h);
		expect(h.doc.getElementById("rec-ctl-msg")?.hidden).toBe(false);

		h.control.reply = { ok: true };
		await clickPause(h);

		expect(FakeRecorder.last?.state).toBe("paused");
		expect(h.doc.getElementById("rec-ctl-msg")?.hidden).toBe(true);
		expect(h.doc.getElementById("rec-ctl-msg")?.textContent).toBe("");
	});
});
