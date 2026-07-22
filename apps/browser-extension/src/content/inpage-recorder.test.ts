import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	type InPageState,
	attachPageAudio,
	detachAllPageAudio,
	pruneDeadTaps,
} from "./inpage-recorder";

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
