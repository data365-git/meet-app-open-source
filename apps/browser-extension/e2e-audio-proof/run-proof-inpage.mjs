// Machine proof for the IN-PAGE (two-step) recording path.
//
// Sibling of run-proof.mjs, which proves the SHORTCUT path (Ctrl+Shift+9 →
// activeTab → chrome.tabCapture). This one proves the path that has no
// activeTab grant at all: a real click on the nudge's "Record now" button
// inside the Meet page opens the screen picker directly, and the remote
// participants' voices are tapped off Meet's own media elements via
// HTMLMediaElement.captureStream().
//
// THE METRIC (same as its sibling — a number a script computes, not a model's
// opinion): the assembled multipart upload must contain the fake Meet tab's
// 440 Hz tone, and the upload must be filed as a meeting.
//
// Two things make this harder than the sibling and are worth knowing before
// editing:
//   1. The nudge lives in a CLOSED shadow root, which Playwright locators
//      cannot pierce. We find the button through CDP (DOM.getDocument with
//      pierce:true) and click it with a real mouse event at its box centre —
//      a genuine user gesture, which is exactly what getDisplayMedia needs.
//   2. The tone must come from an <audio> element (?tone=media), because
//      captureStream() taps media elements, not the page's oscillators.
//
// Usage: node run-proof-inpage.mjs   (assumes `pnpm build` produced ../dist)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertTabAudioConstraints } from "./assert-tab-constraints.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const require = createRequire(join(here, "..", "..", "web", "package.json"));

// PROOF_SWAP=1 runs the harder scenario reviewed into existence on 2026-07-20:
// mid-recording, the fake Meet REUSES its <audio> element with a new source,
// exactly as Meet does when the active speaker changes. A tap bound to the old
// track dies there, so the tone must still be present in EVERY segment of the
// file — that is what proves the recorder prunes dead taps and re-taps, rather
// than silently recording nothing for the rest of the call.
const SWAP_TEST = process.env.PROOF_SWAP === "1";
// PROOF_SECOND=1 reproduces the 2026-07-22 prod bug: record → stop → record
// AGAIN on the SAME page. Recording #1's cleanup used to stop()
// captureStream()-derived tracks, which — on a srcObject-backed element like
// real Meet's — terminally kills the element's OWN underlying WebRTC track.
// Recording #2 then finds zero live taps and shows the "the other person's audio wasn't captured"
// confirm dialog instead of just recording. Requires ?tone=stream (the
// srcObject-backed fake element): ?tone=media is file-backed and takes a
// different Blink captureStream() path that cannot reproduce this at all.
// See docs/plans/2026-07-22-remote-voice-2nd-recording-bug.md §6.2.
const SECOND_TEST = process.env.PROOF_SECOND === "1";
// PROOF_MINUTES overrides the recording length so this harness can be used as a
// LONG-DURATION soak test (the 2-hour question) without editing the file:
//   PROOF_MINUTES=120 node run-proof-inpage.mjs
// Default behaviour is unchanged when the env var is absent.
const PROOF_MINUTES = Number(process.env.PROOF_MINUTES) || 0;
const RECORD_MS =
	PROOF_MINUTES > 0
		? PROOF_MINUTES * 60_000
		: SWAP_TEST
			? 18_000
			: SECOND_TEST
				? 8_000
				: 10_000;
// The 440 Hz band floor the quality push must not regress past
// (docs/plans/2026-08-04-quality-push-spec.md, DONE CONTRACT #4). Presence
// alone is not enough any more: the audio graph gained a gain lift and a
// limiter, and a limiter that clamped too hard would still leave the tone
// "present" (analyze-audio.mjs only needs > -50 dB) while quietly crushing the
// remote voice. This floor is what makes that visible. Env-overridable so a
// deliberate re-baselining is an explicit act, not an edit to this file.
const MIN_BAND_MEAN_DB = Number(process.env.PROOF_MIN_BAND_DB ?? -16.5);
// How long the harness will wait, after Stop, for the leftover upload backlog to
// drain. Scaled off the recording length because the backlog a slow link leaves
// behind grows with the recording, plus a floor for short runs. The stall window
// must comfortably exceed the time one throttled part takes (a 5 MB part at
// 800 kbit/s is ~50 s), otherwise a healthy slow upload looks like a dead one.
const DRAIN_HARD_CAP_MS = Number(process.env.PROOF_DRAIN_CAP_MS) || Math.max(180_000, RECORD_MS);
const DRAIN_STALL_MS = Number(process.env.PROOF_DRAIN_STALL_MS) || 150_000;
const SERVE_PORT = 8443;
// Is the mock server throttling this arm? (mock-server.mjs reads the same var.)
// The adaptive-capture contract only forbids a tier move on a link that is fast
// ENOUGH — on a deliberately throttled arm a move is the feature working, so the
// no-move claim below is asserted on the control arm only.
const IS_THROTTLED = Number(process.env.THROTTLE_KBPS) > 0;
// THE CAPTURED SURFACE'S VIDEO LOAD (see fake-meet/index.html ?load=).
//
// The harness records the ENTIRE SCREEN, so before this the recorded bitrate was
// whatever happened to be on the dev machine's display: a still desktop, ~145
// kbit/s, which no throttle in the contract can overload. That made the slow-link
// arm prove nothing — it passed because there was almost nothing to upload, not
// because the capture adapted. The fake Meet page now paints a deterministic
// moving surface, so the FULL tier genuinely offers more than an 800 kbit/s link
// can carry and the adaptation has something real to do.
// CALIBRATED, not guessed (1-minute runs of this harness, 2026-08-05, recorded
// bytes straight off the mock server's manifest):
//     off             ->  1.1 MB/min   (a still desktop: the old, useless load)
//     1 cell  @  1 Hz ->  6.8 MB/min
//     20 cells @ 1 Hz -> 12.5 MB/min   <- chosen
//     20 cells @ 60 Hz-> 39.2 MB/min
//     200 cells @ 2 Hz-> 39.9 MB/min   (saturated: ~5.7 Mbit/s is this pipeline's
//     1400 cells@ 60Hz-> 45.6 MB/min    ceiling for screen content)
// 20 cells at 1 Hz ≈ 1.7 Mbit/s of screen video — the order of a real meeting
// recording with slides changing — and gives the numbers this proof needs:
//   • ~75 MB over six minutes, i.e. the FULL tier offers about twice what an
//     800 kbit/s link (6.1 MB/min) can carry, so the overload is real;
//   • the backlog crosses the 15 MB degrade mark around 2.5 minutes in, leaving
//     the rest of the recording to show the adaptation working;
//   • what is left after Stop still drains inside the harness's own cap.
// Saturating the pipeline instead (the 40 MB/min settings above) would overload
// the link so hard that no amount of adaptation could drain it — that would prove
// the feature CANNOT work rather than that it does.
const VIDEO_LOAD_CELLS =
	process.env.PROOF_VIDEO_LOAD === undefined
		? 20
		: Number(process.env.PROOF_VIDEO_LOAD);
const VIDEO_LOAD_HZ =
	process.env.PROOF_VIDEO_LOAD_HZ === undefined
		? 1
		: Number(process.env.PROOF_VIDEO_LOAD_HZ);
const FAKE_MEET_URL = `https://meet.google.com/abc-defg-hij?tone=${SECOND_TEST ? "stream" : "media"}${SWAP_TEST ? "&swap=8000" : ""}${VIDEO_LOAD_CELLS > 0 ? `&load=${VIDEO_LOAD_CELLS}&loadhz=${VIDEO_LOAD_HZ}` : ""}`;

const log = (m) => console.log(`[proof-inpage] ${m}`);

function verdict(kind, detail) {
	console.log(`VERDICT=${kind} ${detail}`.trim());
	return kind === "PASS" ? 0 : 1;
}

/**
 * Find a node inside a CLOSED shadow root by its text, and return the centre of
 * its box. Playwright cannot do this; CDP can, because DOM.getDocument accepts
 * pierce:true. Returns null when the node is absent (which is a real failure
 * signal, not a harness bug — the nudge should be there).
 */
async function centreOfShadowNode(cdp, text) {
	const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		if (node.nodeName === "BUTTON") {
			// A button's label is its text child.
			const label = (node.children ?? [])
				.filter((c) => c.nodeType === 3)
				.map((c) => (c.nodeValue ?? "").trim())
				.join("");
			if (label === text) {
				const box = await cdp
					.send("DOM.getBoxModel", { nodeId: node.nodeId })
					.catch(() => null);
				if (!box?.model?.content) return null;
				const q = box.model.content; // x1,y1,x2,y2,x3,y3,x4,y4
				return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
			}
		}
		for (const c of node.children ?? []) stack.push(c);
		for (const r of node.shadowRoots ?? []) stack.push(r);
		if (node.contentDocument) stack.push(node.contentDocument);
	}
	return null;
}

/** The nudge card's own text, read out of the closed shadow root. It carries the
 * real failure reason (picker cancelled, SW refused, no client audio…), which is
 * otherwise invisible to the harness. */
async function shadowDump(cdp) {
	try {
		const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
		const stack = [root];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node) continue;
			if (node.nodeName === "#document-fragment" && node.shadowRootType) {
				const { outerHTML } = await cdp.send("DOM.getOuterHTML", {
					nodeId: node.nodeId,
				});
				return outerHTML.replace(/<style[\s\S]*?<\/style>/g, "").slice(0, 800);
			}
			for (const c of node.children ?? []) stack.push(c);
			for (const r of node.shadowRoots ?? []) stack.push(r);
		}
	} catch {}
	return "no-shadow-root";
}

// ── Capture-tier watch ────────────────────────────────────────────────────
//
// WHY THIS EXISTS. The regression guard for adaptive capture is "on a link that
// is fast enough, the capture never degrades", checked by grepping this log for
// a tier-drop line. Before this watch the harness printed NO tier line under any
// circumstance, so that grep could not fail — a guard that cannot fail guards
// nothing, and the quality push could have been silently undone by a stray
// degrade with the control arm still reporting PASS.
//
// The signal is the extension's OWN evidence of a DELIVERED tier change, taken
// at the two places sw.ts emits it after `sendCaptureTier` resolves true:
// the `[sw] capture tier x→y (backlog N bytes)` console line (which carries the
// tier names and the measurement behind them) and the user-facing notification
// (whose title says which DIRECTION the tier moved). An undelivered change goes
// through console.warn and is deliberately NOT captured — the capture did not
// actually change, so it is not a degradation.
//
// Both hooks wrap and call through; nothing about the extension's behaviour is
// altered by observing it.
const TIER_SELFTEST_MARK = "__proof-tier-selftest__";

/** Install (idempotently) into the live service worker. Returns whether the
 * wrapper proved it can capture a matching line — silence from an uninstalled
 * hook must never be read as "nothing happened". */
async function installCaptureTierWatch(sw, mark) {
	return await sw.evaluate((selftestMark) => {
		if (globalThis.__proofTierWatch) {
			return { fresh: false, teeth: globalThis.__proofTierWatch.teeth, notices: globalThis.__proofTierWatch.noticeHook };
		}
		const watch = { events: [], teeth: false, noticeHook: false };
		globalThis.__proofTierWatch = watch;

		const realInfo = console.info.bind(console);
		console.info = (...args) => {
			const text = args.map((a) => String(a)).join(" ");
			if (text.includes(selftestMark)) {
				watch.teeth = true;
				return;
			}
			if (text.includes("capture tier")) watch.events.push({ kind: "tier", text });
			// The measurement behind every decision, whether or not it moved the
			// tier. Without it a run that never degraded is indistinguishable from
			// a run whose backlog signal was blind — which is exactly how a
			// structurally unreachable high-water mark stayed hidden.
			const backlog = text.match(/upload backlog (\d+) bytes/);
			if (backlog) {
				watch.events.push({ kind: "backlog", bytes: Number(backlog[1]), text });
			}
			realInfo(...args);
		};

		try {
			const realCreate = chrome.notifications.create.bind(chrome.notifications);
			chrome.notifications.create = (...args) => {
				const options = args.find(
					(a) => a && typeof a === "object" && typeof a.title === "string",
				);
				if (options && options.title.startsWith("Recording quality")) {
					watch.events.push({
						kind: "notice",
						title: options.title,
						message: String(options.message ?? ""),
					});
				}
				return realCreate(...args);
			};
			watch.noticeHook = true;
		} catch {
			// Direction is then unknown; the reporter fails safe (see below).
		}

		// TEETH: push a line through the very branch a real tier change takes, and
		// require it to have been seen before trusting this watch's silence.
		console.info(`[sw] capture tier ${selftestMark} (not a real tier move)`);
		return { fresh: true, teeth: watch.teeth, notices: watch.noticeHook };
	}, mark);
}

/** Take everything observed since the last drain. `null` means the watch is gone
 * — an MV3 service worker can be torn down and restarted, taking the wrapper (and
 * any event it would have caught) with it. That is a HOLE in the evidence, not a
 * quiet pass, so the caller records it. */
async function drainCaptureTierEvents(sw) {
	try {
		return await sw.evaluate(() => {
			const watch = globalThis.__proofTierWatch;
			if (!watch) return null;
			return watch.events.splice(0, watch.events.length);
		});
	} catch {
		return null;
	}
}

/**
 * Turn raw observations into log lines. A DROP is reported with the words the
 * regression check greps for; a move back up is reported with its own wording,
 * because on a link that is fast enough neither should ever occur — a restore
 * can only exist because a degradation preceded it.
 */
function describeTierEvents(events) {
	const lines = [];
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		if (event.kind !== "tier") continue;
		const detail = event.text.replace(/^\[sw\]\s*/, "");
		// sw.ts logs the line and then raises the notice, so the direction for this
		// move is the next notice in the stream.
		const notice = events.slice(i + 1, i + 3).find((e) => e.kind === "notice");
		if (!notice) {
			// Fail safe: an unclassifiable move is still a move.
			lines.push(`tier drop or restore, direction unclassified: ${detail}`);
		} else if (/reduced/i.test(notice.title)) {
			lines.push(`tier drop: ${detail} — "${notice.title}"`);
		} else {
			lines.push(`degraded capture moved back up: ${detail} — "${notice.title}"`);
		}
	}
	// A notice with no console line before it would mean the console hook missed a
	// change the user was told about. Report it rather than lose it.
	const paired = lines.length;
	const notices = events.filter((e) => e.kind === "notice").length;
	for (let i = paired; i < notices; i++) {
		lines.push("tier drop or restore, console line missing: a quality notice was raised");
	}
	return lines;
}

async function main() {
	let chromium;
	for (const pkg of ["playwright", "@playwright/test", "playwright-core"]) {
		try {
			({ chromium } = require(pkg));
			break;
		} catch {}
	}
	if (!chromium) return verdict("BLOCKED", "reason=playwright-not-resolvable");

	const server = spawn(
		process.execPath,
		[join(here, "serve.mjs"), String(SERVE_PORT)],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const outDir = join(here, "out-inpage");
	const mock = spawn(
		process.execPath,
		[join(here, "mock-server.mjs"), "3001", outDir],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	// Post-Stop drain progress. The old wait was a flat 60x1s, which is shorter
	// than a LEGITIMATE drain on a throttled link (one 5 MB part at 800 kbit/s
	// alone takes ~50 s), so a slow-but-healthy run could be misreported as
	// "upload-never-completed". Every mock-server line is an upload event, so the
	// mock's own chatter is the progress signal: keep waiting while parts are
	// still moving, and only declare failure once the link has gone genuinely
	// silent (or the hard cap is hit). A truly stuck upload still fails — it just
	// fails on evidence of a stall instead of on a stopwatch.
	let lastMockActivityAt = Date.now();
	mock.stdout.on("data", (d) => {
		lastMockActivityAt = Date.now();
		log(String(d).trim());
	});
	const { readFileSync, existsSync } = await import("node:fs");
	const waitForCompletedManifest = async (manifestPath) => {
		const deadline = Date.now() + DRAIN_HARD_CAP_MS;
		lastMockActivityAt = Date.now();
		while (Date.now() < deadline) {
			if (existsSync(manifestPath)) {
				try {
					const m = JSON.parse(readFileSync(manifestPath, "utf8"));
					if (m.recordingComplete && m.assembledFile) return m;
				} catch {
					// manifest is written non-atomically; a torn read just means "not yet"
				}
			}
			if (Date.now() - lastMockActivityAt > DRAIN_STALL_MS) {
				log(
					`drain stalled: no upload activity for ${Math.round(DRAIN_STALL_MS / 1000)}s`,
				);
				return null;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
		log(`drain hit the hard cap of ${Math.round(DRAIN_HARD_CAP_MS / 1000)}s`);
		return null;
	};
	let context;
	// Capture-tier observations (see the watch above).
	let tierPoll = null;
	let tierMoves = 0;
	let tierWatchLost = 0;
	let tierWatchTeeth = false;
	// The biggest backlog the extension ever measured. Recorded so the log carries
	// the evidence for how hard the link was actually squeezed, rather than an
	// absence — "no tier drop" only means something next to the number that would
	// have caused one (BACKLOG_DEGRADE_ABOVE_BYTES = 15 MB).
	let peakBacklogBytes = -1;
	try {
		await new Promise((resolve, reject) => {
			const t = setTimeout(() => reject(new Error("serve.mjs did not start")), 5000);
			server.stdout.on("data", (d) => {
				if (String(d).includes("fake-meet")) {
					clearTimeout(t);
					resolve();
				}
			});
			server.stderr.on("data", (d) => log(`serve: ${d}`));
			server.on("exit", (c) => reject(new Error(`serve.mjs exited ${c}`)));
		});
		log(`fake-meet up on :${SERVE_PORT}`);

		// PHASE 0 — does a REAL Chrome accept the new tab-audio constraint
		// object at all? Runs first so a rejected constraint object fails in
		// seconds instead of being diagnosed from a silent recording ten
		// minutes later. It uses its OWN browser instance with a fake audio
		// device (see assert-tab-constraints.mjs) precisely so it cannot
		// contaminate the 440 Hz measurement below.
		const tabConstraints = await assertTabAudioConstraints({ servePort: SERVE_PORT });
		log(tabConstraints.claim);
		if (!tabConstraints.ok) {
			return verdict("FAIL", `metric=inpage-full-contract ${tabConstraints.claim}`);
		}

		const userDataDir = mkdtempSync(join(tmpdir(), "proof-inpage-profile-"));
		context = await chromium.launchPersistentContext(userDataDir, {
			headless: false, // capture APIs need a headed session
			viewport: { width: 1280, height: 800 },
			args: [
				`--disable-extensions-except=${distDir}`,
				`--load-extension=${distDir}`,
				"--auto-select-desktop-capture-source=Entire screen",
				"--autoplay-policy=no-user-gesture-required",
				`--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${SERVE_PORT}`,
				"--ignore-certificate-errors",
			],
		});

		let [sw] = context.serviceWorkers();
		if (!sw) {
			sw = await context
				.waitForEvent("serviceworker", { timeout: 15_000 })
				.catch(() => null);
		}
		if (!sw) return verdict("FAIL", "reason=no-service-worker");
		log(`extension ${new URL(sw.url()).host} loaded`);

		const tierWatch = await installCaptureTierWatch(sw, TIER_SELFTEST_MARK);
		tierWatchTeeth = tierWatch.teeth === true;
		log(
			`capture-tier watch: ${tierWatchTeeth ? "control line captured (has teeth)" : "SELF-TEST FAILED — its silence proves nothing"}` +
				`${tierWatch.notices ? "" : ", direction hook unavailable"}`,
		);
		const collectTierEvents = async () => {
			const drained = await drainCaptureTierEvents(sw);
			if (drained === null) {
				tierWatchLost++;
				log("capture-tier watch went away (service worker restart); reinstalling");
				const again = await installCaptureTierWatch(sw, TIER_SELFTEST_MARK).catch(
					() => ({ teeth: false }),
				);
				tierWatchTeeth = tierWatchTeeth && again.teeth === true;
				return;
			}
			for (const event of drained) {
				if (event.kind !== "backlog") continue;
				if (event.bytes > peakBacklogBytes) peakBacklogBytes = event.bytes;
				log(event.text.replace(/^\[sw\]\s*/, ""));
			}
			for (const line of describeTierEvents(drained)) {
				tierMoves++;
				log(line);
			}
		};
		tierPoll = setInterval(() => {
			void collectTierEvents();
		}, 5000);

		await sw.evaluate(async () => {
			await chrome.storage.local.set({
				capExtSettings: {
					apiKey: "proof-fake-key",
					apiBaseUrl: "http://localhost:3001",
				},
				capExtFirstRun: false,
			});
		});

		// Real Meet already holds the mic grant for its own origin; the fake one
		// does not, and an open permission prompt blocks getUserMedia forever.
		// Grant it so the harness measures the recording path, not the prompt.
		await context
			.grantPermissions(["microphone"], { origin: "https://meet.google.com" })
			.catch(() => {});

		const meetPage = await context.newPage();
		meetPage.on("console", (m) => log(`console: ${m.text()}`));
		await meetPage.goto(FAKE_MEET_URL, { waitUntil: "domcontentloaded" });
		log(`meet tab: ${await meetPage.locator("#status").textContent()}`);
		await meetPage.bringToFront();

		// The nudge renders after the content script's settings round-trip and its
		// isInMeeting() check (the fake page carries a Leave-call control).
		const cdp = await context.newCDPSession(meetPage);
		await cdp.send("DOM.enable");
		let centre = null;
		for (let i = 0; i < 20 && !centre; i++) {
			await meetPage.waitForTimeout(500);
			centre = await centreOfShadowNode(cdp, "Record now").catch(() => null);
		}
		if (!centre) return verdict("FAIL", "reason=nudge-record-now-never-appeared");
		log(`nudge button at ${Math.round(centre.x)},${Math.round(centre.y)}`);

		// THE GESTURE. A real mouse event through CDP — user activation is genuine,
		// so getDisplayMedia() is allowed and the picker is auto-accepted by the
		// launch flag. This is step 1 of the owner's two steps; the picker is step 2.
		await meetPage.mouse.click(centre.x, centre.y);
		log("clicked Record now");

		// The card is replaced by the recording pill once capture is live. The pill
		// is also inside the closed shadow root, so probe for its Stop button.
		let stopCentre = null;
		for (let i = 0; i < 40 && !stopCentre; i++) {
			await meetPage.waitForTimeout(500);
			stopCentre = await centreOfShadowNode(cdp, "Stop").catch(() => null);
		}
		if (!stopCentre) {
			// Say WHY: the in-card note carries the real reason (picker cancelled,
			// SW refused, no client audio…).
			const note = await shadowDump(cdp);
			const state = await sw
				.evaluate(async () => (await chrome.storage.local.get("capExtState")).capExtState)
				.catch(() => null);
			return verdict(
				"FAIL",
				`reason=recording-never-started note=${note} swState=${JSON.stringify(state)}`,
			);
		}
		log("recording started (pill visible)");

		await meetPage.waitForTimeout(RECORD_MS);

		await meetPage.mouse.click(stopCentre.x, stopCentre.y);
		log("stopped; waiting for upload to the mock server");

		const manifestPath = join(outDir, "manifest.json");
		const manifest = await waitForCompletedManifest(manifestPath);
		if (!manifest?.assembledFile)
			return verdict("FAIL", "reason=upload-never-completed-to-mock");

		const { spawnSync } = await import("node:child_process");

		if (SECOND_TEST) {
			// Baseline sanity: recording #1 must actually contain the tone, or the
			// harness itself is broken (wrong element / wrong session file) and a
			// 2nd-recording test would prove nothing either way.
			const analyze1 = spawnSync(
				process.execPath,
				[join(here, "analyze-audio.mjs"), manifest.assembledFile],
				{ encoding: "utf8" },
			);
			const analyze1Line = (analyze1.stdout ?? "").trim();
			log(`recording #1 analyzer: ${analyze1Line}`);
			if (analyze1.status !== 0) {
				return verdict("FAIL", `reason=first-recording-no-tone ${analyze1Line}`);
			}

			// Recording #1 landed on the TERMINAL "complete" card ("Recording saved!")
			// and stays there until the user closes it — nudgeState only leaves
			// "complete" on that click (meet-detect.ts maybeShow() early-returns
			// while nudgeState === "complete"). Close it first, exactly like a real
			// user would before recording again. This sends CANCEL, which the SW
			// treats as a no-op reset to idle when nothing is mid-upload (state is
			// already "complete") — recording #1's file is untouched.
			let dismissCentre = null;
			for (let i = 0; i < 20 && !dismissCentre; i++) {
				await meetPage.waitForTimeout(500);
				dismissCentre = await centreOfShadowNode(cdp, "Close").catch(() => null);
			}
			if (!dismissCentre)
				return verdict("FAIL", "reason=complete-card-close-button-never-appeared");
			await meetPage.mouse.click(dismissCentre.x, dismissCentre.y);
			log("dismissed the complete card (Close)");

			// Re-find the record button — the default nudge re-renders ~800ms after
			// the SW's state settles back to idle (meet-detect.ts handleStateChange
			// "idle" case).
			let centre2 = null;
			for (let i = 0; i < 20 && !centre2; i++) {
				await meetPage.waitForTimeout(500);
				centre2 = await centreOfShadowNode(cdp, "Record now").catch(() => null);
			}
			if (!centre2)
				return verdict("FAIL", "reason=record-button-never-reappeared-for-2nd-recording");
			log(`record button (2nd recording) at ${Math.round(centre2.x)},${Math.round(centre2.y)}`);

			await meetPage.mouse.click(centre2.x, centre2.y);
			log("clicked Record now (2nd recording)");

			// THE OWNER'S BUG lives right here: if recording #1's cleanup killed
			// every page-audio tap (the pre-fix `t.stop()`), the extension shows the
			// "the other person's audio wasn't captured" confirm instead of going straight into the
			// pill. Probe for BOTH outcomes in the same loop — whichever appears
			// first is the true outcome, and we must not click "Start anyway" to
			// paper over it.
			let stop2Centre = null;
			let dialogCentre = null;
			for (let i = 0; i < 40 && !stop2Centre && !dialogCentre; i++) {
				await meetPage.waitForTimeout(500);
				stop2Centre = await centreOfShadowNode(cdp, "Stop").catch(() => null);
				if (!stop2Centre) {
					dialogCentre = await centreOfShadowNode(cdp, "Start anyway").catch(() => null);
				}
			}
			if (dialogCentre) {
				return verdict("FAIL", "reason=second-recording-lost-page-audio");
			}
			if (!stop2Centre) {
				const note = await shadowDump(cdp);
				return verdict("FAIL", `reason=second-recording-never-started note=${note}`);
			}
			log("2nd recording started (pill visible, no confirm dialog)");

			await meetPage.waitForTimeout(RECORD_MS);
			await meetPage.mouse.click(stop2Centre.x, stop2Centre.y);
			log("stopped 2nd recording; waiting for upload to the mock server");

			const manifest2Path = join(outDir, "manifest-2.json");
			const manifest2 = await waitForCompletedManifest(manifest2Path);
			if (!manifest2?.assembledFile)
				return verdict("FAIL", "reason=second-recording-upload-never-completed-to-mock");

			const analyze2 = spawnSync(
				process.execPath,
				[join(here, "analyze-audio.mjs"), manifest2.assembledFile],
				{ encoding: "utf8" },
			);
			const analyze2Line = (analyze2.stdout ?? "").trim();
			log(`recording #2 analyzer: ${analyze2Line}`);

			return verdict(
				analyze2.status === 0 ? "PASS" : "FAIL",
				`metric=second-recording-tone tone=${analyze2.status === 0 ? "OK" : "MISSING"} sustained_ms=${RECORD_MS} ${analyze2Line}`,
			);
		}

		// Last look before judging: a tier move decided on the final part would
		// otherwise land after the poller's last tick.
		if (tierPoll) {
			clearInterval(tierPoll);
			tierPoll = null;
		}
		await collectTierEvents();

		// The evidence, stated as a number rather than as an absence.
		const peakBacklogLabel =
			peakBacklogBytes < 0
				? "peakBacklog=UNMEASURED(no decision was ever reported)"
				: `peakBacklog=${peakBacklogBytes}B(${(peakBacklogBytes / (1024 * 1024)).toFixed(1)}MB, degrade mark 15.0MB)`;
		log(`peak upload backlog: ${peakBacklogLabel}`);

		const claims = [tabConstraints.claim];

		// THE REGRESSION GUARD. On a link that is fast enough the capture must run
		// at its best tier from start to finish, so the owner's quality push is not
		// quietly undone by the adaptive path. Asserted on the control arm only: on
		// a deliberately throttled arm a tier move is the feature doing its job.
		if (!IS_THROTTLED) {
			claims.push(
				!tierWatchTeeth || tierWatchLost > 0
					? `tier=UNPROVEN(watch teeth=${tierWatchTeeth}, lost=${tierWatchLost})`
					: tierMoves === 0
						? "tier=OK(never left the best tier)"
						: `tier=MOVED(${tierMoves})`,
			);
		}
		const cv = manifest.createVideo ?? {};
		claims.push(
			`filing=${cv.extensionContext === "meeting" && cv.meetingId === "abc-defg-hij" ? "OK" : `WRONG(${cv.extensionContext},${cv.meetingId})`}`,
		);
		const dur = manifest.completeMultipart?.durationInSecs;
		// Scale the window to the ACTUAL recording length. This used to be a
		// hardcoded 5..60s, which meant a perfectly good long run (e.g. the
		// 2-hour soak via PROOF_MINUTES) reported WRONG and the harness lied
		// about the product.
		// A SOAK run (PROOF_MINUTES set) is measuring survival, so its whole
		// point is that the recording did not die early — a 0.5x floor would
		// let a 2-hour run that stopped at 60 minutes report OK, which is the
		// same class of lie in the other direction. Soaks therefore get a tight
		// window; the short default modes keep the original loose "plausible,
		// not zero, not absurd" intent (the 10s default lands in 5..45s, close
		// to the old fixed 5..60s — note the ceiling IS slightly stricter, so a
		// freak 50s short run would now report WRONG).
		const targetSec = RECORD_MS / 1000;
		const isSoak = PROOF_MINUTES > 0;
		const minSec = isSoak
			? targetSec * 0.97
			: Math.max(1, targetSec * 0.5);
		const maxSec = isSoak ? targetSec * 1.05 : targetSec * 1.5 + 30;
		const durOk = typeof dur === "number" && dur >= minSec && dur <= maxSec;
		claims.push(
			`duration=${durOk ? `OK(${dur}s of ~${targetSec}s)` : `WRONG(${dur}, expected ~${targetSec}s)`}`,
		);

		const analyze = spawnSync(
			process.execPath,
			[join(here, "analyze-audio.mjs"), manifest.assembledFile],
			{ encoding: "utf8" },
		);
		const analyzeLine = (analyze.stdout ?? "").trim();
		log(`analyzer: ${analyzeLine}`);
		claims.push(`tone=${analyze.status === 0 ? "OK" : "MISSING"}`);

		// The LEVEL of that tone, not just its presence — see MIN_BAND_MEAN_DB.
		const bandMatch = analyzeLine.match(/mean_440band_dB=(-?[\d.]+)/);
		const bandDb = bandMatch ? Number(bandMatch[1]) : Number.NaN;
		claims.push(
			Number.isFinite(bandDb) && bandDb >= MIN_BAND_MEAN_DB
				? `band=OK(${bandDb}dB >= ${MIN_BAND_MEAN_DB}dB)`
				: `band=TOO_QUIET(${bandDb}dB, floor ${MIN_BAND_MEAN_DB}dB)`,
		);

		// Presence somewhere is not enough once the source is swapped mid-call:
		// require the tone in every segment, so a tap that died at the swap and
		// never recovered cannot pass.
		if (SWAP_TEST) {
			const seg = spawnSync(
				process.execPath,
				[join(here, "analyze-segments.mjs"), manifest.assembledFile, "4"],
				{ encoding: "utf8" },
			);
			const segLine = (seg.stdout ?? "").trim();
			log(`segments: ${segLine}`);
			claims.push(`allsegments=${seg.status === 0 ? "OK" : "GAP"}`);
		}

		const allOk = claims.every((c) => c.includes("OK"));
		// peakBacklogLabel is reported, never judged: it is evidence about the link,
		// not a pass criterion (and it deliberately stays OUT of `claims`, whose
		// every member must read OK for the run to pass).
		return verdict(
			allOk ? "PASS" : "FAIL",
			`metric=inpage-full-contract ${claims.join(" ")} ${peakBacklogLabel} bytes=${manifest.completeMultipart?.bytes ?? "?"} sustained_ms=${RECORD_MS} ${analyzeLine}`,
		);
	} catch (e) {
		return verdict("FAIL", `reason=harness-exception msg="${e?.message ?? e}"`);
	} finally {
		if (tierPoll) clearInterval(tierPoll);
		await context?.close().catch(() => {});
		server.kill();
		mock.kill();
	}
}

process.exit(await main());
