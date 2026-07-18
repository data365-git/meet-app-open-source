import { describe, expect, it, vi } from "vitest";

import { CAPTURE_COMMAND_PROBLEM, sendCaptureCommand } from "./capture-command";

// ── The pause/resume reply rule, tested once for both callers ───────────────
//
// The popup and the recorder page both ask the service worker to pause/resume.
// The SW already answers honestly ({ ok: false } when the control message never
// reached a live recorder — background/sw.ts PAUSE/RESUME), but a caller that
// ignores the answer shows "Paused" over a recorder that is still recording.
// That is the defect this module exists to make impossible to re-introduce in
// only one of the two callers.
//
// The rule is FAIL-CLOSED, like shared/client-audio.ts: only an explicit
// ok === true counts as "the recorder actually did it".

function transport(reply: unknown) {
	return vi.fn(async (_msg: Record<string, unknown>) => reply);
}

describe("sendCaptureCommand", () => {
	it("asks the service worker using the command as the message type", async () => {
		const send = transport({ ok: true });
		await sendCaptureCommand(send, "PAUSE");
		expect(send).toHaveBeenCalledWith({ type: "PAUSE" });

		const send2 = transport({ ok: true });
		await sendCaptureCommand(send2, "RESUME");
		expect(send2).toHaveBeenCalledWith({ type: "RESUME" });
	});

	it("reports success only for an explicit ok:true", async () => {
		await expect(sendCaptureCommand(transport({ ok: true }), "PAUSE")).resolves.toEqual({
			ok: true,
		});
		await expect(
			sendCaptureCommand(transport({ ok: true }), "RESUME"),
		).resolves.toEqual({ ok: true });
	});

	// THE CASE THE POPUP CURRENTLY THROWS AWAY. sw.ts returns a bare { ok: false }
	// — no error field — when sendControlWithRetry exhausted its attempts. A
	// caller must still end up with something it can SHOW the user.
	it("turns the SW's bare {ok:false} into a failure with user-facing copy", async () => {
		const pause = await sendCaptureCommand(transport({ ok: false }), "PAUSE");
		expect(pause).toEqual({ ok: false, error: CAPTURE_COMMAND_PROBLEM.PAUSE });

		const resume = await sendCaptureCommand(transport({ ok: false }), "RESUME");
		expect(resume).toEqual({ ok: false, error: CAPTURE_COMMAND_PROBLEM.RESUME });
	});

	// Copy must exist and be distinct per command: "still recording" and "still
	// paused" are opposite facts, and telling the user the wrong one is the same
	// class of lie as saying nothing.
	it("carries non-empty, command-specific copy", () => {
		expect(CAPTURE_COMMAND_PROBLEM.PAUSE.length).toBeGreaterThan(0);
		expect(CAPTURE_COMMAND_PROBLEM.RESUME.length).toBeGreaterThan(0);
		expect(CAPTURE_COMMAND_PROBLEM.PAUSE).not.toBe(CAPTURE_COMMAND_PROBLEM.RESUME);
	});

	// No listener answered at all (dead offscreen document / closed recorder tab
	// / SW asleep). Chrome resolves the callback with undefined. Treating that as
	// success is exactly how the UI ends up lying.
	it.each([
		["undefined (nobody answered)", undefined],
		["null", null],
		["a non-object reply", "ok"],
		["an object with no ok field", {}],
		["a truthy-but-not-true ok", { ok: "true" }],
		["ok explicitly undefined", { ok: undefined }],
	])("treats %s as failure, never success", async (_label, reply) => {
		const res = await sendCaptureCommand(transport(reply), "PAUSE");
		expect(res).toEqual({ ok: false, error: CAPTURE_COMMAND_PROBLEM.PAUSE });
	});

	// A transport that rejects (rather than resolving a failure shape) must not
	// escape to the caller as an unhandled rejection — the caller's button would
	// stay disabled forever.
	it("treats a rejecting transport as failure", async () => {
		const send = vi.fn(async () => {
			throw new Error("Receiving end does not exist");
		});
		const res = await sendCaptureCommand(send, "RESUME");
		expect(res).toEqual({ ok: false, error: CAPTURE_COMMAND_PROBLEM.RESUME });
	});
});
