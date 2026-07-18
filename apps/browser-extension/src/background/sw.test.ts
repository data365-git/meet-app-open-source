import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_PART_SIZE, PART_MAX_ATTEMPTS } from "./upload";

// ── Shared fake-chrome harness for sw.ts ────────────────────────────────────
//
// sw.ts is a pure side-effect module: importing it registers real chrome.*
// listeners (onMessage, onStartup, onInstalled, onAlarm, tabs.onRemoved, ...).
// There is no exported surface to call directly, so these tests import the
// REAL module once per test (fresh chrome stub + vi.resetModules), capture
// the listener functions chrome.*.addListener was called with, and drive
// behaviour by invoking those captured listeners exactly as Chrome would.

const RETRY_QUEUE_KEY = "capExtRetryQueue";

function createFakeChromeStorage() {
	const store = new Map<string, unknown>();
	// Real chrome.storage.local structured-clones every value in and out — a
	// caller holding onto a `get()` result never observes a LATER `set()`
	// mutating it, and mutating a `get()` result never touches the store. A
	// naive Map-backed fake that returns the stored reference directly breaks
	// that: two concurrent readers would silently share (and rescue each
	// other's mutations to) the SAME array object, masking exactly the
	// lost-update race this test exists to prove. Clone on both sides.
	const clone = <T>(v: T): T =>
		v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
	return {
		store,
		async get(key: string) {
			return { [key]: clone(store.get(key)) };
		},
		async set(items: Record<string, unknown>) {
			for (const [k, v] of Object.entries(items)) store.set(k, clone(v));
		},
		async remove(key: string) {
			store.delete(key);
		},
	};
}

type Listener = (...args: unknown[]) => unknown;

function createFakeChrome() {
	const storage = createFakeChromeStorage();
	const captured: {
		message?: (
			message: unknown,
			sender: unknown,
			sendResponse: (r: unknown) => void,
		) => boolean;
		startup?: () => Promise<void> | void;
		installed?: () => Promise<void> | void;
		alarm?: (alarm: { name: string }) => void;
	} = {};

	const notifications: Array<{
		id?: string;
		title?: string;
		message?: string;
	}> = [];

	const chrome = {
		storage: { local: storage },
		runtime: {
			getURL: (p: string) => `chrome-extension://fake/${p}`,
			lastError: undefined as { message: string } | undefined,
			sendMessage: async () => undefined,
			getContexts: async () => [],
			ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
			onMessage: {
				addListener: (fn: Listener) => {
					captured.message = fn as typeof captured.message;
				},
			},
			onMessageExternal: { addListener: () => undefined },
			onStartup: {
				addListener: (fn: Listener) => {
					captured.startup = fn as typeof captured.startup;
				},
			},
			onInstalled: {
				addListener: (fn: Listener) => {
					captured.installed = fn as typeof captured.installed;
				},
			},
			openOptionsPage: () => undefined,
		},
		tabs: {
			query: async () => [],
			update: async () => undefined,
			create: async () => ({ id: 1 }),
			get: async () => ({ id: 1 }),
			sendMessage: async () => undefined,
			onRemoved: { addListener: () => undefined },
			onUpdated: { addListener: () => undefined },
		},
		windows: { update: async () => undefined },
		offscreen: {
			createDocument: async () => undefined,
			closeDocument: async () => undefined,
			Reason: { USER_MEDIA: "USER_MEDIA" },
		},
		tabCapture: {
			getMediaStreamId: (_opts: unknown, cb: (id: string) => void) =>
				cb("fake-stream-id"),
			onStatusChanged: { addListener: () => undefined },
		},
		notifications: {
			create: (...args: unknown[]) => {
				// Real chrome.notifications.create supports both (options) and
				// (id, options) — capture whichever arg is the options object.
				const opts = (args.length > 1 ? args[1] : args[0]) as {
					title?: string;
					message?: string;
				};
				const id = args.length > 1 ? (args[0] as string) : undefined;
				notifications.push({ id, ...opts });
			},
			clear: () => undefined,
			onButtonClicked: { addListener: () => undefined },
		},
		alarms: {
			create: () => undefined,
			clear: () => undefined,
			onAlarm: {
				addListener: (fn: Listener) => {
					captured.alarm = fn as typeof captured.alarm;
				},
			},
		},
		action: {
			setBadgeText: () => undefined,
			setBadgeBackgroundColor: () => undefined,
			openPopup: async () => undefined,
		},
	};

	return { chrome, captured, storage, notifications };
}

function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Send a message through the captured chrome.runtime.onMessage listener and
 * await its (async) sendResponse, exactly as chrome would deliver it. */
function sendMessage(
	captured: ReturnType<typeof createFakeChrome>["captured"],
	message: unknown,
): Promise<unknown> {
	return new Promise((resolve) => {
		if (!captured.message) throw new Error("onMessage listener not captured");
		captured.message(message, {}, resolve);
	});
}

/** The alarm handler's retryPendingUploads() call is fire-and-forget (chrome
 * never awaits an alarm listener) — there's no promise to await directly.
 * Flushing a few real macrotask ticks lets any pending (pure-microtask, no
 * real I/O in this test's fakes) promise chain run to completion. */
async function flushAsync(ticks = 5): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function freshSw() {
	vi.resetModules();
	const fake = createFakeChrome();
	vi.stubGlobal("chrome", fake.chrome);
	await import("./sw");
	const { setState, setSettings } = await import("./state");
	await setSettings({ apiKey: "test-key" });
	return { ...fake, setState, setSettings };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ── P1.5: dedicated retry alarm, serialized through enqueueRecorder ────────

describe("P1.5 — dedicated retry alarm", () => {
	it("a concurrent addToRetryQueue (via a live recording's chunk failure) is not lost to an alarm-triggered drain racing the same storage key", async () => {
		const { captured, storage } = await freshSw();
		const { setState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-race",
			uploadId: "upload-race",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// Pre-seed the retry queue with one already-due item from an unrelated,
		// earlier failure — this is what the alarm's drain will process.
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 1,
						videoId: "vid-earlier",
						uploadId: "upload-earlier",
						partDataBase64:
							Buffer.from("earlier-part-bytes").toString("base64"),
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000, // already due
				},
			],
		});

		let earlierPutSucceeded = false;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					const body = init?.body;
					const bytes =
						body instanceof Uint8Array
							? body
							: new Uint8Array(
									await new Response(body as BodyInit).arrayBuffer(),
								);
					// The pre-seeded "earlier" part's drain PUT succeeds; the LIVE
					// recording's full-size chunk PUT (MIN_PART_SIZE bytes) fails,
					// forcing handleChunk to call addToRetryQueue while the drain is
					// (deliberately, see gate below) still in flight.
					if (bytes.length === MIN_PART_SIZE) {
						return new Response("boom", { status: 500 });
					}
					earlierPutSucceeded = true;
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-earlier"' },
					});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		// Deterministically force the race window instead of hoping incidental
		// microtask timing happens to interleave: delay the FIRST read of the
		// retry queue (the alarm-triggered drain's getRetryQueue call) until
		// AFTER the live recording's addToRetryQueue has read-modified-written
		// the SAME key. The drain then resumes with a now-stale snapshot and
		// writes it back — the classic lost-update shape — unless the two are
		// actually serialized through one FIFO queue (the fix under test).
		let gateRelease: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			gateRelease = resolve;
		});
		let delayNextRetryQueueRead = true;
		const realGet = storage.get.bind(storage);
		storage.get = (async (key: string) => {
			const result = await realGet(key);
			if (key === RETRY_QUEUE_KEY && delayNextRetryQueueRead) {
				delayNextRetryQueueRead = false;
				await gate;
			}
			return result;
		}) as typeof storage.get;

		const fullPartChunk = new Uint8Array(MIN_PART_SIZE);

		expect(captured.alarm).toBeDefined();
		captured.alarm?.({ name: "cap-retry-queue" });
		const chunkPromise = sendMessage(captured, {
			type: "RECORDER_CHUNK",
			chunk: Array.from(fullPartChunk),
			index: 0,
			mime: "video/webm",
		});

		// Flush every currently-resolvable microtask (everything neither chain's
		// own logic depends on real time for) before releasing the gate. If the
		// two operations are NOT serialized, handleChunk's entire chain — pure
		// microtask work, no real timers — fully completes here, including its
		// own queue write, while the drain sits parked on the gate; releasing it
		// afterwards then lets the drain clobber that write with a stale read
		// (the race). If they ARE serialized, handleChunk's job is chained
		// behind the drain's and simply hasn't started yet at this point — no
		// deadlock, since we haven't awaited chunkPromise yet.
		await new Promise((resolve) => setTimeout(resolve, 0));
		gateRelease?.();

		await chunkPromise;
		await flushAsync();

		const finalQueue =
			(storage.store.get(RETRY_QUEUE_KEY) as Array<{
				kind: string;
				payload: Record<string, unknown>;
			}>) ?? [];

		// The earlier item must have been drained (succeeded, removed).
		expect(earlierPutSucceeded).toBe(true);
		expect(
			finalQueue.some((item) => item.payload.videoId === "vid-earlier"),
		).toBe(false);

		// The NEW item from the live recording's failed chunk PUT must be
		// present — NOT silently lost to the concurrent drain's get-then-set.
		expect(
			finalQueue.some(
				(item) => item.kind === "part" && item.payload.videoId === "vid-race",
			),
		).toBe(true);
	});
});

// ── P1.1: RECORDER_ERROR must salvage, never just throw the recording away ─

describe("P1.1 — RECORDER_ERROR salvage", () => {
	it("salvages already-uploaded parts via finalizeUpload and surfaces as complete, never error, when the salvage succeeds", async () => {
		const { captured, notifications } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-p11",
			uploadId: "upload-p11",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		let completeMultipartCalls = 0;
		let completedPartsSent:
			| Array<{ partNumber: number; etag: string; size: number }>
			| undefined;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-1"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					completeMultipartCalls += 1;
					const body = JSON.parse(String(init?.body)) as {
						parts: Array<{ partNumber: number; etag: string; size: number }>;
					};
					completedPartsSent = body.parts;
					return jsonResponse({
						location: undefined,
						success: true,
						fileKey: "file",
					});
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		// One full MIN_PART_SIZE chunk succeeds and lands as an uploaded part —
		// this is the "already uploaded, potentially a 2-hour meeting" data that
		// the old code abandoned mid-multipart on RECORDER_ERROR.
		const fullPartChunk = new Uint8Array(MIN_PART_SIZE);
		await sendMessage(captured, {
			type: "RECORDER_CHUNK",
			chunk: Array.from(fullPartChunk),
			index: 0,
			mime: "video/webm",
		});

		await sendMessage(captured, {
			type: "RECORDER_ERROR",
			error: "MediaRecorder died unexpectedly",
		});

		expect(completeMultipartCalls).toBe(1);
		expect(completedPartsSent?.length).toBe(1);

		const finalState = await getState();
		// The core assertion: a successful salvage must surface as complete,
		// NEVER error — the old code unconditionally wrote kind:"error" here,
		// which would tell the user their saved recording failed.
		expect(finalState.kind).toBe("complete");

		const errorNotif = notifications.find((n) => n.id === "recorder-error");
		expect(errorNotif).toBeDefined();
		// The byte count must be reported to the user, not just silently saved.
		expect(errorNotif?.message).toMatch(/\d/);
	});

	it("does not stomp finalizeUpload's own more specific reason when the salvage cannot complete", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-p11b",
			uploadId: "upload-p11b",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			// No chunks were ever received — finalizeUpload's own MIN_VIABLE_BYTES
			// guard will reject this with its OWN specific reason.
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		vi.stubGlobal("fetch", async () => {
			throw new Error("no network calls expected in this scenario");
		});

		await sendMessage(captured, {
			type: "RECORDER_ERROR",
			error: "MediaRecorder died unexpectedly",
		});

		const finalState = await getState();
		expect(finalState.kind).toBe("error");
		if (finalState.kind === "error") {
			// finalizeUpload's specific "too short" reason must survive, not be
			// overwritten by the generic RECORDER_ERROR message.
			expect(finalState.reason).toMatch(/too short/i);
		}
	});
});

// ── P1.2: onStartup must finish the job for every in-progress state, and
// never leave the extension permanently un-startable ───────────────────────

function stubFinalizeFetch(onCompleteParts?: (n: number) => void) {
	let completeMultipartCalls = 0;
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			if (url.includes("/api/upload/multipart/presign-part")) {
				return jsonResponse({
					presignedUrl: "https://fake-r2.example/put",
					provider: "r2",
				});
			}
			if (method === "PUT") {
				return new Response(null, {
					status: 200,
					headers: { ETag: '"etag-x"' },
				});
			}
			if (url.includes("/api/upload/multipart/complete")) {
				completeMultipartCalls += 1;
				const body = JSON.parse(String(init?.body)) as {
					parts: Array<unknown>;
				};
				onCompleteParts?.(body.parts.length);
				return jsonResponse({
					location: undefined,
					success: true,
					fileKey: "file",
				});
			}
			if (url.includes("/api/upload/recording-complete")) {
				return jsonResponse({});
			}
			throw new Error(`Unhandled fetch in test: ${method} ${url}`);
		},
	);
	return () => completeMultipartCalls;
}

describe("P1.2 — onStartup recovery", () => {
	it("finishes the job for a persisted 'recording' state (browser restarted mid-recording)", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-p12a",
			uploadId: "upload-p12a",
			startedAt: Date.now(),
			parts: [{ PartNumber: 1, ETag: "etag-1" }],
			nextPartNumber: 2,
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
			mime: "video/webm",
			paused: false,
		});

		const getCompleteCalls = stubFinalizeFetch();

		expect(captured.startup).toBeDefined();
		await captured.startup?.();

		expect(getCompleteCalls()).toBe(1);
		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
	});

	it("finishes the job for a persisted 'uploading' state (crash mid-finalize) instead of bricking forever", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "uploading",
			videoId: "vid-p12b",
			uploadId: "upload-p12b",
			parts: [{ PartNumber: 1, ETag: "etag-1" }],
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
		});

		const getCompleteCalls = stubFinalizeFetch();

		await captured.startup?.();

		expect(getCompleteCalls()).toBe(1);
		const finalState = await getState();
		// Old behaviour: onStartup only started keepalive for "uploading" and
		// never called finalizeUpload — state stayed "uploading" forever, and
		// isInProgress() would refuse every future recording.
		expect(finalState.kind).toBe("complete");
	});

	it("maps a persisted 'finishing' state to a terminal state instead of bricking the extension forever", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		// FinishingState (state.ts) carries only a videoId — no uploadId, no
		// parts — so it is genuinely unrecoverable as persisted.
		await setState({ kind: "finishing", videoId: "vid-p12c" });

		await captured.startup?.();

		const finalState = await getState();
		// Must NOT still be "finishing" (isInProgress() would keep refusing
		// every future recording forever, with no driver ever able to resolve
		// it since FinishingState carries no uploadId/parts to resume from).
		expect(finalState.kind).not.toBe("finishing");
		expect(["error", "complete"]).toContain(finalState.kind);
	});
});

// ── Fix #2: dead-letter exhaustion must release the UI, not brick it ───────
//
// (adversarial-review finding, recording-loss path B) When a queued item
// exhausts MAX_ATTEMPTS and moveToDeadLetter runs, state used to stay
// "uploading" forever. isInProgress() (this file, above) then refused EVERY
// new recording with "a recording is already in progress" — the user is told
// to do the exact thing the extension then blocks, until a browser restart.
// This test drives real retry exhaustion and proves the release through the
// REAL isInProgress() gate (via the START_INSTRUCTION handler), not just by
// re-reading the state string.

describe("Fix 2 — dead-letter exhaustion releases the UI", () => {
	it("a part item that exhausts retries clears 'uploading' and a new recording is accepted afterwards (isInProgress unblocked)", async () => {
		const { captured, storage } = await freshSw();
		const { setState, getState } = await import("./state");
		const { retryPendingUploads } = await import("./upload");

		await setState({
			kind: "uploading",
			videoId: "vid-dl1",
			uploadId: "upload-dl1",
			parts: [],
			totalBytes: 20_000,
			uploadedBytes: 0,
		});

		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 1,
						videoId: "vid-dl1",
						uploadId: "upload-dl1",
						partDataBase64: Buffer.from("dead-letter-bytes").toString("base64"),
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					return new Response("boom", { status: 500 });
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		vi.useFakeTimers();
		// BACKOFF_SECONDS = [1,4,16,64,256]; 6 total attempts dead-letters.
		// Drive past PART_MAX_ATTEMPTS (R6 raised the retry horizon) until the
		// part finally dead-letters and the UI is released.
		for (let i = 0; i < PART_MAX_ATTEMPTS + 2; i++) {
			const step = 256000;
			vi.setSystemTime(Date.now() + step);
			await retryPendingUploads();
		}

		const midState = await getState();
		// The brick: before the fix, state stayed "uploading" forever once the
		// item exhausted retries and dead-lettered.
		expect(midState.kind).not.toBe("uploading");

		// The UI must actually be released, not just the state string changed —
		// prove it via the REAL isInProgress() gate every start handler checks.
		const response = (await sendMessage(captured, {
			type: "START_INSTRUCTION",
		})) as { ok: boolean; error?: string };
		expect(response.ok).toBe(true);
	});
});

// ── R9: a crash while finishing must RESUME the finalize, not write off a
// recording whose bytes are all already in R2 ──────────────────────────────

describe("R9 — persisted 'finishing' resumes instead of being written off", () => {
	it("re-queues the completeMultipart on startup and finishes the recording", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		// Crashed mid-completeMultipart: every byte is in R2, only the finalize
		// call is left — and now the state carries what it takes to redo it.
		await setState({
			kind: "finishing",
			videoId: "vid-r9",
			uploadId: "upload-r9",
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
		});

		let completeCalls = 0;
		let recordingCompleteCalls = 0;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/upload/multipart/complete")) {
					completeCalls += 1;
					return jsonResponse({ success: true, fileKey: "file" });
				}
				if (url.includes("/api/upload/recording-complete")) {
					recordingCompleteCalls += 1;
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		if (!captured.startup) throw new Error("startup listener not captured");
		await captured.startup();
		await flushAsync();

		// The re-queued complete is scheduled ~1s out (addToRetryQueue), so the
		// startup drain itself is too early — the 1-minute retry alarm picks it
		// up. Simulate that next drain.
		const { retryPendingUploads } = await import("./upload");
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 5000);
		await retryPendingUploads();

		// The bug: the old FinishingState kept only a videoId, so the restart
		// could only tell the user "the recording may have completed; otherwise
		// re-record" — a fully-uploaded meeting written off.
		expect(completeCalls).toBe(1);
		expect(recordingCompleteCalls).toBe(1);
		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
	});
});

// ── R8: if the stop command never reaches the recorder, STOP must finalize
// anyway — otherwise the recording sits in "recording" forever and its already
// uploaded parts are never completed ───────────────────────────────────────

describe("R8 — STOP falls back to finalize when the recorder is unreachable", () => {
	it("finalizes the recording instead of leaving it stuck when STOP_CAPTURE cannot be delivered", async () => {
		const { chrome, captured } = await freshSw();
		const { setState, getState } = await import("./state");

		// A live recording with one part already safely in R2.
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-r8",
			uploadId: "upload-r8",
			startedAt: Date.now(),
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
			nextPartNumber: 2,
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
			mime: "video/webm",
			paused: false,
		});

		// The offscreen document is dead: every STOP_CAPTURE delivery fails.
		// Only the callback form (sendToOffscreen) fails — the promise form is
		// broadcastState inside setState and must keep working.
		chrome.runtime.sendMessage = ((message: unknown, callback?: unknown) => {
			if (typeof callback === "function") {
				chrome.runtime.lastError = { message: "Receiving end does not exist" };
				(callback as (r: unknown) => void)(undefined);
				chrome.runtime.lastError = undefined;
				return undefined;
			}
			return Promise.resolve(undefined);
		}) as typeof chrome.runtime.sendMessage;

		let completeCalls = 0;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/upload/multipart/complete")) {
					completeCalls += 1;
					return jsonResponse({ success: true, fileKey: "file" });
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		await sendMessage(captured, { type: "STOP" });
		await flushAsync();

		// The bug: STOP returned {ok:true} while the recorder never stopped, so
		// nothing ever emitted RECORDER_STOPPED — the recording stayed
		// "recording" forever and its uploaded parts were never completed.
		const finalState = await getState();
		expect(finalState.kind).not.toBe("recording");
		expect(finalState.kind).toBe("complete");
		expect(completeCalls).toBe(1);
	});
});

// ── R2: PAUSE/RESUME must not clobber a part recorded during the control
// window (lost-update race — Fable audit) ──────────────────────────────────

describe("R2 — PAUSE state write must not clobber a concurrent chunk", () => {
	it("keeps a part recorded during the pause-control window (no stale-snapshot rollback)", async () => {
		const { chrome, captured } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-r2",
			uploadId: "upload-r2",
			startedAt: Date.now(),
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
			nextPartNumber: 2,
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
			mime: "video/webm",
			paused: false,
		});

		// Simulate handleChunk landing a new part (part 2) DURING the PAUSE control
		// send — the exact window in which the old code re-wrote a stale snapshot.
		// No recorderTabId/contentRecorderTabId → PAUSE routes to sendToOffscreen,
		// which calls chrome.runtime.sendMessage(msg, cb); override it to inject.
		// chrome.runtime.sendMessage is used two ways here: sendToOffscreen uses
		// the (message, callback) form; broadcastState (inside every setState) uses
		// the promise form and calls .catch on the result. Support BOTH.
		let injected = false;
		const injectPartOnPause = async (msg: { type?: string }) => {
			if (msg?.type === "PAUSE_CAPTURE" && !injected) {
				injected = true;
				const s = await getState();
				if (s.kind === "recording") {
					await setState({
						...s,
						parts: [...s.parts, { PartNumber: 2, ETag: '"e2"' }],
						nextPartNumber: 3,
						uploadedBytes: s.uploadedBytes + MIN_PART_SIZE,
					});
				}
			}
		};
		chrome.runtime.sendMessage = ((message: unknown, callback?: unknown) => {
			const msg = message as { type?: string };
			if (typeof callback === "function") {
				void injectPartOnPause(msg).then(() =>
					(callback as (r: unknown) => void)(undefined),
				);
				return undefined;
			}
			return Promise.resolve(undefined);
		}) as typeof chrome.runtime.sendMessage;

		await sendMessage(captured, { type: "PAUSE" });

		const final = await getState();
		expect(final.kind).toBe("recording");
		if (final.kind === "recording") {
			expect(final.paused).toBe(true);
			const partNums = final.parts.map((p) => p.PartNumber);
			// The bug: the stale snapshot rolled parts back to [1] and nextPartNumber
			// to 2, so the concurrently-recorded part 2 was dropped and its number
			// reused — overwriting 5 MiB in R2.
			expect(partNums).toContain(2);
			expect(partNums).toContain(1);
			expect(final.nextPartNumber).toBe(3);
		}
	});
});
