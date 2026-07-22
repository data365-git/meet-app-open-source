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
const RECORD_MS = SWAP_TEST ? 18_000 : SECOND_TEST ? 8_000 : 10_000;
const SERVE_PORT = 8443;
const FAKE_MEET_URL = `https://meet.google.com/abc-defg-hij?tone=${SECOND_TEST ? "stream" : "media"}${SWAP_TEST ? "&swap=8000" : ""}`;

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
	mock.stdout.on("data", (d) => log(String(d).trim()));
	let context;
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

		const { readFileSync, existsSync } = await import("node:fs");
		const manifestPath = join(outDir, "manifest.json");
		let manifest = null;
		for (let i = 0; i < 60; i++) {
			if (existsSync(manifestPath)) {
				manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (manifest.recordingComplete && manifest.assembledFile) break;
			}
			await new Promise((r) => setTimeout(r, 1000));
		}
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
			let manifest2 = null;
			for (let i = 0; i < 60; i++) {
				if (existsSync(manifest2Path)) {
					manifest2 = JSON.parse(readFileSync(manifest2Path, "utf8"));
					if (manifest2.recordingComplete && manifest2.assembledFile) break;
				}
				await new Promise((r) => setTimeout(r, 1000));
			}
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

		const claims = [];
		const cv = manifest.createVideo ?? {};
		claims.push(
			`filing=${cv.extensionContext === "meeting" && cv.meetingId === "abc-defg-hij" ? "OK" : `WRONG(${cv.extensionContext},${cv.meetingId})`}`,
		);
		const dur = manifest.completeMultipart?.durationInSecs;
		claims.push(
			`duration=${typeof dur === "number" && dur >= 5 && dur <= 60 ? `OK(${dur}s)` : `WRONG(${dur})`}`,
		);

		const analyze = spawnSync(
			process.execPath,
			[join(here, "analyze-audio.mjs"), manifest.assembledFile],
			{ encoding: "utf8" },
		);
		const analyzeLine = (analyze.stdout ?? "").trim();
		log(`analyzer: ${analyzeLine}`);
		claims.push(`tone=${analyze.status === 0 ? "OK" : "MISSING"}`);

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
		return verdict(
			allOk ? "PASS" : "FAIL",
			`metric=inpage-full-contract ${claims.join(" ")} sustained_ms=${RECORD_MS} ${analyzeLine}`,
		);
	} catch (e) {
		return verdict("FAIL", `reason=harness-exception msg="${e?.message ?? e}"`);
	} finally {
		await context?.close().catch(() => {});
		server.kill();
		mock.kill();
	}
}

process.exit(await main());
