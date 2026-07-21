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
		tabUpdated: Array<
			(tabId: number, changeInfo: Record<string, unknown>) => void
		>;
	} = { tabUpdated: [] };

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
			onUpdated: {
				addListener: (fn: Listener) => {
					captured.tabUpdated.push(
						fn as (t: number, c: Record<string, unknown>) => void,
					);
				},
			},
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
		// Keyboard command (manifest `commands`) registered at sw.ts module scope
		// — needed only so importing the module doesn't throw; no test here
		// drives it.
		commands: {
			onCommand: { addListener: () => undefined },
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
			expect(finalState.reason).toMatch(/qisqa/i);
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

// ── R6-b: byte-carrying parts must get the FINALIZE retry horizon ──────────
//
// Independent audit (2026-07-19, PROVED with an executed attack): "part" items
// had a 30-attempt (~1.8 h) death clock while metadata-only finalize items got
// 400 (~28 h). In a sustained outage with the browser open, the pieces holding
// the recording's actual bytes dead-lettered FIRST — stranding a meeting whose
// bytes were 100% durable on disk, with an error telling the user to re-record
// a meeting that already happened. The bytes are durable; giving up on them
// early is never the right trade (the code's own R6 comment said so and then
// applied the long horizon only to the metadata item).
describe("R6-b — parts survive as long as finalize items", () => {
	it("does not dead-letter a queued part at an attempt count a finalize item would survive", async () => {
		const { captured, storage } = await freshSw();
		// The network is down for the whole test — every retry fails.
		vi.stubGlobal("fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 2,
						videoId: "vid-outage",
						uploadId: "up-outage",
						partDataBase64: Buffer.from("durable bytes").toString("base64"),
					},
					// Far past the OLD 30-attempt part horizon, well under the
					// 400-attempt finalize horizon a sibling "complete" would get.
					attempts: 350,
					nextRetryAt: Date.now() - 1,
				},
			],
		});

		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();

		const queue = (await storage.get(RETRY_QUEUE_KEY))[RETRY_QUEUE_KEY] as
			| Array<{ kind: string }>
			| undefined;
		expect(
			queue?.some((i) => i.kind === "part"),
			"the part was dead-lettered while its bytes were still durable on disk — byte-carrying parts must get the same horizon as the finalize items that depend on them",
		).toBe(true);
	});
});

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

// ── Wave 0: meeting filing must not leak into state.mode ────────────────────
//
// The bug: a full-screen guaranteed meeting recording (started via
// START_INSTRUCTION with meeting:true + meetingId, mode stays "instruction")
// used to reach initializeUpload as ("instruction", undefined) — mis-filed as
// a plain instruction recording (wrong extensionContext, wrong title, no
// meetingId) even though the CONTROL-FLOW discriminator (state.mode, which
// STOP/PAUSE/RESUME/CANCEL/tabs.onRemoved all branch on) correctly stayed
// "instruction" throughout. The fix derives the upload's filing from
// meetingRequired instead of mode, without changing mode itself.

describe("Wave 0 — meeting filing: initializeUpload gets meetingRequired, not state.mode", () => {
	it('full-screen guaranteed meeting (meetingRequired + meetingId) files as "meeting" while state.mode stays "instruction"', async () => {
		const { captured } = await freshSw();

		let createVideoUrl: URL | null = null;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/desktop/video/create")) {
					createVideoUrl = new URL(url);
					return jsonResponse({ id: "vid-meeting-filing" });
				}
				if (url.includes("/api/upload/multipart/initiate")) {
					return jsonResponse({ uploadId: "upload-meeting-filing" });
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		await sendMessage(captured, {
			type: "START_INSTRUCTION",
			sourceTabId: 42,
			meeting: true,
			meetingId: "abc-defg-hij",
		});

		const resp = (await sendMessage(
			captured,
			{
				type: "RECORDER_STARTED",
				mime: "video/webm",
				hasVideo: true,
				hasAudio: true,
				sourceTabId: 42,
				meeting: true,
				meetingId: "abc-defg-hij",
			},
			{
				tab: { id: 1 },
				url: "chrome-extension://fake/recorder.html?source=42&meeting=1&meetingId=abc-defg-hij",
			},
		)) as { ok: boolean };
		expect(resp.ok).toBe(true);

		// initializeUpload("meeting", "abc-defg-hij") — asserted via the actual
		// createVideo request it produces (the real seam; initializeUpload
		// itself isn't separately mockable from here).
		expect(createVideoUrl).not.toBeNull();
		expect(createVideoUrl!.searchParams.get("extensionContext")).toBe("meeting");
		expect(createVideoUrl!.searchParams.get("meetingId")).toBe("abc-defg-hij");

		const { getState } = await import("./state");
		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			// THE regression guard: filing is "meeting", but the control-flow
			// discriminator never changed.
			expect(state.mode).toBe("instruction");
			expect(state.meetingRequired).toBe(true);
			expect(state.meetingId).toBe("abc-defg-hij");
		}
	});

	it('plain non-Meet instruction recording files as "instruction" with no meetingId', async () => {
		const { captured } = await freshSw();

		let createVideoUrl: URL | null = null;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/desktop/video/create")) {
					createVideoUrl = new URL(url);
					return jsonResponse({ id: "vid-plain-instruction" });
				}
				if (url.includes("/api/upload/multipart/initiate")) {
					return jsonResponse({ uploadId: "upload-plain-instruction" });
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		// The popup's "Record screen" button on a non-Meet tab sends bare
		// START_INSTRUCTION — no sourceTabId/meeting/meetingId at all.
		await sendMessage(captured, { type: "START_INSTRUCTION" });

		const resp = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm", hasVideo: true, hasAudio: true },
			{ tab: { id: 1 }, url: "chrome-extension://fake/recorder.html" },
		)) as { ok: boolean };
		expect(resp.ok).toBe(true);

		// initializeUpload("instruction", undefined).
		expect(createVideoUrl).not.toBeNull();
		expect(createVideoUrl!.searchParams.get("extensionContext")).toBe("instruction");
		expect(createVideoUrl!.searchParams.has("meetingId")).toBe(false);

		const { getState } = await import("./state");
		const state = await getState();
		expect(state.kind).toBe("recording");
		if (state.kind === "recording") {
			expect(state.mode).toBe("instruction");
			expect(state.meetingRequired).toBeFalsy();
		}
	});

	it("STOP still routes to the recorder tab (never the offscreen broadcast) for an active guaranteed-meeting recording — the meeting flag must not leak into control-flow routing", async () => {
		const { chrome, captured } = await freshSw();
		const { setState } = await import("./state");

		const RECORDER_TAB_ID = 77;
		await setState({
			kind: "recording",
			mode: "instruction",
			meetingRequired: true,
			meetingId: "abc-defg-hij",
			sourceTabId: 42,
			recorderTabId: RECORDER_TAB_ID,
			videoId: "vid-routing",
			uploadId: "upload-routing",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		const tabsSendMessageCalls: Array<{ tabId: number; message: unknown }> = [];
		chrome.tabs.sendMessage = (async (tabId: number, message: unknown) => {
			tabsSendMessageCalls.push({ tabId, message });
			return undefined;
		}) as typeof chrome.tabs.sendMessage;

		let offscreenStopBroadcasts = 0;
		chrome.runtime.sendMessage = ((message: unknown, callback?: unknown) => {
			const msg = message as { type?: string } | undefined;
			if (msg?.type === "STOP_CAPTURE") offscreenStopBroadcasts += 1;
			if (typeof callback === "function") {
				(callback as (r: unknown) => void)(undefined);
				return undefined;
			}
			return Promise.resolve(undefined);
		}) as typeof chrome.runtime.sendMessage;

		await sendMessage(captured, { type: "STOP" });
		await flushAsync();

		expect(tabsSendMessageCalls).toHaveLength(1);
		expect(tabsSendMessageCalls[0].tabId).toBe(RECORDER_TAB_ID);
		expect(tabsSendMessageCalls[0].message).toEqual({ type: "STOP_CAPTURE" });
		expect(offscreenStopBroadcasts).toBe(0);
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
		expect(owner.error).toMatch(/allaqachon davom etmoqda/);
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

// ── HIGH #2: "Cancel upload" was a false promise ───────────────────────────
//
// The uploading view's only action used to be "Cancel upload", which set state
// to idle and called abortUpload — and abortUpload only forgets the LOCAL
// buffer. Nothing aborted the server-side multipart, nothing cleared that
// upload's queued retries or dead letters, and nothing deleted an object whose
// multipart had already completed. The user was told it was cancelled while
// orphan parts piled up in R2 and hidden retries kept running.

const DEAD_LETTER_KEY = "capExtDeadLetterQueue";

function uploadingState(videoId: string, uploadId: string) {
	return {
		kind: "uploading" as const,
		videoId,
		uploadId,
		parts: [{ ETag: "etag-1", PartNumber: 1 }],
		totalBytes: MIN_PART_SIZE,
		uploadedBytes: MIN_PART_SIZE,
	};
}

function partItem(videoId: string, uploadId: string, partNumber: number) {
	return {
		kind: "part",
		payload: {
			partNumber,
			videoId,
			uploadId,
			partDataBase64: Buffer.from("bytes").toString("base64"),
		},
		attempts: 0,
		nextRetryAt: Date.now() + 60_000,
	};
}

/** Records every server call the discard makes. */
function stubDiscardFetch(opts: { failServer?: boolean } = {}) {
	const calls: Array<{ url: string; method: string; body?: string }> = [];
	vi.stubGlobal(
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (opts.failServer) return new Response("boom", { status: 500 });
			return jsonResponse({ success: true });
		},
	);
	return calls;
}

describe('HIGH #2 — "permanently discard" actually discards', () => {
	it("aborts the server multipart, deletes the video, and clears queued + dead-lettered work for that upload", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-discard", "upload-discard"));

		// Work belonging to THIS upload (must go) alongside an unrelated
		// recording's work (must survive — discarding one recording must never
		// take another one's durable bytes with it).
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				partItem("vid-discard", "upload-discard", 2),
				{
					kind: "recording-complete",
					payload: { videoId: "vid-discard" },
					attempts: 0,
					nextRetryAt: Date.now() + 60_000,
				},
				partItem("vid-other", "upload-other", 1),
			],
			[DEAD_LETTER_KEY]: [
				partItem("vid-discard", "upload-discard", 3),
				partItem("vid-other", "upload-other", 2),
			],
		});

		const calls = stubDiscardFetch();
		await sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		const abort = calls.find((c) =>
			c.url.includes("/api/upload/multipart/abort"),
		);
		expect(abort, "no multipart abort was sent").toBeDefined();
		expect(abort?.method).toBe("POST");
		expect(JSON.parse(abort?.body ?? "{}")).toMatchObject({
			uploadId: "upload-discard",
			videoId: "vid-discard",
		});

		const del = calls.find((c) => c.url.includes("/api/video/delete-permanent"));
		expect(del, "the video was never deleted").toBeDefined();
		expect(del?.method).toBe("DELETE");
		expect(del?.url).toContain("videoId=vid-discard");

		const queue = (await storage.get(RETRY_QUEUE_KEY))[RETRY_QUEUE_KEY] as
			| Array<{ payload: { videoId: string } }>
			| undefined;
		expect(queue?.map((i) => i.payload.videoId)).toEqual(["vid-other"]);

		const dead = (await storage.get(DEAD_LETTER_KEY))[DEAD_LETTER_KEY] as
			| Array<{ payload: { videoId: string } }>
			| undefined;
		expect(dead?.map((i) => i.payload.videoId)).toEqual(["vid-other"]);

		const { getState } = await import("./state");
		expect((await getState()).kind).toBe("idle");
	});

	it("does not claim the recording is gone when the server could not be reached", async () => {
		const { captured, setState, notifications } = await freshSw();
		await setState(uploadingState("vid-offline", "upload-offline"));

		stubDiscardFetch({ failServer: true });
		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			ok?: boolean;
			serverCleaned?: boolean;
		};
		await flushAsync();

		expect(res.serverCleaned).toBe(false);
		const note = notifications.find((n) => n.id === "discard-partial");
		expect(note, "no honest warning was surfaced").toBeDefined();
		expect(note?.message ?? "").toMatch(/ulanib bo'lmadi/i);
		// Copy must never claim more than it did.
		expect(`${note?.title} ${note?.message}`).not.toMatch(/deleted from/i);
	});

	// The common late discard: the multipart already completed, so there is
	// genuinely nothing to abort and S3 says so. Treating that as a failure
	// would warn the user their data might still be on the server when the
	// delete had in fact removed it.
	it("does not warn when the multipart was already completed (nothing to abort)", async () => {
		const { captured, setState, notifications } = await freshSw();
		await setState(uploadingState("vid-late", "upload-late"));

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/api/upload/multipart/abort")) {
					return new Response(
						JSON.stringify({
							error: "Failed to abort multipart upload",
							details: "NoSuchUpload: The specified upload does not exist.",
						}),
						{ status: 500 },
					);
				}
				return jsonResponse({ success: true });
			},
		);

		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			serverCleaned?: boolean;
		};
		await flushAsync();

		expect(res.serverCleaned).toBe(true);
		expect(notifications.find((n) => n.id === "discard-partial")).toBeUndefined();
	});

	// ── B2: the discard sequence must be ATOMIC and DURABLE ────────────────
	//
	// delete-permanent HARD-deletes the video row, and that row is the ownership
	// record the abort route authorizes against (it 404s once the row is gone —
	// which api.ts treats as success). So deleting the row after a FAILED abort
	// strands the multipart's parts in R2 forever AND makes every later abort
	// retry report a false success. The row must therefore be the LAST thing
	// removed, and only after storage-side cleanup fully succeeded.
	/** Fails ONLY the abort, with a body that does NOT contain "NoSuchUpload"
	 * (api.ts deliberately treats that string as success — using it here would
	 * make this test pass against broken code). */
	function stubAbortFailsFetch(state: { abortFails: boolean }) {
		const calls: Array<{ url: string; method: string; body?: string }> = [];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				calls.push({
					url,
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				if (url.includes("/api/upload/multipart/abort") && state.abortFails) {
					return new Response("upstream boom", { status: 500 });
				}
				return jsonResponse({ success: true });
			},
		);
		return calls;
	}

	type QueueItem = { kind: string; payload: Record<string, unknown> };

	async function readQueue(
		storage: ReturnType<typeof createFakeChrome>["storage"],
	): Promise<QueueItem[]> {
		return ((await storage.get(RETRY_QUEUE_KEY))[RETRY_QUEUE_KEY] ??
			[]) as QueueItem[];
	}

	it("when the multipart abort fails, the video row survives and the discard is queued for retry", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-abortfail", "upload-abortfail"));

		const calls = stubAbortFailsFetch({ abortFails: true });
		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			serverCleaned?: boolean;
		};
		await flushAsync();

		expect(
			calls.find((c) => c.url.includes("/api/video/delete-permanent")),
			"the ownership row was deleted even though the abort failed — a later abort retry can no longer authorize itself, so the multipart parts are unrecoverable",
		).toBeUndefined();

		const discards = (await readQueue(storage)).filter(
			(i) => i.kind === "discard",
		);
		expect(discards, "no durable discard retry was queued").toHaveLength(1);
		expect(discards[0]?.payload).toMatchObject({
			videoId: "vid-abortfail",
			uploadId: "upload-abortfail",
		});

		expect(res.serverCleaned).toBe(false);
	});

	// ── W3a: the discard must be durable BEFORE the network call ───────────
	//
	// The old code only queued the durable task AFTER a failure was observed. An
	// interruption DURING the request (before any failure is seen) then queued
	// nothing at all — the confidential recording sat in R2 forever with nothing
	// ever retrying. Prove the task is durable the instant the network attempt
	// begins, not after it returns.
	it("queues the durable discard BEFORE the network call, so an interruption mid-request is recoverable", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-midflight", "upload-midflight"));

		// The abort never resolves — this is the browser being interrupted
		// mid-request, before any failure is observed.
		let releaseAbort!: () => void;
		const abortHang = new Promise<void>((r) => {
			releaseAbort = r;
		});
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/api/upload/multipart/abort")) {
				await abortHang;
				return jsonResponse({ success: true });
			}
			return jsonResponse({ success: true });
		});

		// Fire the discard but do NOT await it — it is parked on the hung abort,
		// exactly where an interrupted browser would die.
		const discardResp = sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		const discards = (await readQueue(storage)).filter(
			(i) => i.kind === "discard",
		);
		expect(
			discards,
			"no durable discard was queued before the network attempt — an interruption here loses the cleanup forever",
		).toHaveLength(1);
		expect(discards[0]?.payload).toMatchObject({
			videoId: "vid-midflight",
			uploadId: "upload-midflight",
		});

		releaseAbort();
		await discardResp;
	});

	// ── W3b: startup must NOT resurrect a discarded recording ──────────────
	//
	// If the browser dies during the discard's server calls, state is still
	// "uploading" AND a durable discard task is queued. onStartup used to see
	// only the "uploading" state and run finalizeUpload — completing the
	// multipart and publishing a share link for a recording the user explicitly
	// destroyed. Startup must recognise the pending discard and finish the
	// destruction instead.
	it("onStartup does not resurrect a recording that has a pending discard", async () => {
		const { captured, storage, setState } = await freshSw();
		const { getState } = await import("./state");

		await setState(uploadingState("vid-killed", "upload-killed"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "discard",
					payload: { videoId: "vid-killed", uploadId: "upload-killed" },
					attempts: 0,
					nextRetryAt: Date.now() - 1,
				},
			],
		});

		const calls: Array<{ url: string; method: string }> = [];
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				calls.push({
					url: input.toString(),
					method: init?.method ?? "GET",
				});
				return jsonResponse({ success: true });
			},
		);

		await captured.startup?.();
		await flushAsync();

		expect(
			calls.find((c) => c.url.includes("/api/upload/multipart/complete")),
			"onStartup published (completed) a recording the user had discarded",
		).toBeUndefined();
		expect(
			(await getState()).kind,
			"a discarded recording came back as complete",
		).not.toBe("complete");
	});

	// ── W3a-strict: the marker must precede ANY destruction, local included ─
	//
	// Queuing the marker before the NETWORK call but after the LOCAL mutations
	// left a window where an interruption had already destroyed the pending
	// buffer and purged the queued parts, yet planted nothing durable — startup
	// then saw an ordinary in-progress upload and resurrected the recording.
	// Prove that at the instant either local destruction lands, the durable
	// discard marker is ALREADY in the queue.
	it("plants the durable discard before any local destruction, so no interruption window can orphan the cleanup", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-order", "upload-order"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [partItem("vid-order", "upload-order", 2)],
			"pendingBuffer:upload-order": Buffer.from("tail").toString("base64"),
		});

		stubDiscardFetch();

		const violations: string[] = [];
		const hasDiscardMarker = () => {
			const queue = (storage.store.get(RETRY_QUEUE_KEY) ?? []) as Array<{
				kind: string;
			}>;
			return queue.some((i) => i.kind === "discard");
		};
		const origRemove = storage.remove.bind(storage);
		storage.remove = async (key: string) => {
			if (key === "pendingBuffer:upload-order" && !hasDiscardMarker()) {
				violations.push(
					"pending buffer destroyed while no durable discard was queued",
				);
			}
			return origRemove(key);
		};
		const origSet = storage.set.bind(storage);
		storage.set = async (items: Record<string, unknown>) => {
			const next = items[RETRY_QUEUE_KEY] as
				| Array<{ kind: string; payload: { videoId?: string } }>
				| undefined;
			if (next) {
				const prev = (storage.store.get(RETRY_QUEUE_KEY) ?? []) as Array<{
					kind: string;
					payload: { videoId?: string };
				}>;
				const partGone =
					prev.some(
						(i) => i.kind === "part" && i.payload.videoId === "vid-order",
					) &&
					!next.some(
						(i) => i.kind === "part" && i.payload.videoId === "vid-order",
					);
				if (partGone && !next.some((i) => i.kind === "discard")) {
					violations.push(
						"queued part purged while no durable discard was queued",
					);
				}
			}
			return origSet(items);
		};

		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			serverCleaned?: boolean;
		};
		await flushAsync();

		expect(violations, violations.join("; ")).toEqual([]);
		expect(res.serverCleaned).toBe(true);
	});

	// ── W3b-2: startup also finishes the LOCAL half of a pending discard ───
	//
	// The marker is planted before the local cleanup, so a browser death in
	// between leaves the marker standing while the pending buffer and queued
	// part work survive. Startup must finish that local half — otherwise the
	// drain re-uploads parts of a recording the user destroyed and the orphaned
	// buffer lingers in storage forever.
	it("onStartup clears the pending buffer and queued parts of a half-discarded recording, sparing unrelated work", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-halfway", "upload-halfway"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "discard",
					payload: { videoId: "vid-halfway", uploadId: "upload-halfway" },
					attempts: 0,
					nextRetryAt: Date.now() - 1,
				},
				partItem("vid-halfway", "upload-halfway", 2),
				partItem("vid-other", "upload-other", 1),
			],
			"pendingBuffer:upload-halfway": Buffer.from("tail").toString("base64"),
		});

		const calls = stubDiscardFetch();
		await captured.startup?.();
		await flushAsync();

		expect(
			calls.find((c) => c.url.includes("/api/upload/multipart/presign-part")),
			"a part of the destroyed recording was re-uploaded",
		).toBeUndefined();
		expect(
			(await storage.get("pendingBuffer:upload-halfway"))[
				"pendingBuffer:upload-halfway"
			],
			"the orphaned pending buffer was not cleared",
		).toBeUndefined();

		const queue = await readQueue(storage);
		expect(
			queue.some(
				(i) =>
					i.kind === "part" &&
					(i.payload as { videoId?: string }).videoId === "vid-halfway",
			),
			"queued part work for the destroyed recording survived startup",
		).toBe(false);
		expect(
			queue.some(
				(i) => (i.payload as { videoId?: string }).videoId === "vid-other",
			),
			"unrelated work was destroyed by the discard cleanup",
		).toBe(true);

		const { getState } = await import("./state");
		expect((await getState()).kind).toBe("idle");
	});

	// ── W3c: the reply must not claim work that never happened ─────────────
	//
	// A stale popup click (the upload already moved on) does nothing and queues
	// nothing, so the reply must not carry the "queued; will retry" outcome. The
	// popup renders whatever outcome the reply names.
	it("reports outcome 'noop' when the upload already moved on (nothing queued, nothing deleted)", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState({
			kind: "complete",
			videoId: "vid-moved",
			shareUrl: "https://example.test/s/vid-moved",
		});

		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			ok?: boolean;
			outcome?: string;
		};
		await flushAsync();

		expect(res.ok).toBe(false);
		expect(res.outcome).toBe("noop");
		const discards = (await readQueue(storage)).filter(
			(i) => i.kind === "discard",
		);
		expect(discards, "a no-op discard must queue nothing").toHaveLength(0);
	});

	it("names outcome 'deleted' on a clean server discard and 'queued' when the server is unreachable", async () => {
		const cleanSw = await freshSw();
		await cleanSw.setState(uploadingState("vid-clean", "upload-clean"));
		stubDiscardFetch();
		const cleanRes = (await sendMessage(cleanSw.captured, {
			type: "DISCARD_UPLOAD",
		})) as { outcome?: string };
		await flushAsync();
		expect(cleanRes.outcome).toBe("deleted");

		const failSw = await freshSw();
		await failSw.setState(uploadingState("vid-unreach", "upload-unreach"));
		stubDiscardFetch({ failServer: true });
		const failRes = (await sendMessage(failSw.captured, {
			type: "DISCARD_UPLOAD",
		})) as { outcome?: string };
		await flushAsync();
		expect(failRes.outcome).toBe("queued");
	});

	it("the queued discard finishes the job on a later drain, exactly once, and survives repetition", async () => {
		const { captured, storage, setState } = await freshSw();
		await setState(uploadingState("vid-drain", "upload-drain"));

		const fetchState = { abortFails: true };
		const calls = stubAbortFailsFetch(fetchState);
		await sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		expect(
			(await readQueue(storage)).filter((i) => i.kind === "discard"),
			"nothing was queued to retry",
		).toHaveLength(1);

		// Simulate the backoff elapsing (the enqueue stamps nextRetryAt in the
		// future, and the drain skips items that are not yet due).
		const dueQueue = (await readQueue(storage)).map((i) => ({
			...i,
			nextRetryAt: Date.now() - 1,
		}));
		await storage.set({ [RETRY_QUEUE_KEY]: dueQueue });

		// Server is reachable again; drive the EXISTING retry alarm.
		fetchState.abortFails = false;
		calls.length = 0;
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();

		const deletes = calls.filter((c) =>
			c.url.includes("/api/video/delete-permanent"),
		);
		expect(deletes, "the queued discard never completed on the drain").toHaveLength(1);
		expect(deletes[0]?.url).toContain("videoId=vid-drain");
		expect(
			(await readQueue(storage)).filter((i) => i.kind === "discard"),
			"the discard task was not cleared after succeeding",
		).toHaveLength(0);

		// Repeating the whole sequence must be safe: no duplicate work.
		calls.length = 0;
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();
		expect(
			calls.filter((c) => c.url.includes("/api/video/delete-permanent")),
			"a second drain re-issued the delete",
		).toHaveLength(0);
	});

	it("is a no-op when the upload already moved on (stale popup click)", async () => {
		const { captured, setState } = await freshSw();
		await setState({
			kind: "complete",
			videoId: "vid-done",
			shareUrl: "https://example.test/s/vid-done",
		});

		const calls = stubDiscardFetch();
		const res = (await sendMessage(captured, { type: "DISCARD_UPLOAD" })) as {
			ok?: boolean;
		};
		await flushAsync();

		expect(res.ok).toBe(false);
		expect(calls).toHaveLength(0);
		const { getState } = await import("./state");
		expect((await getState()).kind).toBe("complete");
	});

	// The critical stomp: DISCARD_UPLOAD's guard reads state ONCE, then awaits
	// discardUpload's real (slow) network calls before writing "idle"
	// unconditionally. In that window the retry-alarm drain can legitimately
	// flip state to "complete", from which the user is allowed to start a
	// brand-new recording (RECORDER_STARTED is admitted — isInProgress()
	// excludes "complete"). When the stale discard's tail finally runs, an
	// unconditional reset lands on top of that LIVE new recording: handleChunk
	// requires kind === "recording", so every later chunk of the new recording
	// is silently dropped and finalizeRecording no-ops. Meeting lost, silently,
	// by the button meant to be safe. Proved by driving the real handlers
	// through the exact interleaving with deterministic fetch gates.
	it("does not stomp a NEW recording that starts while an earlier discard's server calls are still resolving", async () => {
		const { captured, storage, setState } = await freshSw();
		const { getState } = await import("./state");

		// Upload A parked in "uploading" with a due deferred-complete retry item.
		await setState(uploadingState("vid-A", "upload-A"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: {
						uploadId: "upload-A",
						videoId: "vid-A",
						parts: [{ partNumber: 1, etag: "etag-1", size: 0 }],
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		// Gates make each interleaving step deterministic instead of a lucky race.
		let releaseComplete!: () => void;
		const completeGate = new Promise<void>((r) => {
			releaseComplete = r;
		});
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((r) => {
			releaseAbort = r;
		});

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request) => {
				const url = input.toString();
				if (url.includes("/multipart/complete")) {
					await completeGate;
					return jsonResponse({ success: true });
				}
				if (url.includes("/multipart/abort")) {
					await abortGate;
					return jsonResponse({ success: true });
				}
				if (url.includes("/api/video/delete-permanent")) return jsonResponse({ ok: true });
				if (url.includes("/recording-complete")) return jsonResponse({ ok: true });
				if (url.includes("/desktop/video/create"))
					return jsonResponse({ id: "vid-B" });
				if (url.includes("/multipart/initiate"))
					return jsonResponse({ uploadId: "upload-B" });
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		// (2) drain enters the queue and parks on completeMultipart.
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();

		// (3) user clicks "Permanently discard"; the guard reads "uploading" ->
		// passes, and discardUpload is enqueued BEHIND the in-flight drain.
		const discardResp = sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		// (4) drain finishes: multipart A completes server-side, state -> "complete".
		releaseComplete();
		await flushAsync();
		expect((await getState()).kind).toBe("complete");

		// (5) discard is now running, parked on its abort fetch.
		// (6) the user starts a NEW recording B — RECORDER_STARTED is admitted
		// from "complete" (not in-progress).
		const startResp = (await sendMessage(
			captured,
			{ type: "RECORDER_STARTED", mime: "video/webm" },
			OFFSCREEN_SENDER,
		)) as { ok?: boolean };
		expect(startResp.ok).toBe(true);
		const during = await getState();
		expect(during.kind).toBe("recording");
		expect(during.kind === "recording" && during.videoId).toBe("vid-B");

		// (7) discard's server calls finally resolve; the SW handler's tail runs.
		releaseAbort();
		await discardResp;
		await flushAsync();

		// Recording B must SURVIVE the old discard's tail write.
		const final = await getState();
		expect(final.kind).toBe("recording");
		expect(final.kind === "recording" && final.videoId).toBe("vid-B");

		// And it must still be functionally alive: a later chunk is accepted,
		// not silently dropped (handleChunk requires kind === "recording").
		const before =
			final.kind === "recording" ? final.totalBytes : Number.NaN;
		await sendMessage(captured, {
			type: "RECORDER_CHUNK",
			chunk: Array.from(new Uint8Array(4096)),
			index: 0,
			mime: "video/webm",
		});
		const after = await getState();
		expect(after.kind).toBe("recording");
		expect(after.kind === "recording" && after.totalBytes).toBe(before + 4096);
	});

	// The RESIDUAL bug left after the recording-B fix above: stillOurs correctly
	// refuses to reset to "idle" once the drain has moved state past "uploading"
	// — but when that landing spot is a TERMINAL state (complete/error) for the
	// SAME discarded video (no recording B ever started), leaving it untouched
	// is itself wrong. The popup would show "Recording saved!" with a share link
	// — or an "please re-record" error — for a video this very discard just
	// deleted server-side (cleanUpDiscardedVideoOnServer's delete-permanent runs
	// even after an already-completed multipart). Proved with the real handlers,
	// same gated-race technique as the test above, minus the recording-B step.
	it("overwrites a TERMINAL 'complete' state landing on the SAME discarded video with a discarded marker, not a misleading share link", async () => {
		const { captured, storage, setState } = await freshSw();
		const { getState } = await import("./state");

		await setState(uploadingState("vid-A", "upload-A"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: {
						uploadId: "upload-A",
						videoId: "vid-A",
						parts: [{ partNumber: 1, etag: "etag-1", size: 0 }],
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		let releaseComplete!: () => void;
		const completeGate = new Promise<void>((r) => {
			releaseComplete = r;
		});
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((r) => {
			releaseAbort = r;
		});

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/multipart/complete")) {
				await completeGate;
				return jsonResponse({ success: true });
			}
			if (url.includes("/multipart/abort")) {
				await abortGate;
				return jsonResponse({ success: true });
			}
			if (url.includes("/api/video/delete-permanent"))
				return jsonResponse({ ok: true });
			if (url.includes("/recording-complete")) return jsonResponse({ ok: true });
			throw new Error(`Unhandled fetch in test: ${url}`);
		});

		// (1) drain enters the queue and parks on completeMultipart.
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();

		// (2) user clicks "Permanently discard"; the guard reads "uploading" ->
		// passes, and discardUpload is enqueued BEHIND the in-flight drain.
		const discardResp = sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		// (3) drain finishes: multipart A completes server-side, state -> "complete".
		// NO new recording starts this time — this is the residual case.
		releaseComplete();
		await flushAsync();
		expect((await getState()).kind).toBe("complete");

		// (4) discard's own abort/delete calls finally resolve; the handler's
		// tail (the afterDiscard read + overwrite) runs.
		releaseAbort();
		await discardResp;
		await flushAsync();

		const final = await getState();
		// Must NOT be the misleading "Recording saved!" + share-link state for a
		// video that was just permanently deleted on purpose.
		expect(final.kind).not.toBe("complete");
		expect(final.kind).toBe("error");
		expect(final.kind === "error" && final.recoverable).toBe(false);
		expect(final.kind === "error" && final.reason).toMatch(/o'chirildi/i);
	});

	// Same residual bug, other terminal branch: the drain can also dead-letter a
	// permanently-failed part for the SAME video mid-discard, which sets a
	// generic "please re-record" error (moveToDeadLetter in upload.ts). That
	// copy is a lie for a recording the user just asked to destroy.
	it("overwrites a TERMINAL 'error' state landing on the SAME discarded video with a discarded marker, not a 'please re-record' lie", async () => {
		const { captured, storage, setState } = await freshSw();
		const { getState } = await import("./state");

		await setState(uploadingState("vid-A", "upload-A"));
		await storage.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 2,
						videoId: "vid-A",
						uploadId: "upload-A",
						partDataBase64: Buffer.from("bytes").toString("base64"),
					},
					// One more failed attempt exhausts PART_MAX_ATTEMPTS, so this single
					// drain pass dead-letters it immediately (deterministic, no need to
					// loop the alarm).
					attempts: PART_MAX_ATTEMPTS - 1,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		let releasePresign!: () => void;
		const presignGate = new Promise<void>((r) => {
			releasePresign = r;
		});
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((r) => {
			releaseAbort = r;
		});

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/api/upload/multipart/presign-part")) {
				await presignGate;
				return new Response("boom", { status: 500 });
			}
			if (url.includes("/multipart/abort")) {
				await abortGate;
				return jsonResponse({ success: true });
			}
			if (url.includes("/api/video/delete-permanent"))
				return jsonResponse({ ok: true });
			throw new Error(`Unhandled fetch in test: ${url}`);
		});

		// (1) drain begins, parks on the failing presign-part fetch.
		captured.alarm?.({ name: RETRY_ALARM_NAME });
		await flushAsync();

		// (2) user clicks discard while state is still "uploading" — the guard
		// reads it, passes, and queues discardUpload BEHIND the in-flight drain.
		const discardResp = sendMessage(captured, { type: "DISCARD_UPLOAD" });
		await flushAsync();

		// (3) the part's retries are exhausted -> dead-lettered -> state flips to
		// a TERMINAL "error" for the SAME video (the generic "please re-record"
		// reason), while the discard is still queued behind it.
		releasePresign();
		await flushAsync();
		const midState = await getState();
		expect(midState.kind).toBe("error");
		expect(midState.kind === "error" && midState.previousVideoId).toBe(
			"vid-A",
		);

		// (4) discard's own abort/delete calls finally resolve; the handler's
		// tail (the afterDiscard read + overwrite) runs.
		releaseAbort();
		await discardResp;
		await flushAsync();

		const final = await getState();
		expect(final.kind).toBe("error");
		// Must NOT still be the generic "please re-record" lie for a recording
		// deliberately destroyed by this same discard.
		expect(final.kind === "error" && final.reason).not.toMatch(/qayta yozib/i);
		expect(final.kind === "error" && final.recoverable).toBe(false);
		expect(final.kind === "error" && final.reason).toMatch(/o'chirildi/i);
	});
});

// ── MEDIUM: pause/resume must not lie ──────────────────────────────────────
//
// The persisted paused flag was written whether or not the PAUSE_CAPTURE /
// RESUME_CAPTURE control message ever reached the recorder. sendControlWithRetry
// already reports delivery, so a dead offscreen document produced a popup
// cheerfully showing "Paused" over a recorder that never stopped recording (and
// the mirror image on resume: "Recording" over a still-paused recorder).

/** Make every runtime.sendMessage to the recorder fail the way Chrome does when
 * the receiving end is gone, so sendControlWithRetry exhausts its attempts. */
function breakControlChannel(chrome: {
	runtime: {
		lastError?: { message: string };
		sendMessage: unknown;
	};
}) {
	chrome.runtime.sendMessage = ((
		_msg: unknown,
		cb?: (r: unknown) => void,
	) => {
		chrome.runtime.lastError = {
			message: "Could not establish connection. Receiving end does not exist.",
		};
		cb?.(undefined);
		chrome.runtime.lastError = undefined;
		return Promise.resolve(undefined);
	}) as unknown as typeof chrome.runtime.sendMessage;
}

function recordingStateFor(paused: boolean) {
	return {
		kind: "recording" as const,
		mode: "meeting" as const,
		videoId: "vid-pause",
		uploadId: "upload-pause",
		startedAt: Date.now(),
		parts: [],
		nextPartNumber: 1,
		totalBytes: 0,
		uploadedBytes: 0,
		mime: "video/webm",
		paused,
	};
}

describe("MEDIUM — pause/resume state follows the recorder, not the intent", () => {
	it("does not persist 'paused' when PAUSE_CAPTURE never reached the recorder", async () => {
		const { captured, chrome, setState } = await freshSw();
		await setState(recordingStateFor(false));
		breakControlChannel(chrome);

		const res = (await sendMessage(captured, { type: "PAUSE" })) as {
			ok?: boolean;
		};

		const { getState } = await import("./state");
		const after = await getState();
		expect(after.kind).toBe("recording");
		expect(after.kind === "recording" && after.paused).toBe(false);
		expect(res.ok).toBe(false);
	});

	it("does not persist 'resumed' when RESUME_CAPTURE never reached the recorder", async () => {
		const { captured, chrome, setState } = await freshSw();
		await setState(recordingStateFor(true));
		breakControlChannel(chrome);

		const res = (await sendMessage(captured, { type: "RESUME" })) as {
			ok?: boolean;
		};

		const { getState } = await import("./state");
		const after = await getState();
		expect(after.kind === "recording" && after.paused).toBe(true);
		expect(res.ok).toBe(false);
	});

	it("still persists the pause when the recorder acknowledges", async () => {
		const { captured, chrome, setState } = await freshSw();
		await setState(recordingStateFor(false));
		// The base harness's sendMessage never invokes the callback, which
		// sendToOffscreen waits on forever; a live recorder does ack.
		chrome.runtime.sendMessage = ((
			_msg: unknown,
			cb?: (r: unknown) => void,
		) => {
			cb?.({ ok: true });
			return Promise.resolve(undefined);
		}) as unknown as typeof chrome.runtime.sendMessage;

		const res = (await sendMessage(captured, { type: "PAUSE" })) as {
			ok?: boolean;
		};

		const { getState } = await import("./state");
		const after = await getState();
		expect(after.kind === "recording" && after.paused).toBe(true);
		expect(res.ok).toBe(true);
	});
});

// ── In-page recorder: the Meet tab is the recorder, so its lifecycle IS the
// recording's lifecycle (defects found by an independent review, 2026-07-20) ──

describe("In-page path — a reloaded Meet tab must not strand the recording", () => {
	it("finalizes when the recording's own content tab starts loading again", async () => {
		const { captured, notifications } = await freshSw();
		const { setState, getState } = await import("./state");

		// Live in-page recording: the MediaRecorder lives in tab 42 (the Meet page).
		await setState({
			kind: "recording",
			mode: "meeting",
			meetingId: "abc-defg-hij",
			tabId: 42,
			contentRecorderTabId: 42,
			videoId: "vid-reload",
			uploadId: "upload-reload",
			startedAt: Date.now(),
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
			nextPartNumber: 2,
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
			mime: "video/webm",
			paused: false,
		});

		let completeCalls = 0;
		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
			if (url.includes("/api/upload/multipart/complete")) {
				completeCalls += 1;
				return jsonResponse({ success: true, fileKey: "file" });
			}
			if (url.includes("/api/upload/recording-complete")) {
				return jsonResponse({});
			}
			throw new Error(`Unhandled fetch in test: ${url}`);
		});

		// F5 on the Meet tab. Chrome reports this as a status change with NO url
		// change — which is precisely why the pre-existing url-based watcher and
		// tabs.onRemoved both stayed silent, leaving the SW "recording" forever
		// with everything after the reload unrecorded.
		for (const fn of captured.tabUpdated) fn(42, { status: "loading" });
		await flushAsync(10);

		const finalState = await getState();
		expect(finalState.kind).not.toBe("recording");
		expect(completeCalls).toBe(1);
		// And the owner is told, rather than silently losing the second half.
		expect(notifications.some((n) => n.id === "meet-tab-reloaded")).toBe(true);
	});

	it("ignores an unrelated tab reloading", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");
		await setState({
			kind: "recording",
			mode: "meeting",
			meetingId: "abc-defg-hij",
			tabId: 42,
			contentRecorderTabId: 42,
			videoId: "vid-keep",
			uploadId: "upload-keep",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		for (const fn of captured.tabUpdated) fn(99, { status: "loading" });
		await flushAsync();

		expect((await getState()).kind).toBe("recording");
	});
});

describe("In-page path — declining the client-audio confirm releases the lock", () => {
	it("clears a mode-'meeting' arming for the tab that armed it, and only that tab", async () => {
		const { captured } = await freshSw();
		const { setState, getState } = await import("./state");

		const arming = {
			kind: "arming",
			mode: "meeting",
			meetingId: "abc-defg-hij",
			tabId: 7,
			contentRecorderTabId: 7,
		} as const;

		// A different tab must NOT be able to release it (that would let a stale
		// recorder.html tab wipe someone else's arming).
		await setState({ ...arming });
		await sendMessage(captured, { type: "MEET_NUDGE_CANCEL" }, { tab: { id: 8 } });
		expect((await getState()).kind).toBe("arming");

		// The tab that armed it can. Before this existed the content script sent
		// INSTRUCTION_CANCEL, which only ever released mode "instruction" — so a
		// declined confirm left the extension armed and a later RECORDER_STARTED
		// inherited that stale record.
		await sendMessage(captured, { type: "MEET_NUDGE_CANCEL" }, { tab: { id: 7 } });
		expect((await getState()).kind).toBe("idle");
	});
});
