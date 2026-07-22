import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type FakeElement,
	FakeDocument,
	FakeElement as FakeEl,
} from "../test-utils/fake-dom";

// ── The honest message must SURVIVE the popup's constant re-render ───────────
//
// render() does root.innerHTML = "" and rebuilds the whole popup, and it runs
// several times a second while a recording uploads (each STATE_CHANGED broadcast
// re-renders). Wave 1 showed the Pause failure and the discard result by
// appending a node / mutating a button AFTER awaiting the service worker — but by
// the time that reply landed a re-render had detached that node, so the user saw
// a silent no-op. These tests drive the real init()/render() through the fake DOM
// and inject exactly such a re-render between the click and its visible result.
//
// Same hand-rolled-globals harness as popup.pause.test.ts (this package runs in
// the node env; jsdom is not a dependency).

type Listener = (msg: unknown, sender?: unknown) => void;

interface Harness {
	root: FakeElement;
	sent: Array<Record<string, unknown>>;
	control: { pauseReply: unknown; discardReply: unknown };
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

function uploadingState(uploadedBytes: number): Record<string, unknown> {
	return {
		kind: "uploading",
		videoId: "v",
		uploadId: "u",
		parts: [],
		totalBytes: 1000,
		uploadedBytes,
	};
}

async function setup(initialState: Record<string, unknown>): Promise<Harness> {
	vi.resetModules();

	const doc = new FakeDocument();
	const root = new FakeEl("root");
	doc.elements.set("root", root);

	const sent: Array<Record<string, unknown>> = [];
	const control: Harness["control"] = {
		pauseReply: { ok: true },
		discardReply: { ok: true, serverCleaned: true },
	};
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
						cb(initialState);
						break;
					case "PAUSE":
					case "RESUME":
						cb(control.pauseReply);
						break;
					case "DISCARD_UPLOAD":
						cb(control.discardReply);
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

function buttonByLabels(h: Harness, labels: string[]): FakeElement {
	const btn = h.root
		.descendants()
		.find((e) => e.tagName === "button" && labels.includes(e.textContent));
	if (!btn) throw new Error(`no button with a label in ${JSON.stringify(labels)}`);
	return btn;
}

function pauseButton(h: Harness): FakeElement {
	return buttonByLabels(h, ["Pause", "Resume", "Pausing...", "Resuming..."]);
}

function discardButton(h: Harness): FakeElement {
	return buttonByLabels(h, [
		"Permanently discard",
		"Tap again to delete this recording for good",
		"Discarding...",
	]);
}

function flashText(h: Harness): string {
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

describe("Pause failure message survives the recording's re-renders", () => {
	// THE DEFECT. On failure wave 1 appended the reason to the live root; the very
	// next ~5/s recording broadcast rebuilt the popup and detached that node, so
	// the user got a silent no-op — the same lie in a quieter voice.
	it("stays visible after a same-state re-render (timer tick / upload progress)", async () => {
		const h = await setup(recordingState(false));
		h.control.pauseReply = { ok: false };

		pauseButton(h).click();
		await drain();
		expect(flashText(h).length).toBeGreaterThan(0);

		// A cosmetic re-render of the SAME recording — this is what destroyed it.
		h.broadcast(recordingState(false));
		await drain();

		expect(flashText(h).length).toBeGreaterThan(0);
		expect(pauseButton(h).textContent).toBe("Pause");
		expect(pauseButton(h).disabled).toBe(false);
	});

	// The other half of "honest": the message must not linger and lie once the
	// recorder really did pause.
	it("clears once the recorder actually pauses", async () => {
		const h = await setup(recordingState(false));
		h.control.pauseReply = { ok: false };

		pauseButton(h).click();
		await drain();
		expect(flashText(h).length).toBeGreaterThan(0);

		h.broadcast(recordingState(true));
		await drain();

		expect(flashText(h)).toBe("");
		expect(pauseButton(h).textContent).toBe("Resume");
	});
});

describe("Discard result message survives the uploading view's re-renders", () => {
	it("keeps 'Deleted' visible after an upload-progress re-render", async () => {
		const h = await setup(uploadingState(200));
		h.control.discardReply = { ok: true, serverCleaned: true };

		discardButton(h).click(); // arm
		await drain();
		expect(discardButton(h).textContent).toContain("Tap again");

		discardButton(h).click(); // confirm
		await drain();
		expect(flashText(h)).toContain("Deleted");

		// Progress ticked: the uploading view rebuilds and would have replaced the
		// button (and its result text) with a fresh "Permanently discard".
		h.broadcast(uploadingState(600));
		await drain();

		expect(flashText(h)).toContain("Deleted");
	});

	it("keeps the honest 'Delete queued; will retry' when the server wasn't reached", async () => {
		const h = await setup(uploadingState(200));
		h.control.discardReply = { ok: true, serverCleaned: false };

		discardButton(h).click();
		await drain();
		discardButton(h).click();
		await drain();
		expect(flashText(h)).toContain("Delete queued");

		h.broadcast(uploadingState(600));
		await drain();

		expect(flashText(h)).toContain("Delete queued");
	});
});
