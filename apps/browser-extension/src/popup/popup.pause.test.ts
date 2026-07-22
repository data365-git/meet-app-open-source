import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type FakeElement,
	FakeDocument,
	FakeElement as FakeEl,
} from "../test-utils/fake-dom";

// ── Popup Pause/Resume must not claim a state the recorder isn't in ─────────
//
// background/sw.ts has answered honestly since cdf521b: its PAUSE/RESUME
// handlers return { ok: false } and write nothing when the control message
// never reached a live recorder. The popup threw that answer away — it fired
// the message through a helper that swallowed even chrome.runtime.lastError,
// then re-enabled the button on a fixed 200ms timer that is SHORTER than the
// SW's own retry budget (4 attempts x 150ms backoff). So a failed pause and a
// successful one looked identical, and the button went live again while the
// command was still retrying.
//
// popup.ts is a side-effect module: importing it runs init() against `document`
// and `chrome`. Same hand-rolled-globals approach as offscreen/recorder.test.ts
// (vitest runs this package in the "node" environment; jsdom is not a dep).

type Listener = (msg: unknown, sender?: unknown) => void;

interface Harness {
	root: FakeElement;
	sent: Array<Record<string, unknown>>;
	/** What the fake service worker answers to PAUSE / RESUME. */
	control: { reply: unknown; defer: boolean; release?: () => void };
	/** Deliver the SW's STATE_CHANGED broadcast, as setState does. */
	broadcast: (state: Record<string, unknown>) => void;
}

const SETTINGS = {
	apiBaseUrl: "https://example.test",
	apiKey: "cak_test",
	autoRecordOnMeet: false,
	autoRecordCountdownSec: 5,
	micDeviceId: "",
	micEnabled: true,
	captureMode: "picker",
	soundEnabled: true,
	cameraOverlay: false,
	cameraDeviceId: "",
};

function recordingState(paused: boolean): Record<string, unknown> {
	return {
		kind: "recording",
		mode: "instruction",
		startedAt: Date.now() - 5000,
		paused,
		pausedAt: paused ? Date.now() : undefined,
		pausedAccumMs: 0,
		parts: [],
	};
}

async function setup(): Promise<Harness> {
	vi.resetModules();

	const doc = new FakeDocument();
	const root = new FakeEl("root");
	doc.elements.set("root", root);

	const sent: Array<Record<string, unknown>> = [];
	const control: Harness["control"] = { reply: { ok: true }, defer: false };
	const messageListeners: Listener[] = [];

	const chromeStub = {
		runtime: {
			lastError: undefined,
			sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
				sent.push(msg);
				if (!cb) return Promise.resolve(undefined);
				switch (msg.type) {
					case "GET_ALL_SETTINGS":
						cb(SETTINGS);
						break;
					case "GET_STATE":
						cb(recordingState(false));
						break;
					case "PAUSE":
					case "RESUME":
						if (control.defer) control.release = () => cb(control.reply);
						else cb(control.reply);
						break;
					default:
						cb({ ok: true });
				}
				return undefined;
			},
			onMessage: {
				addListener: (fn: Listener) => {
					messageListeners.push(fn);
				},
			},
		},
		tabs: { query: async () => [{ id: 1, url: "https://example.test/" }] },
		storage: {
			local: {
				get: async (key: string) =>
					key === "capExtFirstRun" ? { capExtFirstRun: false } : {},
				remove: async () => undefined,
				set: async () => undefined,
			},
			onChanged: { addListener: () => undefined },
		},
	};

	vi.stubGlobal("chrome", chromeStub);
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", {
		addEventListener: () => undefined,
		close: () => undefined,
	});
	vi.stubGlobal("requestAnimationFrame", () => 0);
	vi.stubGlobal("cancelAnimationFrame", () => undefined);
	// The recording view's 1s timer would otherwise stay live between tests.
	vi.stubGlobal("setInterval", () => 0);
	vi.stubGlobal("clearInterval", () => undefined);

	await import("./popup");
	await drain();

	return {
		root,
		sent,
		control,
		broadcast: (state) => {
			for (const fn of messageListeners) fn({ type: "STATE_CHANGED", state });
		},
	};
}

async function drain(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		for (let i = 0; i < 20; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
	}
}

/** Find the rendered Pause/Resume button the way a user finds it: by its label. */
function pauseButton(h: Harness): FakeElement {
	const btn = h.root
		.descendants()
		.find(
			(e) =>
				e.tagName === "button" &&
				["Pause", "Resume", "Pausing...", "Resuming..."].includes(e.textContent),
		);
	if (!btn) throw new Error("no pause/resume button in the rendered recording view");
	return btn;
}

function inlineErrorText(h: Harness): string {
	return h.root
		.descendants()
		.filter((e) => e.className === "inline-msg")
		.map((e) => e.textContent)
		.join("");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("popup Pause/Resume tells the truth about the recorder", () => {
	it("renders a Pause button for a live recording", async () => {
		const h = await setup();
		expect(pauseButton(h).textContent).toBe("Pause");
		expect(inlineErrorText(h)).toBe("");
	});

	// THE BLOCKER. The SW says the command never reached a recorder; the popup
	// must not present that as a pause, and must not stay silent about it.
	it("does NOT move to paused when the SW reports the command failed", async () => {
		const h = await setup();
		h.control.reply = { ok: false };

		pauseButton(h).click();
		await drain();

		expect(h.sent.filter((m) => m.type === "PAUSE")).toHaveLength(1);

		const btn = pauseButton(h);
		expect(btn.textContent).toBe("Pause");
		expect(btn.disabled).toBe(false);
		// Visible, in-UI explanation — a silent no-op is indistinguishable from
		// success, which is the same lie in a quieter voice.
		expect(inlineErrorText(h).length).toBeGreaterThan(0);
	});

	it("treats a missing reply as failure, not success", async () => {
		const h = await setup();
		h.control.reply = undefined;

		pauseButton(h).click();
		await drain();

		expect(pauseButton(h).textContent).toBe("Pause");
		expect(inlineErrorText(h).length).toBeGreaterThan(0);
	});

	// DEFECT (2): the button used to re-enable itself after a hardcoded 200ms,
	// while sendControlWithRetry (4 attempts, 150ms backoff) could still be
	// retrying — a live button and a stale label over an unresolved command,
	// and a second click would issue a second command into it.
	it("stays disabled for the WHOLE command, not a fixed 200ms", async () => {
		const h = await setup();
		h.control.defer = true;

		pauseButton(h).click();
		await drain();

		// Well past the old 200ms timer, with the command still in flight.
		await new Promise((r) => setTimeout(r, 320));
		await drain();

		const btn = pauseButton(h);
		expect(btn.disabled).toBe(true);
		expect(btn.textContent).toBe("Pausing...");

		h.control.release?.();
		await drain();
	});

	// On success the popup deliberately does nothing locally: the SW persists the
	// flag and broadcasts STATE_CHANGED, and the whole view re-renders from that
	// truth. Proving it here stops a future "fix" from adding an optimistic local
	// flip, which is exactly how the UI would start lying again.
	it("shows Resume only after the SW's broadcast confirms the pause", async () => {
		const h = await setup();
		h.control.reply = { ok: true };

		pauseButton(h).click();
		await drain();

		h.broadcast(recordingState(true));
		await drain();

		expect(pauseButton(h).textContent).toBe("Resume");
		expect(inlineErrorText(h)).toBe("");
	});

	it("sends RESUME (not PAUSE) from the paused view", async () => {
		const h = await setup();
		h.broadcast(recordingState(true));
		await drain();
		expect(pauseButton(h).textContent).toBe("Resume");

		h.control.reply = { ok: false };
		pauseButton(h).click();
		await drain();

		expect(h.sent.filter((m) => m.type === "RESUME")).toHaveLength(1);
		expect(h.sent.filter((m) => m.type === "PAUSE")).toHaveLength(0);
		// Failed resume: still showing Resume, with a reason.
		expect(pauseButton(h).textContent).toBe("Resume");
		expect(inlineErrorText(h).length).toBeGreaterThan(0);
	});
});
