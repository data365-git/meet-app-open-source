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

const RECORD_MS = 10_000;
const SERVE_PORT = 8443;
const FAKE_MEET_URL = "https://meet.google.com/abc-defg-hij?tone=media";

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

		const claims = [];
		const cv = manifest.createVideo ?? {};
		claims.push(
			`filing=${cv.extensionContext === "meeting" && cv.meetingId === "abc-defg-hij" ? "OK" : `WRONG(${cv.extensionContext},${cv.meetingId})`}`,
		);
		const dur = manifest.completeMultipart?.durationInSecs;
		claims.push(
			`duration=${typeof dur === "number" && dur >= 5 && dur <= 60 ? `OK(${dur}s)` : `WRONG(${dur})`}`,
		);

		const { spawnSync } = await import("node:child_process");
		const analyze = spawnSync(
			process.execPath,
			[join(here, "analyze-audio.mjs"), manifest.assembledFile],
			{ encoding: "utf8" },
		);
		const analyzeLine = (analyze.stdout ?? "").trim();
		log(`analyzer: ${analyzeLine}`);
		claims.push(`tone=${analyze.status === 0 ? "OK" : "MISSING"}`);

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
