import { describe, expect, it } from "vitest";

import type { ExtensionState } from "../background/state";
import {
	attachFlash,
	flashBinding,
	NO_FLASH,
	reconcileFlash,
} from "./flash-message";

// ── The reducer behind "the honest message survives a re-render" ─────────────
//
// This is the PURE half of the fix (flash-message.ts). It decides, for an
// incoming app-state, whether a live message belongs to the SAME logical state
// (keep it — the ~5/s timer/upload re-renders must not erase it) or to one the
// app has since left (drop it, so a stale line can't linger and lie). No DOM, so
// it runs in the package's node test env; the DOM wiring is proved separately in
// popup.rerender.test.ts.

function recording(paused: boolean): ExtensionState {
	return {
		kind: "recording",
		mode: "instruction",
		videoId: "v",
		uploadId: "u",
		startedAt: 0,
		parts: [],
		nextPartNumber: 1,
		totalBytes: 0,
		uploadedBytes: 0,
		mime: "video/webm",
		paused,
	};
}

const uploading: ExtensionState = {
	kind: "uploading",
	videoId: "v",
	uploadId: "u",
	parts: [],
	totalBytes: 10,
	uploadedBytes: 3,
};

const uploadingProgressed: ExtensionState = { ...uploading, uploadedBytes: 8 };

describe("flashBinding distinguishes transitions from cosmetic re-renders", () => {
	it("keeps a running recording distinct from a paused one", () => {
		expect(flashBinding(recording(false))).toBe("recording:live");
		expect(flashBinding(recording(true))).toBe("recording:paused");
	});

	it("ignores upload progress — same binding across byte counts", () => {
		expect(flashBinding(uploading)).toBe("uploading");
		expect(flashBinding(uploadingProgressed)).toBe("uploading");
	});

	it("uses the kind for the other states", () => {
		expect(flashBinding({ kind: "idle" })).toBe("idle");
		expect(flashBinding({ kind: "finishing", videoId: "v" })).toBe("finishing");
	});
});

describe("reconcileFlash keeps a live message across cosmetic re-renders", () => {
	it("survives a same-state re-render (recording timer tick)", () => {
		const flash = attachFlash(recording(false), {
			text: "Couldn't pause",
			isError: true,
		});
		expect(reconcileFlash(flash, recording(false))).toBe(flash);
	});

	it("survives an upload-progress re-render (bytes changed, state did not)", () => {
		const flash = attachFlash(uploading, {
			text: "Delete queued; will retry",
			isError: false,
		});
		expect(reconcileFlash(flash, uploadingProgressed)).toBe(flash);
	});
});

describe("reconcileFlash drops a message once its state has moved on", () => {
	it("clears a pause error when the recorder actually pauses", () => {
		const flash = attachFlash(recording(false), {
			text: "Couldn't pause",
			isError: true,
		});
		expect(reconcileFlash(flash, recording(true))).toEqual(NO_FLASH);
	});

	it("clears an uploading message when the upload finishes", () => {
		const flash = attachFlash(uploading, { text: "Deleted", isError: false });
		expect(reconcileFlash(flash, { kind: "idle" })).toEqual(NO_FLASH);
	});

	it("is a no-op when there is no message to clear", () => {
		expect(reconcileFlash(NO_FLASH, recording(true))).toBe(NO_FLASH);
	});
});
