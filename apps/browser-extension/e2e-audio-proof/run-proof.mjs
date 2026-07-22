// Autoresearch harness â€” machine proof that the meeting recording captures the
// Meet tab's audio. See autoresearch/meet-audio-proof-260719-1900/log.md.
//
// it-1 metric (this file): drive the real 2-click flow against a fake
// meet.google.com tab playing a 440Hz tone; PASS when the extension's OWN
// audio-guarantee instrumentation confirms live tab audio:
//   #view-recording visible AND #rec-audio-warn hidden AND #view-confirm never
//   shown, sustained for RECORD_MS.
// it-2 (later) additionally captures the uploaded bytes via a mock server and
// runs analyze-audio.mjs (tone-in-band) on the reassembled file.
//
// Technique (researched, sources in the log): headed Chromium via Playwright
// launchPersistentContext; --auto-select-desktop-capture-source auto-accepts the
// screen picker; tabCapture's activeTab grant comes from chrome.action.openPopup()
// (Chrome 127+) fired in the SW â€” empirical ladder below if it doesn't grant.
//
// Usage: node run-proof.mjs   (assumes `pnpm build` produced ../dist)
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
const FAKE_MEET_URL = "https://meet.google.com/abc-defg-hij?tone=1";

const log = (m) => console.log(`[proof] ${m}`);

function verdict(kind, detail) {
	console.log(`VERDICT=${kind} ${detail}`.trim());
	return kind === "PASS" ? 0 : 1;
}

async function main() {
	// Playwright core lives under @playwright/test in the web workspace.
	let chromium;
	for (const pkg of ["playwright", "@playwright/test", "playwright-core"]) {
		try {
			({ chromium } = require(pkg));
			break;
		} catch {}
	}
	if (!chromium) return verdict("BLOCKED", "reason=playwright-not-resolvable");

	// 1. Fake-meet HTTPS server + mock upload API (children; killed in finally).
	const server = spawn(
		process.execPath,
		[join(here, "serve.mjs"), String(SERVE_PORT)],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	const outDir = join(here, "out");
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

		const userDataDir = mkdtempSync(join(tmpdir(), "proof-profile-"));
		context = await chromium.launchPersistentContext(userDataDir, {
			headless: false, // capture APIs need a headed session (researched)
			viewport: { width: 1280, height: 800 },
			args: [
				`--disable-extensions-except=${distDir}`,
				`--load-extension=${distDir}`,
				`--auto-select-desktop-capture-source=Entire screen`,
				"--autoplay-policy=no-user-gesture-required",
				`--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${SERVE_PORT}`,
				"--ignore-certificate-errors",
			],
		});

		// 2. Extension service worker + id.
		let [sw] = context.serviceWorkers();
		if (!sw) {
			sw = await context
				.waitForEvent("serviceworker", { timeout: 15_000 })
				.catch(() => null);
		}
		if (!sw) return verdict("FAIL", "reason=no-service-worker");
		const extensionId = new URL(sw.url()).host;
		log(`extension ${extensionId} loaded`);

		// 3. Seed settings: popup's signed-in gate passes; uploads aim at a dead
		//    localhost port (fine in it-1 â€” the durable retry queue absorbs upload
		//    failures without touching the recording).
		await sw.evaluate(async () => {
			await chrome.storage.local.set({
				capExtSettings: {
					apiKey: "proof-fake-key",
					apiBaseUrl: "http://localhost:3001",
				},
				// Past first-run: the onboarding screen would otherwise gate the
				// popup's one-click auto-fire (measured in it-1).
				capExtFirstRun: false,
			});
		});

		// Diagnostics: surface every page + its console (popup auto-fire is
		// otherwise invisible when it silently declines).
		context.on("page", (p) => {
			log(`page opened: ${p.url()}`);
			p.on("console", (m) => log(`console[${p.url().slice(-30)}]: ${m.text()}`));
		});

		// 4. Fake Meet tab (tone auto-plays via ?tone=1).
		const meetPage = await context.newPage();
		await meetPage.goto(FAKE_MEET_URL, { waitUntil: "domcontentloaded" });
		const toneState = await meetPage.locator("#status").textContent();
		log(`meet tab: ${toneState}`);

		// 5. Gesture for tabCapture's activeTab grant. Measured ladder so far:
		//    - programmatic chrome.action.openPopup(): popup runs, activeTab NOT
		//      granted â†’ guarantee modal fired (it-2, correct fail-safe).
		//    - CDP keyboard.press("Control+Shift+9"): does NOT reach
		//      chrome.commands (it-3 â€” browser-chrome shortcuts need real input).
		//    - THIS RUNG (it-4): a REAL OS key event via WScript SendKeys to the
		//      focused Chromium window â€” indistinguishable from a user keypress,
		//      so the `commands` surface grants activeTab like a genuine gesture.
		await meetPage.bringToFront();
		await meetPage.waitForTimeout(500);
		// Win32 keystroke (SetForegroundWindow + keybd_event). WScript.SendKeys
		// reported success while the chord went to whatever window actually held
		// the foreground, which read as "the recorder never opened" - a product
		// failure that had not happened. See send-shortcut.ps1.
		const sk = spawn("powershell.exe", [
			"-NoProfile",
			"-ExecutionPolicy", "Bypass",
			"-File", join(here, "send-shortcut.ps1"),
			"-TitlePart", "Fake Meet",
		]);
		const skOut = await new Promise((resolve) => {
			let out = "";
			sk.stdout.on("data", (d) => (out += d));
			sk.on("close", () => resolve(out.trim()));
		});
		log(`os-sendkeys: ${skOut}`);

		// 6. Recorder tab should appear (auto-fire path).
		let recorderPage = context
			.pages()
			.find((p) => p.url().includes("recorder.html"));
		if (!recorderPage) {
			recorderPage = await context
				.waitForEvent("page", {
					predicate: (p) => p.url().includes("recorder.html"),
					timeout: 10_000,
				})
				.catch(() => null);
		}
		if (!recorderPage)
			return verdict("FAIL", "reason=recorder-tab-never-opened (auto-fire did not run)");
		await recorderPage.waitForLoadState("domcontentloaded");
		log(`recorder tab: ${recorderPage.url()}`);

		// 7. ONE Start click â€” the genuine gesture for getDisplayMedia; the
		//    flag auto-picks "Entire screen".
		await recorderPage.locator("#btn-start").click();
		// Did the click actually reach startRecording? The button disables itself
		// as its first act, so this separates "the click never landed" from "the
		// click landed and something after it is hanging" - two causes that look
		// identical from the outside (idle view, no message).
		await recorderPage.waitForTimeout(1500);
		const clickLanded = await recorderPage
			.evaluate(() => (document.getElementById("btn-start") || {}).disabled)
			.catch(() => "unknown");
		log(`btn-start disabled after click: ${clickLanded}`);

		// 8. Outcome: recording view vs confirm modal (= audio guarantee FAILED)
		//    vs error view.
		const outcome = await Promise.race([
			recorderPage
				.locator("#view-recording")
				.waitFor({ state: "visible", timeout: 20_000 })
				.then(() => "recording"),
			recorderPage
				.locator("#view-confirm")
				.waitFor({ state: "visible", timeout: 20_000 })
				.then(() => "confirm"),
			recorderPage
				.locator("#view-error")
				.waitFor({ state: "visible", timeout: 20_000 })
				.then(() => "error"),
		]).catch(() => "timeout");

		if (outcome === "confirm") {
			const msg = await recorderPage.locator("#view-confirm .msg").textContent();
			return verdict("FAIL", `reason=audio-guarantee-confirm-shown msg="${msg}"`);
		}
		if (outcome === "error") {
			const msg = await recorderPage.locator("#error-msg").textContent();
			return verdict("FAIL", `reason=recorder-error msg="${msg}"`);
		}
		if (outcome !== "recording") {
			// Diagnose: which view IS visible, and what do the message nodes say?
			const dump = await recorderPage.evaluate(() => {
				const vis = (id) => {
					const el = document.getElementById(id);
					return el && !el.classList.contains("hidden");
				};
				const txt = (id) => document.getElementById(id)?.textContent?.trim() ?? "";
				return {
					idle: vis("view-idle"),
					confirm: vis("view-confirm"),
					recording: vis("view-recording"),
					uploading: vis("view-uploading"),
					error: vis("view-error"),
					idleMsg: txt("idle-msg"),
					errorMsg: txt("error-msg"),
					recWarn: txt("rec-audio-warn"),
				};
			});
			await recorderPage
				.screenshot({ path: join(here, "timeout-state.png") })
				.catch(() => {});
			return verdict(
				"FAIL",
				`reason=recording-never-started state=${JSON.stringify(dump)}`,
			);
		}
		log("recording started");

		// 9. Sustain: rec-audio-warn must stay hidden the whole window.
		//    BACKGROUND MODE (PROOF_BACKGROUND=1): the owner presents slides from
		//    ANOTHER desktop app during the call, so Chrome sits in the background
		//    for minutes. Recall.ai documents that tab audio can freeze when that
		//    happens. Here we actually do it: 6s foreground, ~8s with Chrome behind
		//    another window, 6s foreground — then the analyzer checks the tone is
		//    present in EVERY third, not merely somewhere in the file.
		const backgroundTest = process.env.PROOF_BACKGROUND === "1";
		const recordMs = backgroundTest ? 20_000 : RECORD_MS;
		const start = Date.now();
		let backgrounded = false;
		while (Date.now() - start < recordMs) {
			if (await recorderPage.locator("#rec-audio-warn").isVisible()) {
				const warn = await recorderPage.locator("#rec-audio-warn").textContent();
				return verdict("FAIL", `reason=audio-warning-during-recording warn="${warn}"`);
			}
			if (backgroundTest && !backgrounded && Date.now() - start > 6_000) {
				backgrounded = true;
				log("backgrounding Chrome (simulating 'presenting from another app')");
				await new Promise((resolve) => {
					const p = spawn("powershell.exe", [
						"-NoProfile",
						"-Command",
						// Bring an unrelated window to the front for 8s, then restore
						// focus to the Chromium window by title.
						"$sh = New-Object -ComObject WScript.Shell; " +
							"Start-Process notepad; Start-Sleep -Seconds 8; " +
							"Get-Process notepad -ErrorAction SilentlyContinue | Stop-Process -Force; " +
							"$sh.AppActivate('Fake Meet') | Out-Null; 'done'",
					]);
					p.on("close", resolve);
				});
				log("Chrome back in the foreground");
			}
			await recorderPage.waitForTimeout(500);
		}

		// 10. Stop â†’ the extension uploads to the mock; wait for completion.
		await recorderPage.locator("#btn-stop").click();
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

		// 11. Full-contract assertions.
		const claims = [];
		const cv = manifest.createVideo ?? {};
		claims.push(
			`filing=${cv.extensionContext === "meeting" && cv.meetingId === "abc-defg-hij" ? "OK" : `WRONG(${cv.extensionContext},${cv.meetingId})`}`,
		);
		const dur = manifest.completeMultipart?.durationInSecs;
		claims.push(
			`duration=${typeof dur === "number" && dur >= 5 && dur <= 60 ? `OK(${dur}s)` : `WRONG(${dur})`}`,
		);

		// 12. THE metric: does the assembled recording carry the 440Hz tone?
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
			`metric=full-contract ${claims.join(" ")} sustained_ms=${RECORD_MS} ${analyzeLine}`,
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
