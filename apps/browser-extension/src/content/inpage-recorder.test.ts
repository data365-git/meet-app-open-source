import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	type InPageState,
	applyCaptureTierTo,
	attachPageAudio,
	detachAllPageAudio,
	SILENCE_WARN_MSG,
	pruneDeadTaps,
} from "./inpage-recorder";
import { CAPTURE_TIERS, captureTierFor } from "../shared/recording-quality";

// ── The tap-repair logic behind "the remote voices don't vanish mid-call" ────
//
// Google Meet REUSES a small pool of <audio> elements and swaps their source as
// the active speaker changes. A MediaStreamAudioSourceNode is bound to the track
// it was created with and never follows that swap, so a tap goes permanently
// silent while the element is still in the DOM and everything still LOOKS
// connected. The e2e harness proves this end-to-end (PROOF_SWAP=1: before the
// fix, the last two segments of the recording were -90 dB), but that harness
// needs a headed Windows desktop and cannot run in CI — so the same rule is
// pinned here, in the node test env, where it runs on every commit.

interface FakeTrack {
	id: string;
	readyState: "live" | "ended";
	kind: "audio";
	stop(): void;
}

function track(id: string, readyState: "live" | "ended" = "live"): FakeTrack {
	// stop() is TERMINAL — exactly like Blink's MediaStreamTrackImpl::stopTrack: the
	// track goes to "ended" and never comes back. The old fake made stop() a no-op,
	// which is precisely why the 2026-07-22 second-recording bug slipped past unit
	// tests (detachAllPageAudio stopped tracks it never owned, and nothing noticed).
	const t: FakeTrack = {
		id,
		readyState,
		kind: "audio",
		stop: () => {
			t.readyState = "ended";
		},
	};
	return t;
}

/** Chrome hands back the SAME MediaStream object across source changes, with a
 * new track inside it — which is exactly why "does this stream have a live
 * track?" was not a usable staleness test. The fake reproduces that, or the test
 * would prove nothing. */
class FakeCaptureStream {
	constructor(public tracks: FakeTrack[]) {}
	getAudioTracks(): FakeTrack[] {
		return this.tracks;
	}
	getTracks(): FakeTrack[] {
		return this.tracks;
	}
}

class FakeElement {
	isConnected = true;
	readonly stream: FakeCaptureStream;
	constructor(initial: FakeTrack) {
		this.stream = new FakeCaptureStream([initial]);
	}
	captureStream(): FakeCaptureStream {
		return this.stream;
	}
	/** What Meet does when the speaker changes: same element, same stream object,
	 * the old track ends and a new one takes its place. */
	swapSource(next: FakeTrack): void {
		this.stream.tracks[0].readyState = "ended";
		this.stream.tracks = [next];
	}
}

let elements: FakeElement[] = [];
const createdSources: Array<{ connect: () => void; disconnect: () => void }> =
	[];

function makeState(): InPageState {
	const gain = { gain: { value: 1 }, connect: () => {} };
	return {
		audioCtx: {
			createMediaStreamSource: () => {
				const node = { connect: vi.fn(), disconnect: vi.fn() };
				createdSources.push(node);
				return node;
			},
		},
		pageGain: gain,
		systemGain: null,
		analyser: null,
		taps: new Map(),
	} as unknown as InPageState;
}

beforeEach(() => {
	elements = [];
	createdSources.length = 0;
	(globalThis as unknown as { document: unknown }).document = {
		querySelectorAll: () => elements,
	};
	// The real code wraps the current live track in a fresh MediaStream so the
	// source node binds to THAT track and nothing else.
	(globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
		constructor(public tracks: FakeTrack[]) {}
	};
});

describe("attachPageAudio", () => {
	it("taps a media element once and does not re-tap it while its track is unchanged", () => {
		const el = new FakeElement(track("t1"));
		elements = [el];
		const s = makeState();

		expect(attachPageAudio(s)).toBe(1);
		expect(attachPageAudio(s)).toBe(0); // second sweep: nothing new
		expect(s.taps.size).toBe(1);
		expect(createdSources).toHaveLength(1);
	});

	it("REBUILDS the source node when the element keeps its stream but swaps the track", () => {
		// The regression this pins: the tap looked alive (the stream still had a
		// live track) while the source node was stuck on the retired one.
		const el = new FakeElement(track("t1"));
		elements = [el];
		const s = makeState();
		attachPageAudio(s);
		const firstNode = createdSources[0];

		el.swapSource(track("t2"));

		expect(attachPageAudio(s)).toBe(1); // counted as a fresh attach
		expect(s.taps.size).toBe(1); // still ONE tap for the element
		expect(firstNode.disconnect).toHaveBeenCalled(); // dead node unwired
		expect(createdSources).toHaveLength(2);
		expect(s.taps.get(el as unknown as HTMLMediaElement)?.trackId).toBe("t2");
	});

	it("mutes the system-audio stand-in as soon as real page audio arrives", () => {
		// Otherwise the same voices are recorded twice — once tapped, once through
		// the picker's system loopback — which is echo for the rest of the call.
		const s = makeState();
		const systemGain = { gain: { value: 1 }, connect: () => {} };
		s.systemGain = systemGain as unknown as GainNode;

		expect(attachPageAudio(s)).toBe(0); // no media yet: stand-in stays audible
		expect(systemGain.gain.value).toBe(1);

		elements = [new FakeElement(track("t1"))];
		attachPageAudio(s);

		expect(systemGain.gain.value).toBe(0);
		expect(s.systemGain).toBeNull();
	});

	it("ignores an element that is no longer in the page", () => {
		const el = new FakeElement(track("t1"));
		el.isConnected = false;
		elements = [el];

		expect(attachPageAudio(makeState())).toBe(0);
	});
});

describe("second recording on the same page (the 2026-07-22 prod bug)", () => {
	it("can still tap the same element after the first recording is cleaned up", () => {
		// Recording #1's cleanup used to stop() the captured tracks. On real Meet's
		// srcObject-backed elements those wrap Meet's OWN live track, so stopping them
		// left recording #2 with only dead tracks → attachPageAudio returns 0 →
		// "the other person's audio wasn't captured" and a file with no remote voices. detachAllPageAudio
		// must disconnect the source nodes only, never stop tracks it does not own.
		const el = new FakeElement(track("t1"));
		elements = [el];

		const s1 = makeState();
		expect(attachPageAudio(s1)).toBe(1); // recording #1 taps fine
		detachAllPageAudio(s1); // recording #1 stops + cleans up

		const s2 = makeState(); // recording #2: fresh state, SAME page/element
		expect(attachPageAudio(s2)).toBe(1); // must still find the live track
	});
});

describe("pruneDeadTaps", () => {
	it("forgets taps whose element left the page, and keeps the rest", () => {
		const staying = new FakeElement(track("t1"));
		const leaving = new FakeElement(track("t2"));
		elements = [staying, leaving];
		const s = makeState();
		attachPageAudio(s);
		expect(s.taps.size).toBe(2);

		leaving.isConnected = false;

		expect(pruneDeadTaps(s)).toBe(1);
		expect(s.taps.size).toBe(1);
		expect(s.taps.has(staying as unknown as HTMLMediaElement)).toBe(true);
	});
});

// ── The silence warning must not claim something it cannot see ───────────────
//
// The watchdog fires after two minutes with no page audio. It CANNOT tell
// "nobody is speaking / I am alone in the call" from "the tap is broken", so
// any wording that asserts the second is a lie in the first case. The owner hit
// exactly that on 2026-07-28, alone in a Meet: the old copy told him the other
// person's audio was not coming through, and his objection was that his IT team
// would then distrust recordings that are perfectly fine. On the product's core
// promise, a false alarm costs more than no alarm.
//
// This pins the CLAIM, not the phrasing: reword freely, but the message may not
// state as fact that the remote audio is failing, and it must keep telling the
// owner what to do if someone really is speaking.
describe("silence warning wording", () => {
	it("reports observed silence instead of asserting the other person is unheard", () => {
		const msg = SILENCE_WARN_MSG.toLowerCase();

		// The defect: asserting a failure the watchdog cannot distinguish.
		expect(msg).not.toContain("isn't coming through");
		expect(msg).not.toContain("is not coming through");
		expect(msg).not.toContain("wasn't captured");

		// What it may say: the observation, plus a conditional action.
		expect(msg).toContain("no sound");
		expect(msg).toContain("if");
	});
});

// ── Stepping the capture down must NOT disturb the encoder ──────────────────
//
// The whole adaptive-capture feature is only safe because of one property: it
// changes the SOURCE, not the recorder. Restarting a MediaRecorder mid-recording
// emits a second fMP4 init segment into an upload that is already mid-stream, and
// the two byte streams interleave into an unplayable file — the corruption family
// that took four review rounds to clear on 2026-07-23. So these tests assert the
// negative space (same recorder object, never stopped, audio untouched) as hard
// as they assert the positive.

interface FakeVideoTrack {
	kind: "video";
	readyState: "live" | "ended";
	applied: MediaTrackConstraints[];
	stop: () => void;
	applyConstraints: (c: MediaTrackConstraints) => Promise<void>;
}

function videoTrack(
	reject: (c: MediaTrackConstraints) => boolean = () => false,
): FakeVideoTrack {
	const t: FakeVideoTrack = {
		kind: "video",
		readyState: "live",
		applied: [],
		stop: () => {
			t.readyState = "ended";
		},
		applyConstraints: async (c) => {
			if (reject(c)) throw new Error("OverconstrainedError");
			t.applied.push(c);
		},
	};
	return t;
}

function audioTrackWithConstraints() {
	const constraints: MediaTrackConstraints[] = [];
	return {
		kind: "audio" as const,
		readyState: "live" as const,
		applied: constraints,
		stop: vi.fn(),
		applyConstraints: vi.fn(async (c: MediaTrackConstraints) => {
			constraints.push(c);
		}),
	};
}

function tierState(video: FakeVideoTrack) {
	const audio = audioTrackWithConstraints();
	const recorder = {
		state: "recording",
		stop: vi.fn(),
		start: vi.fn(),
		mimeType: "video/mp4;codecs=h264",
	};
	const s = {
		sessionId: "sess-1",
		recorder,
		displayStream: {
			getVideoTracks: () => [video],
			getAudioTracks: () => [audio],
			getTracks: () => [video, audio],
		},
		taps: new Map(),
		captureTier: "full",
	} as unknown as InPageState;
	return { s, recorder, audio };
}

describe("applyCaptureTierTo", () => {
	it("lowers the LIVE video track with applyConstraints — frame rate first, then the height cap", async () => {
		const track = videoTrack();
		const { s } = tierState(track);
		const reduced = captureTierFor("reduced");

		expect(await applyCaptureTierTo(s, reduced)).toBe(true);

		// Two calls, in the documented order.
		expect(track.applied).toHaveLength(2);
		const [first, second] = track.applied;

		// 1) frame rate alone — the cheap, safe step.
		expect(first).toEqual({ frameRate: { max: reduced.frameRate } });
		expect(first).not.toHaveProperty("height");

		// 2) the height cap, CARRYING the frame rate: a constraint set replaces the
		//    previous one, so dropping frameRate here would silently undo step 1.
		expect(second).toEqual({
			frameRate: { max: reduced.frameRate },
			width: { max: reduced.maxWidth },
			height: { max: reduced.maxHeight },
		});

		expect(s.captureTier).toBe("reduced");
	});

	it("keeps the SAME MediaRecorder object across a tier change and never stops or restarts it", async () => {
		const track = videoTrack();
		const { s, recorder } = tierState(track);
		const before = s.recorder;

		await applyCaptureTierTo(s, captureTierFor("reduced"));
		await applyCaptureTierTo(s, captureTierFor("minimal"));
		await applyCaptureTierTo(s, captureTierFor("full")); // and back up

		// Object identity — not "a recorder exists", but THE SAME ONE.
		expect(s.recorder).toBe(before);
		expect(recorder.stop).not.toHaveBeenCalled();
		expect(recorder.start).not.toHaveBeenCalled();
		expect(recorder.state).toBe("recording");
		expect(s.captureTier).toBe("full");
	});

	it("never touches the audio tracks", async () => {
		const track = videoTrack();
		const { s, audio } = tierState(track);

		await applyCaptureTierTo(s, captureTierFor("minimal"));

		expect(audio.applyConstraints).not.toHaveBeenCalled();
		expect(audio.applied).toEqual([]);
		expect(audio.stop).not.toHaveBeenCalled();
		expect(audio.readyState).toBe("live");
	});

	it("does not stop the video track either — the source is re-constrained in place", async () => {
		const track = videoTrack();
		const { s } = tierState(track);

		await applyCaptureTierTo(s, captureTierFor("minimal"));

		expect(track.readyState).toBe("live");
	});

	it("keeps the frame-rate reduction when the source refuses the resolution cap", async () => {
		// OverconstrainedError on the height step must not throw away the frame-rate
		// step that already succeeded — that is why they are two separate calls.
		const track = videoTrack((c) => "height" in c);
		const { s } = tierState(track);

		expect(await applyCaptureTierTo(s, captureTierFor("minimal"))).toBe(true);
		// Derived from the tier table, like the sibling assertions above: this one
		// hardcoded the frame rate and so broke when the floor was lowered, even
		// though the behaviour under test (keep step 1 when step 2 is refused) was
		// unchanged. The assertion is no weaker — it still pins that EXACTLY ONE
		// constraint set was applied and that it is the frame-rate step.
		expect(track.applied).toEqual([
			{ frameRate: { max: captureTierFor("minimal").frameRate } },
		]);
		expect(s.captureTier).toBe("minimal");
	});

	it("does nothing when the share has already ended", async () => {
		const track = videoTrack();
		track.readyState = "ended";
		const { s, recorder } = tierState(track);

		expect(await applyCaptureTierTo(s, captureTierFor("minimal"))).toBe(false);
		expect(track.applied).toEqual([]);
		expect(recorder.stop).not.toHaveBeenCalled();
		expect(s.captureTier).toBe("full"); // unchanged
	});

	it("reports failure — and leaves the tier untouched — when every step is refused", async () => {
		const track = videoTrack(() => true);
		const { s, recorder } = tierState(track);

		expect(await applyCaptureTierTo(s, captureTierFor("minimal"))).toBe(false);
		expect(s.captureTier).toBe(CAPTURE_TIERS[0].name);
		expect(recorder.stop).not.toHaveBeenCalled();
	});
});
