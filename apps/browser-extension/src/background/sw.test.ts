import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_PART_SIZE, PART_MAX_ATTEMPTS, RETRY_ALARM_NAME } from "./upload";

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
	sender: unknown = {},
): Promise<unknown> {
	return new Promise((resolve) => {
		if (!captured.message) throw new Error("onMessage listener not captured");
		captured.message(message, sender, resolve);
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

// ── Fix 3: onStartup's "finishing" resume must release START_INSTRUCTION
// immediately — never hold the availability lock behind the retry drain ────
//
// Awaiting the resume chain held "finishing" (isInProgress() === true) until
// resumeInterruptedFinishing AND whatever was already ahead of it on
// recorderQueue (the overdue retry alarm's drain, which exists precisely
// because the queue is non-empty) both finished. Measured: the extension
// refused to record a meeting right after its own restart. `resumed` is now a
// pure predicate computed synchronously, and the queue WRITE is fire-and-forget
// — so the state releases immediately while the queue write still lands.

describe("Fix 3 — startup 'finishing' resume must not hold the availability lock behind the retry drain", () => {
	it("answers START_INSTRUCTION ok:true immediately after restart even while the overdue alarm's drain is still in flight, and still queues the interrupted upload's complete", async () => {
		const { captured, storage } = await freshSw();
		const { setState, getState } = await import("./state");

		// Crashed mid-completeMultipart: every byte is in R2, only the finalize
		// call is left.
		await setState({
			kind: "finishing",
			videoId: "vid-fix3",
			uploadId: "upload-fix3",
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
		});

		// A non-empty retry queue from an earlier, unrelated interruption — the
		// overdue alarm exists precisely BECAUSE the queue is non-empty
		// (setRetryQueue's alarm-lifecycle invariant), and at a real restart it
		// fires around the same moment as onStartup.
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 1,
						videoId: "vid-earlier-fix3",
						uploadId: "upload-earlier-fix3",
						partDataBase64: Buffer.from("earlier-bytes").toString("base64"),
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000, // already due
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
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-earlier"' },
					});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		// Deterministically gate the FIRST capExtRetryQueue read — whichever of
		// {the alarm's retryPendingUploads, the finishing branch's
		// resumeInterruptedFinishing} reaches it first — so the recorderQueue
		// chain is PROVABLY still draining when START_INSTRUCTION is checked,
		// exactly like a real restart where the overdue alarm and onStartup both
		// fire around the same moment (same technique as the P1.5 test above).
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

		expect(captured.alarm).toBeDefined();
		expect(captured.startup).toBeDefined();
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		const startupPromise = captured.startup?.();

		// Let the synchronous/microtask portion of both handlers run. Everything
		// resolvable without the gate (including, in the fixed version, the
		// "finishing" branch's own state release) completes here; the gated read
		// keeps the recorderQueue chain itself parked on `gate`.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const resp = (await sendMessage(captured, {
			type: "START_INSTRUCTION",
		})) as { ok: boolean; error?: string };

		// The bug: with the awaited version, state was still "finishing" here and
		// this answered "A recording is already in progress" — the extension
		// refused to record a meeting immediately after its own restart.
		expect(resp.ok).toBe(true);

		gateRelease?.();
		await startupPromise;
		await flushAsync();

		// The whole point of F3: the interrupted upload's "complete" still gets
		// queued durably, even though the state release no longer waits for it.
		const finalQueue =
			(storage.store.get(RETRY_QUEUE_KEY) as Array<{
				kind: string;
				payload: Record<string, unknown>;
			}>) ?? [];
		expect(
			finalQueue.some(
				(item) =>
					item.kind === "complete" &&
					item.payload.videoId === "vid-fix3" &&
					item.payload.uploadId === "upload-fix3",
			),
		).toBe(true);
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

// ── Guaranteed client audio must survive a cleared "arming" record ─────────
//
// The "this is a meeting, client audio is REQUIRED" guarantee used to live
// ONLY in the volatile SW "arming" state record. An ordinary user gesture —
// picker cancel, error→RETRY, or even ANY OTHER recorder.html tab's
// beforeunload — fires INSTRUCTION_CANCEL, which resets arming to idle with
// no sender check. REQUEST_TAB_AUDIO / RECORDER_STARTED then re-read
// `required`/sourceTabId from that (now-idle) arming record, so the very next
// attempt silently downgrades to mic-only with NO error — indistinguishable
// from a plain non-meeting screen recording. The fix makes the guarantee
// travel with the recorder TAB itself (parsed once from its own URL, resent
// on every message) instead of with arming's volatile lifetime.

describe("Guaranteed client audio survives a cleared arming record", () => {
	const MEET_TAB_ID = 42;
	const MEET_URL = "https://meet.google.com/abc-defg-hij";
	const RECORDER_SENDER = {
		tab: { id: 1 },
		url: "chrome-extension://fake/recorder.html?source=42&meeting=1",
	};

	it("REQUEST_TAB_AUDIO after INSTRUCTION_CANCEL still returns required:true and a real streamId (RED on the pre-fix arming-only design)", async () => {
		const { chrome, captured } = await freshSw();
		chrome.tabs.get = (async (id: number) => ({
			id,
			url: MEET_URL,
		})) as unknown as typeof chrome.tabs.get;

		const startResp = (await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: MEET_TAB_ID,
			meeting: true,
		})) as { ok: boolean };
		expect(startResp.ok).toBe(true);

		// Picker cancel / error-retry / another tab's beforeunload — any of
		// these fires INSTRUCTION_CANCEL and used to wipe the guarantee.
		await sendMessage(captured, { type: "INSTRUCTION_CANCEL" });

		// The SECOND attempt: the recorder tab (recorderTabId=1, from the fake
		// chrome.tabs.create) asks for tab audio again, carrying its own
		// guarantee fields on the message instead of trusting the now-idle
		// arming state.
		const resp = (await sendMessage(
			captured,
			{ type: "REQUEST_TAB_AUDIO", sourceTabId: MEET_TAB_ID, meeting: true },
			RECORDER_SENDER,
		)) as { streamId: string | null; required: boolean };

		// The bug: today this returns { streamId: null, required: false } —
		// indistinguishable from a plain non-meeting screen recording, so the
		// recorder silently mixes no tab audio and shows only the soft
		// mic-only banner instead of the fail-visible confirm/liveness gate.
		expect(resp.required).toBe(true);
		expect(resp.streamId).not.toBeNull();
	});

	it("a source tab that is not a Meet URL fails VISIBLE (required stays true) instead of silently downgrading", async () => {
		const { chrome, captured } = await freshSw();
		chrome.tabs.get = (async () => ({
			url: "https://example.com/not-a-meet",
		})) as unknown as typeof chrome.tabs.get;

		await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: MEET_TAB_ID,
			meeting: true,
		});

		const resp = (await sendMessage(
			captured,
			{ type: "REQUEST_TAB_AUDIO", sourceTabId: MEET_TAB_ID, meeting: true },
			RECORDER_SENDER,
		)) as { streamId: string | null; required: boolean };

		expect(resp.required).toBe(true);
		expect(resp.streamId).toBeNull();
	});

	it("REQUEST_TAB_AUDIO from a non-extension sender (e.g. a Meet content script) is refused even with meeting:true in the message", async () => {
		const { chrome, captured } = await freshSw();
		chrome.tabs.get = (async () => ({ url: MEET_URL })) as unknown as typeof chrome.tabs.get;

		await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: MEET_TAB_ID,
			meeting: true,
		});

		// A content script's sender.url is the WEB PAGE's URL, not an extension
		// page — this must not be trusted to assert the guarantee.
		const untrustedSender = { tab: { id: 1 }, url: MEET_URL };
		const resp = (await sendMessage(
			captured,
			{ type: "REQUEST_TAB_AUDIO", sourceTabId: MEET_TAB_ID, meeting: true },
			untrustedSender,
		)) as { streamId: string | null; required: boolean };

		expect(resp.streamId).toBeNull();
		expect(resp.required).toBe(false);
	});

	it("RECORDER_STARTED after a cleared arming still persists meetingRequired and sourceTabId (keeps the mid-recording watchdogs alive)", async () => {
		const { chrome, captured } = await freshSw();
		chrome.tabs.get = (async () => ({ url: MEET_URL })) as unknown as typeof chrome.tabs.get;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/desktop/video/create")) {
					return jsonResponse({ id: "vid-guarantee" });
				}
				if (url.includes("/api/upload/multipart/initiate")) {
					return jsonResponse({ uploadId: "upload-guarantee" });
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: MEET_TAB_ID,
			meeting: true,
		});
		await sendMessage(captured, { type: "INSTRUCTION_CANCEL" });

		const resp = (await sendMessage(
			captured,
			{
				type: "RECORDER_STARTED",
				mime: "video/webm",
				hasVideo: true,
				hasAudio: true,
				sourceTabId: MEET_TAB_ID,
				meeting: true,
			},
			RECORDER_SENDER,
		)) as { ok: boolean };
		expect(resp.ok).toBe(true);

		const { getState } = await import("./state");
		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			expect(state.sourceTabId).toBe(MEET_TAB_ID);
			expect(state.meetingRequired).toBe(true);
			// recorderTabId must ALSO survive the cleared arming. Without it the
			// meet-ended notification's stop button sends no STOP_CAPTURE while still
			// setting intentionalStop (recording runs on, degraded-audio warnings
			// muted), and the tabs.onRemoved finalize fallback never matches - so
			// closing the recorder tab strands the state in "recording", where the
			// user's natural next move, CANCEL, destroys the uploaded parts.
			expect(state.recorderTabId).toBe(RECORDER_SENDER.tab?.id);
		}
	});

	it("the intact-arming happy path (no cancel/retry in between) is unchanged", async () => {
		const { chrome, captured } = await freshSw();
		chrome.tabs.get = (async () => ({ url: MEET_URL })) as unknown as typeof chrome.tabs.get;

		await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: MEET_TAB_ID,
			meeting: true,
		});

		const resp = (await sendMessage(
			captured,
			{ type: "REQUEST_TAB_AUDIO", sourceTabId: MEET_TAB_ID, meeting: true },
			RECORDER_SENDER,
		)) as { streamId: string | null; required: boolean };

		expect(resp.required).toBe(true);
		expect(resp.streamId).not.toBeNull();
	});
});

// ── Adversarial audit F1-F4: "a meeting must NEVER fail to record" ─────────
//
// Four proved holes in the core guarantee. Each test below drives the REAL
// handlers and fails on the pre-fix code.

/** The offscreen document has no sender.tab at all — that absence is what
 * distinguishes it from a recorder.html tab in the F1 ownership check. */
const OFFSCREEN_SENDER = { url: "chrome-extension://fake/offscreen.html" };

/** A live "Record Meet tab only" (offscreen path) meeting recording. The
 * offscreen document owns the capture, so there is no recorderTabId. */
function liveMeetingRecording() {
	return {
		kind: "recording" as const,
		mode: "meeting" as const,
		videoId: "vid-live-meeting",
		uploadId: "upload-live-meeting",
		startedAt: Date.now(),
		parts: [{ PartNumber: 1, ETag: "etag-1" }],
		nextPartNumber: 2,
		totalBytes: MIN_PART_SIZE,
		uploadedBytes: MIN_PART_SIZE,
		meetingId: "meet-abc",
		mime: "video/webm",
		paused: false,
	};
}

describe("F1 — RECORDER_STARTED must not overwrite a live recording", () => {
	/** Counts the calls that would MINT a second video/multipart on top of the
	 * live one — the act that orphans the running meeting's uploaded parts. */
	function stubInitializeUploadFetch() {
		let createCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/api/desktop/video/create")) {
				createCalls += 1;
				return jsonResponse({ id: "vid-hijack" });
			}
			if (url.includes("/api/upload/multipart/initiate")) {
				return jsonResponse({ uploadId: "upload-hijack" });
			}
			throw new Error(`Unhandled fetch in test: ${url}`);
		});
		return () => createCalls;
	}

	it("refuses a stale idle recorder tab's start while a meeting is recording (the meeting's parts are never orphaned)", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");
		await setState(liveMeetingRecording());
		const getCreateCalls = stubInitializeUploadFetch();

		// The leftover recorder.html tab. It sits at the idle view with "Choose
		// screen & start" ENABLED for the whole of an offscreen-path recording
		// (recorder-page.ts handleStateChange had no "recording" case at all),
		// so this is one ordinary click, not an exotic state.
		const resp = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			{ tab: { id: 7 }, url: "chrome-extension://fake/recorder.html" },
		)) as { ok: boolean };

		expect(resp.ok).toBe(false);
		// A second video/multipart must never even be minted: the live meeting's
		// already-uploaded parts would be orphaned forever, its multipart never
		// completed, with no error and no notification.
		expect(getCreateCalls()).toBe(0);

		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			expect(state.videoId).toBe("vid-live-meeting");
			expect(state.uploadId).toBe("upload-live-meeting");
		}
	});

	it("keeps the still-running meeting's chunks in ITS upload instead of interleaving them into a hijacked one", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");
		await setState(liveMeetingRecording());
		stubInitializeUploadFetch();

		await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			{ tab: { id: 7 }, url: "chrome-extension://fake/recorder.html" },
		);

		// The meeting recorder is still running and keeps emitting. handleChunk
		// only checks kind === "recording", so after a successful hijack these
		// bytes land in the NEW upload's buffer — two MediaRecorder streams
		// interleaved into one object: old meeting lost AND new video corrupt.
		const LATE = 4096;
		await sendMessage(captured, {
			type: "RECORDER_CHUNK",
			chunk: Array.from(new Uint8Array(LATE)),
			index: 5,
			mime: "video/webm",
		});

		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			expect(state.videoId).toBe("vid-live-meeting");
			expect(state.totalBytes).toBe(MIN_PART_SIZE + LATE);
		}
	});

	it("still accepts the normal start: the offscreen document reporting against an 'arming' state", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");
		await setState({ kind: "arming", mode: "meeting", meetingId: "meet-ok" });
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/api/desktop/video/create")) {
				return jsonResponse({ id: "vid-normal" });
			}
			if (url.includes("/api/upload/multipart/initiate")) {
				return jsonResponse({ uploadId: "upload-normal" });
			}
			throw new Error(`Unhandled fetch in test: ${url}`);
		});

		const resp = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			OFFSCREEN_SENDER,
		)) as { ok: boolean };

		// "arming" is not isInProgress(), so the guard never even looks at the
		// sender here — both legitimate senders keep working unchanged.
		expect(resp.ok).toBe(true);
		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") expect(state.videoId).toBe("vid-normal");
	});

	it("STRICT: refuses even the recording's OWN recorder tab re-sending RECORDER_STARTED — no legitimate mid-recording re-send exists", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");
		await setState({ ...liveMeetingRecording(), recorderTabId: 5 });
		const getCreateCalls = stubInitializeUploadFetch();

		// An earlier version tried to admit "the recording's own recorder tab"
		// (sender tab id === state.recorderTabId), but the ownership test
		// collapsed to `undefined === undefined` for every sender failing the
		// extension-origin check — on the offscreen path (recorderTabId is also
		// undefined there) that admitted content scripts and the popup, i.e. the
		// exact hijack this guard exists to stop. Closing the hole costs nothing:
		// both legitimate senders (offscreen/recorder.ts, recorder-page.ts) fire
		// RECORDER_STARTED exactly once, inside their own start function, right
		// before recorder.start() — no legitimate mid-recording re-send exists,
		// from the owning tab or anyone else. And legitimate starts never even
		// reach this guard: isInProgress() deliberately excludes "arming", and
		// the cancel→RETRY / error→"Try again" paths always begin from
		// "idle"/"error" — by the time a genuine RECORDER_STARTED lands, state is
		// "arming", not "recording".
		const owner = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			{ tab: { id: 5 }, url: "chrome-extension://fake/recorder.html" },
		)) as { ok: boolean; error?: string };
		expect(owner.ok).toBe(false);
		expect(owner.error).toMatch(/already in progress/);
		expect(getCreateCalls()).toBe(0);

		// Any OTHER tab is refused identically — the rule is uniform, not
		// sender-dependent.
		const stranger = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			{ tab: { id: 6 }, url: "chrome-extension://fake/recorder.html" },
		)) as { ok: boolean };
		expect(stranger.ok).toBe(false);

		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			expect(state.videoId).toBe("vid-live-meeting");
		}
	});
});

describe("F2 — the finalize tail stays durable until it is safely uploaded", () => {
	it("keeps pendingBuffer on disk while the remainder PUT is in flight (an eviction mid-PUT must not lose the tail)", async () => {
		const { captured, storage } = await freshSw();
		const { setState } = await import("./state");

		await setState({
			kind: "recording",
			mode: "meeting",
			videoId: "vid-tail",
			uploadId: "upload-tail",
			startedAt: Date.now(),
			parts: [{ PartNumber: 1, ETag: "etag-1" }],
			nextPartNumber: 2,
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
			mime: "video/webm",
			paused: false,
		});

		// A sub-part-size tail: it stays in the in-memory buffer, is persisted to
		// pendingBuffer:<uploadId>, and is only ever uploaded by finalizeUpload.
		const TAIL = 4096;
		await sendMessage(captured, {
			type: "RECORDER_CHUNK",
			chunk: Array.from(new Uint8Array(TAIL)),
			index: 0,
			mime: "video/webm",
		});
		const PENDING_KEY = "pendingBuffer:upload-tail";
		expect(storage.store.has(PENDING_KEY)).toBe(true);

		let pendingPresentDuringTailPut: boolean | undefined;
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
					// The remainder is on the wire RIGHT NOW. If the SW were evicted
					// (or the browser died) at this instant — stopping on bad WiFi —
					// the ONLY surviving copy of these bytes is the pending-buffer
					// record. Clearing it BEFORE this point let a respawn's
					// finalizeUpload find state "uploading" with an empty buffer,
					// pass the viability check on uploadedBytes alone, and complete
					// the multipart without the tail: "complete", share link issued,
					// the meeting's last seconds silently gone.
					pendingPresentDuringTailPut = storage.store.has(PENDING_KEY);
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-tail"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					return jsonResponse({ success: true, fileKey: "file" });
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await sendMessage(captured, { type: "RECORDER_STOPPED" });
		await flushAsync();

		expect(pendingPresentDuringTailPut).toBe(true);
		// ...and it must still be cleaned up once the tail is durable elsewhere,
		// so it can never leak or be re-uploaded on a later respawn.
		expect(storage.store.has(PENDING_KEY)).toBe(false);
	});
});

describe("F3 — startup finishing-resume must not race the retry drain", () => {
	it("re-queues the interrupted 'complete' without a concurrent alarm drain clobbering it (the multipart really completes)", async () => {
		const { captured, storage } = await freshSw();
		const { setState, getState } = await import("./state");

		await setState({
			kind: "finishing",
			videoId: "vid-fin",
			uploadId: "upload-fin",
			parts: [{ PartNumber: 1, ETag: "etag-1" }],
		});

		// A persisted, already-overdue retry alarm fires at browser startup too —
		// and the alarm exists precisely when the queue is non-empty, which is
		// exactly the situation a crashed finalize leaves behind.
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 1,
						videoId: "vid-other",
						uploadId: "upload-other",
						partDataBase64: Buffer.from("other-part-bytes").toString("base64"),
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		let completeCallsForFin = 0;
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
						headers: { ETag: '"etag-other"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					const body = JSON.parse(String(init?.body)) as { uploadId?: string };
					if (body.uploadId === "upload-fin") completeCallsForFin += 1;
					return jsonResponse({ success: true, fileKey: "file" });
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		// Deterministically force the interleave rather than hoping for it: park
		// the FIRST capExtRetryQueue read (the alarm drain's getRetryQueue) until
		// AFTER the startup resume has read-modify-written the SAME key. The
		// drain then writes back its stale snapshot — the classic lost update —
		// unless the two are actually serialized through the one FIFO chain.
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

		expect(captured.alarm).toBeDefined();
		captured.alarm?.({ name: "cap-retry-queue" });
		const startupPromise = captured.startup?.();
		await new Promise((resolve) => setTimeout(resolve, 0));
		gateRelease?.();
		await startupPromise;
		await flushAsync();

		// The re-queued "complete" must have survived the drain's write-back.
		const queue =
			(storage.store.get(RETRY_QUEUE_KEY) as Array<{
				kind: string;
				payload: Record<string, unknown>;
				nextRetryAt: number;
			}>) ?? [];
		expect(
			queue.some(
				(item) => item.kind === "complete" && item.payload.uploadId === "upload-fin",
			),
		).toBe(true);

		// ...and it must actually finish the recording once due, so the state's
		// "we're completing it in the background" is a promise with something
		// behind it instead of every byte sitting in R2 uncompleted forever.
		for (const item of queue) {
			item.nextRetryAt = Date.now() - 1000;
		}
		await storage.set({ [RETRY_QUEUE_KEY]: queue });
		captured.alarm?.({ name: "cap-retry-queue" });
		await flushAsync();

		expect(completeCallsForFin).toBe(1);
		expect((await getState()).kind).toBe("complete");
	});
});

describe("F4 — an idle recorder tab must not answer a broadcast STOP", () => {
	it("does not emit a spurious RECORDER_STOPPED that finalizes before the offscreen document has flushed its final chunks", async () => {
		const { chrome, captured } = await freshSw();
		const { setState, getState } = await import("./state");
		const swOnMessage = captured.message;
		expect(swOnMessage).toBeDefined();

		// Load the REAL recorder page in this same fake-chrome world: a leftover
		// recorder.html tab that never started a capture, so its `state` is null.
		// (Every DOM lookup in the page is null-safe, so a stub this thin is
		// enough to exercise its message handling.)
		vi.stubGlobal("document", { getElementById: () => null });
		vi.stubGlobal("window", { addEventListener: () => undefined });
		vi.stubGlobal("location", { search: "" });
		// Imported through a variable specifier: recorder-page.ts has no
		// top-level import/export, so TypeScript classes it as a global script
		// rather than a module and rejects a literal `import()` of it (TS2306).
		// The runtime import is identical either way.
		const recorderPagePath = "../recorder/recorder-page";
		await import(recorderPagePath);
		const pageOnMessage = captured.message;
		expect(pageOnMessage).not.toBe(swOnMessage);

		// chrome.runtime.sendMessage BROADCASTS to every extension context — that
		// is exactly how the SW's sendToOffscreen reaches a stale recorder tab.
		chrome.runtime.sendMessage = ((
			message: unknown,
			cb?: (r: unknown) => void,
		) => {
			pageOnMessage?.(message, {}, () => undefined);
			const swReply = new Promise((resolve) => {
				swOnMessage?.(message, OFFSCREEN_SENDER, resolve);
			});
			if (typeof cb === "function") swReply.then(cb);
			return swReply;
		}) as unknown as typeof chrome.runtime.sendMessage;

		await setState({ ...liveMeetingRecording(), videoId: "vid-f4", uploadId: "upload-f4" });
		let completedParts = 0;
		stubFinalizeFetch((n) => {
			completedParts = n;
		});

		// The popup's STOP for the offscreen path.
		await new Promise((resolve) => swOnMessage?.({ type: "STOP" }, {}, resolve));
		await flushAsync();

		// The offscreen document has NOT reported its stop yet — a real
		// MediaRecorder still has to flush its final chunks asynchronously. The
		// SW must therefore still be recording. The stale tab answering for it
		// used to win this race and finalize here.
		const afterStop = await getState();
		expect(afterStop.kind).toBe("recording");

		// The real final flush: ~200-400ms of meeting that used to be silently
		// excluded from the upload on EVERY offscreen-path stop.
		const LATE = 4096;
		await new Promise((resolve) =>
			swOnMessage?.(
				{
					type: "RECORDER_CHUNK",
					chunk: Array.from(new Uint8Array(LATE)),
					index: 1,
					mime: "video/webm",
				},
				OFFSCREEN_SENDER,
				resolve,
			),
		);
		const afterLateChunk = await getState();
		expect(afterLateChunk.kind).toBe("recording");
		if (afterLateChunk.kind === "recording") {
			expect(afterLateChunk.totalBytes).toBe(MIN_PART_SIZE + LATE);
		}

		// Now the offscreen document's genuine stop.
		await new Promise((resolve) =>
			swOnMessage?.({ type: "RECORDER_STOPPED" }, OFFSCREEN_SENDER, resolve),
		);
		await flushAsync();

		expect((await getState()).kind).toBe("complete");
		// The flushed tail became its own part — the recording is whole.
		expect(completedParts).toBe(2);
	});
});

// ── Fix 1: the idle recorder tab's STOP_CAPTURE ack must be conditional too,
// or a dead offscreen document's stop is falsely reported as delivered ──────
//
// F4 (above) proves the idle tab must not WIN the race against a still-live
// offscreen stop. This proves the other half: when the offscreen document is
// truly DEAD (crashed / never created) and the only OTHER listener on the
// broadcast is an idle recorder tab, that tab's ack must not manufacture a
// false "delivered" — otherwise sendControlWithRetry never sees a failure, R8's
// dead-offscreen fallback never fires, and NOTHING ever finalizes the
// recording: state stuck "recording" forever, multipart never completed, and
// the user's natural next move (CANCEL) destroys the recovery data.

describe("Fix 1 — dead offscreen + idle recorder tab: STOP must still finalize via R8", () => {
	it("does not let a silent idle recorder tab manufacture a false STOP_CAPTURE delivery when the real offscreen document never answers", async () => {
		const { chrome, captured } = await freshSw();
		const { setState, getState } = await import("./state");
		// Capture the SW's OWN listener BEFORE importing recorder-page.ts below —
		// that import calls chrome.runtime.onMessage.addListener again and
		// OVERWRITES captured.message with the page's listener (see F4 above).
		const swOnMessage = captured.message;
		expect(swOnMessage).toBeDefined();

		await setState({
			...liveMeetingRecording(),
			videoId: "vid-fix1",
			uploadId: "upload-fix1",
		});

		// A leftover recorder.html tab sitting idle — the same leftover tab from
		// F1/F4, present for the whole of an offscreen-path meeting recording.
		vi.stubGlobal("document", { getElementById: () => null });
		vi.stubGlobal("window", { addEventListener: () => undefined });
		vi.stubGlobal("location", { search: "" });
		const recorderPagePath = "../recorder/recorder-page";
		await import(recorderPagePath);
		const pageOnMessage = captured.message;
		expect(pageOnMessage).not.toBe(swOnMessage);

		// chrome.runtime.sendMessage BROADCASTS to every extension context. The
		// real offscreen document is DEAD here — it has no listener at all in
		// this fake world — so the idle recorder tab is the ONLY one that could
		// possibly answer. If it stays silent (the fix), nobody answers at all,
		// matching real Chrome's "every listener closed unanswered" → lastError.
		// If it still acks (the bug), the send falsely resolves as delivered.
		chrome.runtime.sendMessage = ((
			message: unknown,
			cb?: (r: unknown) => void,
		) => {
			let answered = false;
			pageOnMessage?.(message, {}, (r: unknown) => {
				answered = true;
				cb?.(r);
			});
			if (!answered) {
				chrome.runtime.lastError = {
					message:
						"Could not establish connection. Receiving end does not exist.",
				};
				cb?.(undefined);
				chrome.runtime.lastError = undefined;
			}
			return Promise.resolve(undefined);
		}) as unknown as typeof chrome.runtime.sendMessage;

		const getCompleteCalls = stubFinalizeFetch();

		await new Promise((resolve) => swOnMessage?.({ type: "STOP" }, {}, resolve));
		await flushAsync();

		// The bug: an unconditional ack from the idle tab told sendControlWithRetry
		// the STOP was delivered, so R8's dead-offscreen fallback never fired —
		// nothing ever emitted RECORDER_STOPPED and the recording stayed
		// "recording" forever.
		const finalState = await getState();
		expect(finalState.kind).not.toBe("recording");
		expect(finalState.kind).toBe("complete");
		expect(getCompleteCalls()).toBe(1);
	});
});
