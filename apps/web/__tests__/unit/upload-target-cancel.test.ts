/**
 * Owner order 2026-09-11: a Cancel control on an in-progress import upload
 * that takes effect within a couple of seconds (not a network timeout) and
 * deletes whatever bytes were already sent. This covers the single-PUT path
 * (files under MULTIPART_UPLOAD_THRESHOLD_BYTES) — the multipart path's
 * equivalent cancellation is covered in multipart-upload-client.test.ts.
 *
 * Every assertion is on OUTCOME: whether the real xhr got aborted, whether a
 * retry was attempted, and what the promise settles with — never on which
 * internal function was called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CancelledUploadError } from "@/utils/multipart-upload";
import { uploadWithTarget } from "@/utils/upload-target";

type UploadOutcome =
	| { type: "success"; status?: number }
	| { type: "network-error" }
	| { type: "pending" };

class MockXMLHttpRequest {
	static outcomes: UploadOutcome[] = [];
	static abortedCount = 0;
	static sendCount = 0;

	upload = {
		onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	timeout = 0;
	private completed = false;

	static setOutcomes(outcomes: UploadOutcome[]) {
		MockXMLHttpRequest.outcomes = [...outcomes];
		MockXMLHttpRequest.abortedCount = 0;
		MockXMLHttpRequest.sendCount = 0;
	}

	open(_method: string, _url: string) {}
	setRequestHeader(_name: string, _value: string) {}

	send(_body: unknown) {
		MockXMLHttpRequest.sendCount += 1;
		const outcome = MockXMLHttpRequest.outcomes.shift();
		if (!outcome) throw new Error("Missing upload outcome");

		this.upload.onprogress?.({
			lengthComputable: true,
			loaded: 1,
			total: 1,
		} as ProgressEvent<EventTarget>);

		if (outcome.type === "pending") return;
		if (outcome.type === "network-error") {
			this.completed = true;
			this.onerror?.();
			return;
		}
		this.completed = true;
		this.status = outcome.status ?? 200;
		this.onload?.();
	}

	abort() {
		if (this.completed) return;
		this.completed = true;
		MockXMLHttpRequest.abortedCount += 1;
		this.onabort?.();
	}
}

const putTarget = {
	type: "put" as const,
	url: "https://uploads.example/single-put",
	headers: {},
};

describe("uploadWithTarget — cancellation", () => {
	beforeEach(() => {
		// upload-target.ts's stall detector uses window.setTimeout — the default
		// vitest environment here is "node", which has no window global.
		vi.stubGlobal("window", globalThis as typeof globalThis & Window);
		vi.stubGlobal(
			"XMLHttpRequest",
			MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("aborts the in-flight request immediately and rejects with CancelledUploadError", async () => {
		// "pending" never settles on its own — only a real xhr.abort() (fired by
		// the signal) ends this request, proving cancellation does not wait for
		// the stall/request timeout.
		MockXMLHttpRequest.setOutcomes([{ type: "pending" }]);
		const controller = new AbortController();

		const resultPromise = uploadWithTarget({
			target: putTarget,
			body: new Blob(["x"]),
			signal: controller.signal,
		});

		while (MockXMLHttpRequest.outcomes.length > 0) {
			await Promise.resolve();
		}
		controller.abort();

		await expect(resultPromise).rejects.toBeInstanceOf(CancelledUploadError);
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
	});

	it("rejects immediately, before even opening a request, when already cancelled", async () => {
		MockXMLHttpRequest.setOutcomes([{ type: "success" }]);
		const controller = new AbortController();
		controller.abort();

		await expect(
			uploadWithTarget({
				target: putTarget,
				body: new Blob(["x"]),
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(CancelledUploadError);
		expect(MockXMLHttpRequest.sendCount).toBe(0);
	});

	it("cancelling never retries, even though a network error alone would", async () => {
		// Only ONE outcome. A network error alone retries up to
		// MAX_UPLOAD_ATTEMPTS and would throw "Missing upload outcome" once the
		// queue runs dry — cancellation must never reach that retry.
		MockXMLHttpRequest.setOutcomes([{ type: "network-error" }]);
		const controller = new AbortController();
		controller.abort();

		await expect(
			uploadWithTarget({
				target: putTarget,
				body: new Blob(["x"]),
				signal: controller.signal,
			}),
		).rejects.toBeInstanceOf(CancelledUploadError);
	});

	it("an ordinary success still resolves when no cancellation happens", async () => {
		MockXMLHttpRequest.setOutcomes([{ type: "success" }]);
		await expect(
			uploadWithTarget({
				target: putTarget,
				body: new Blob(["x"]),
				signal: new AbortController().signal,
			}),
		).resolves.toBeUndefined();
	});
});
