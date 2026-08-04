import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	MIC_AUDIO_CONSTRAINTS,
	TAB_AUDIO_CONSTRAINTS,
	tabAudioConstraints,
} from "./recording-quality";

// ── THE PIN: tab / display audio is never captured with voice processing ────
//
// The other participant's voice reaches us as TAB audio, and it comes out of the
// local speakers. Chrome's echo canceller therefore classifies that voice as
// "far end" and gates it out — the person we are recording is silenced as if
// they were echo. Noise suppression eats shared video/music sound and the
// quieter of two overlapping speakers; auto gain control pumps against the
// deliberate TAB_AUDIO_GAIN lift.
//
// Flipping echoCancellation / noiseSuppression / autoGainControl back to `true`
// on a tab or display stream is therefore not a tuning preference, it is the
// meeting-audio bug. This file exists to make that flip FAIL, at three levels:
//   1. the shared constant,
//   2. the constraints object actually handed to Chrome's legacy parser,
//   3. the real offscreen tab-capture path, driven end to end.
// (The mic leg wants the opposite answer, so it is pinned here too — a blanket
// "everything false" refactor must not quietly take the mic down with it.)

const VOICE_PROCESSING_FLAGS = [
	"echoCancellation",
	"noiseSuppression",
	"autoGainControl",
] as const;

describe("TAB_AUDIO_CONSTRAINTS (level 1: the shared declaration)", () => {
	for (const flag of VOICE_PROCESSING_FLAGS) {
		it(`keeps ${flag} OFF for tab/display audio`, () => {
			expect(TAB_AUDIO_CONSTRAINTS[flag]).toBe(false);
		});
	}

	it("keeps the SAME three flags ON for the microphone (they are not symmetric)", () => {
		for (const flag of VOICE_PROCESSING_FLAGS) {
			expect(MIC_AUDIO_CONSTRAINTS[flag]).toBe(true);
		}
	});
});

describe("tabAudioConstraints() (level 2: what Chrome actually parses)", () => {
	// A constraints object containing `mandatory` goes through Chrome's LEGACY
	// parser, which ignores sibling modern keys. Both spellings must therefore
	// live INSIDE `mandatory`, or the flags are decorative.
	const constraints = tabAudioConstraints("tab-stream-1") as unknown as {
		mandatory?: Record<string, unknown>;
	};

	it("puts the flags inside `mandatory`, where the legacy parser reads them", () => {
		expect(constraints.mandatory).toBeTruthy();
		expect(constraints.mandatory?.chromeMediaSource).toBe("tab");
		expect(constraints.mandatory?.chromeMediaSourceId).toBe("tab-stream-1");
	});

	for (const flag of VOICE_PROCESSING_FLAGS) {
		const goog = `goog${flag[0].toUpperCase()}${flag.slice(1)}`;
		it(`requests ${flag} = false in both the modern and the ${goog} spelling`, () => {
			expect(constraints.mandatory?.[flag]).toBe(false);
			expect(constraints.mandatory?.[goog]).toBe(false);
		});
	}
});

// ── Level 3: the REAL offscreen tab-capture path ────────────────────────────
//
// Constants only matter if the capture call sites use them. offscreen/recorder.ts
// is a side-effect module (importing it registers a chrome.runtime.onMessage
// listener), so this drives it exactly like offscreen/recorder.test.ts does and
// then inspects the constraints its getUserMedia call really received.

type TrackKind = "audio" | "video";

class FakeTrack {
	readyState: "live" | "ended" = "live";
	muted = false;
	onended: (() => void) | null = null;
	onmute: (() => void) | null = null;
	onunmute: (() => void) | null = null;
	stopped = false;
	constructor(public kind: TrackKind) {}
	stop(): void {
		this.stopped = true;
		this.readyState = "ended";
	}
}

class FakeStream {
	constructor(private tracks: FakeTrack[] = []) {}
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
	constructor(_stream: unknown, opts: { mimeType: string }) {
		this.mimeType = opts.mimeType;
	}
	start(): void {
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
	private destStream = new FakeStream([new FakeTrack("audio")]);
	createMediaStreamDestination() {
		return { stream: this.destStream };
	}
	createMediaStreamSource() {
		return { connect: (node?: unknown) => node };
	}
	createGain() {
		return { gain: { value: 1 }, connect: (node?: unknown) => node };
	}
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

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the offscreen tab-capture path (level 3: the real call site)", () => {
	it("asks Chrome for the tab audio with every voice-processing flag disabled", async () => {
		vi.resetModules();

		const captured: Array<Record<string, unknown>> = [];
		let listener:
			| ((msg: unknown, sender: unknown, respond: (r: unknown) => void) => void)
			| undefined;

		const getUserMedia = vi.fn(async (constraints: Record<string, unknown>) => {
			captured.push(constraints);
			return new FakeStream([new FakeTrack("video"), new FakeTrack("audio")]);
		});

		vi.stubGlobal("chrome", {
			runtime: {
				lastError: undefined,
				sendMessage: (_msg: unknown, cb?: (r: unknown) => void) => {
					if (cb) {
						cb({ ok: true });
						return undefined;
					}
					return Promise.resolve(undefined);
				},
				onMessage: {
					addListener: (fn: typeof listener) => {
						listener = fn;
					},
				},
			},
		});
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
		vi.stubGlobal("MediaRecorder", FakeRecorder);
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.stubGlobal("MediaStream", FakeStream);

		await import("../offscreen/recorder");
		if (!listener) throw new Error("offscreen recorder registered no listener");

		listener(
			{ type: "START_CAPTURE", streamId: "tab-stream-1", micEnabled: false },
			{},
			() => undefined,
		);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		await new Promise((r) => setTimeout(r, 0));
		for (let i = 0; i < 10; i++) await Promise.resolve();

		const tabRequest = captured.find((c) => {
			const audio = c.audio as
				| { mandatory?: Record<string, unknown> }
				| undefined;
			return audio?.mandatory?.chromeMediaSource === "tab";
		});
		expect(
			tabRequest,
			"the offscreen path never requested tab audio",
		).toBeTruthy();

		const mandatory = (
			tabRequest?.audio as { mandatory: Record<string, unknown> }
		).mandatory;
		for (const flag of VOICE_PROCESSING_FLAGS) {
			const goog = `goog${flag[0].toUpperCase()}${flag.slice(1)}`;
			expect(mandatory[flag], `${flag} must be false on a tab stream`).toBe(
				false,
			);
			expect(mandatory[goog], `${goog} must be false on a tab stream`).toBe(
				false,
			);
		}
	});
});

// ── Level 3b: the two getDisplayMedia call sites ────────────────────────────
//
// The display-capture legs (visible recorder page + in-page Meet recorder) can
// only be driven through a full DOM harness, which their own suites already do.
// What this pins is the one thing those suites do not: that their audio request
// stays derived from TAB_AUDIO_CONSTRAINTS and never regresses to the bare
// `audio: true` these call sites shipped before — a bare `true` hands the
// display stream to Chrome's default processing chain, which is precisely the
// "the other side sounds chopped" bug.

const DISPLAY_CAPTURE_SOURCES = [
	"../recorder/recorder-page.ts",
	"../content/inpage-recorder.ts",
];

describe("the getDisplayMedia call sites (level 3b)", () => {
	for (const rel of DISPLAY_CAPTURE_SOURCES) {
		it(`${rel} requests display audio through TAB_AUDIO_CONSTRAINTS, never a bare \`audio: true\``, () => {
			const source = readFileSync(
				fileURLToPath(new URL(rel, import.meta.url)),
				"utf8",
			);
			const start = source.indexOf("getDisplayMedia({");
			expect(start, "no getDisplayMedia call found").toBeGreaterThan(-1);
			const end = source.indexOf("DisplayMediaStreamOptions", start);
			expect(end, "getDisplayMedia options never close").toBeGreaterThan(start);
			const body = source.slice(start, end);
			expect(body).toContain("audio: { ...TAB_AUDIO_CONSTRAINTS }");
			expect(body).not.toMatch(/audio:\s*true/);
		});
	}
});
