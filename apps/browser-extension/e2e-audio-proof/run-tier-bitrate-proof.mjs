// MEASURED PROOF that a capture-tier drop actually reduces the bytes the
// capture produces per second.
//
// WHY THIS EXISTS
// ---------------
// The adaptive-capture feature is only worth its complexity if a lower tier
// genuinely makes the capture cheaper. Until this file, nothing measured that.
// The soak proofs show a slow-link run COMPLETING and show tier lines being
// emitted, but "the tier moved" is not the same claim as "fewer bytes came out
// of the encoder": a tier whose constraints the source silently refused would
// still log a move, still show the user a notice, and still produce exactly as
// many bytes as before. That assumption is what this harness turns into a
// number.
//
// THE METRIC (computed by this script, never asserted by a model):
//     tier bytes/s full=<X> minimal=<Y> ratio=<R>
// with R = X / Y, and the run failing unless R >= TIER_PROOF_MIN_RATIO (3).
//
// WHAT THE HEADLINE MEASURES, AND WHY THAT SHAPE
// ----------------------------------------------
// It measures THE CAPS AND ONLY THE CAPS: two complete recordings of the same
// surface, both recorders constructed with IDENTICAL MediaRecorder options, the
// only difference between them being the tier's frameRate/width/height applied
// to the live track through the product's own captureTierConstraintSteps().
//
// That is deliberately the weakest of the mechanisms a tier could use, and it is
// deliberately the one under test, because it is the ONLY one production has
// mid-recording. `videoBitsPerSecond` cannot be changed on a live MediaRecorder,
// and rebuilding the recorder mid-run is forbidden here for a hard-won reason
// (interleaved fMP4 init segments corrupt the multipart upload — see the header
// of src/content/inpage-recorder.ts). So a tier drop that only works when the
// encoder is also rebuilt would be a tier drop that never works in the product.
// Measuring the caps alone keeps the number honest about what actually ships.
//
// WHAT IS HELD CONSTANT so the ratio means what it says:
//  • ONE captured surface, ONE getDisplayMedia stream, ONE video track. Both
//    windows encode the same fake-Meet page painting the same deterministic
//    canvas load (fake-meet/index.html ?load=&loadhz=), so the difference
//    between the arms is the TIER and nothing else. Recording two different
//    screens would measure the wallpaper.
//  • THE TAB, NOT THE SCREEN (`preferCurrentTab`, auto-accepted by
//    --auto-accept-this-tab-capture). MEASURED, and it invalidated a whole run:
//    capturing "Entire screen" makes the input signal whatever else is on the
//    machine. The same full tier measured 186 kB/s while a developer session was
//    live on the desktop and 11 kB/s on the same machine twenty minutes later
//    with everything quiet — a 17x swing that has nothing to do with the tiers.
//    Capturing the tab makes the deterministic canvas 100% of the recorded
//    surface, so the number is a property of the harness, not of the desktop.
//  • IDENTICAL recorder options in both windows (same mime, same
//    videoBitsPerSecond, same audioBitsPerSecond). See above.
//  • A settle pause after every applyConstraints, before the recorder starts.
//    The screen capturer takes a moment to move to a new frame rate / scale, and
//    encoding through that transition would charge one tier for the other's
//    frames.
//  • Equal-length windows, each a COMPLETE recording — start to stop — so every
//    byte it produced is counted, including the flush at stop.
//  • A DRIFT CONTROL: the full tier is recorded TWICE, once before the minimal
//    window and once after it, and the two must agree within
//    TIER_PROOF_MAX_DRIFT. If a machine's own load makes two identical windows
//    disagree by more than that, no reading taken across them means anything and
//    the run says so instead of reporting a number.
//
// THE SOURCE HAS TO MOVE, and that is the calibration this proof depends on.
// The fake-Meet load canvas takes a repaint RATE (`?loadhz=`). The soak harness
// runs it at 1 Hz, which is right for ITS question (can a 6-minute upload finish
// on a slow link) but wrong for this one: at 1 Hz the screen capturer sees ~1
// distinct frame per second, so capping the capture from 24 fps to 10 fps
// removes nothing that was there — measured, the caps came out at 1.81x, almost
// all of it from the resolution step alone. That is a property of a nearly
// static fixture, not of the tiers. A real screen recording (a speaker's video,
// a scrolling document, an animating slide) changes on most frames, which is the
// regime where a capture produces more than a slow link can carry — i.e. the
// only regime in which this feature is ever asked to do anything. So the default
// here paints at 30 Hz, at or above the full tier's 24 fps ceiling, and the log
// prints the load parameters on every run so the fixture is never implicit.
//
// MEASURED THE HARD WAY, worth knowing before editing: the production container
// is `video/mp4` (pickMimeType prefers h264), and Chrome's mp4 muxer BUFFERS the
// whole file — with `start(1000)` a 20 s recording delivered ~760 bytes during
// the run and 1.7 MB in one blob at stop. So bytes cannot be attributed to a
// moment in time in that container; an earlier version of this harness tried and
// measured pure muxer behaviour (ratio 1.03 for a 12x pixel-rate difference).
// Hence complete recordings for the headline, and a self-test before the mid-run
// arm that proves the container it uses really does stream.
//
// THE SECOND ARM (corroboration, never the gate): ONE MediaRecorder running
// across a real applyConstraints() drop, bytes/s before vs after — the live
// shape of what production does. It is not the gate because it can only run in a
// container that streams (which is not always production's) and because it has
// been measured to be noisy: two windows at the SAME tier have disagreed by more
// than the effect being looked for. It carries its own drift control and reports
// `unreliable(...)` rather than a number when that happens.
//
// Usage: node run-tier-bitrate-proof.mjs   (needs a headed Windows desktop and
// the fake-meet cert in ./certs, exactly like the sibling soak harnesses)
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcModule = join(here, "..", "src", "shared", "recording-quality.ts");
const require = createRequire(join(here, "..", "..", "web", "package.json"));

const SERVE_PORT = Number(process.env.TIER_PROOF_PORT) || 8443;
/** Length of each measured recording. Long enough that the one-off keyframe at
 * the start is a rounding error against the steady-state rate. */
const WINDOW_MS = Number(process.env.TIER_PROOF_WINDOW_MS) || 20_000;
/** Pause after applyConstraints, before the recorder starts: lets the screen
 * capturer settle into the new frame rate / scale. Not encoded, not counted. */
const SETTLE_MS = Number(process.env.TIER_PROOF_SETTLE_MS) || 4_000;
/** The bar the reduction must clear. Env-overridable only as a deliberate,
 * visible re-baselining — not something a passing run ever needs. */
const MIN_RATIO = Number(process.env.TIER_PROOF_MIN_RATIO ?? 3);
/**
 * How far the two SAME-TIER control windows may disagree before the headline is
 * refused. 1.35x is well under the 3x effect being looked for, so a run that
 * clears both bars cannot be drift wearing the effect's name.
 */
const MAX_DRIFT = Number(process.env.TIER_PROOF_MAX_DRIFT ?? 1.35);
/**
 * The full tier must produce at least this much, or the run refuses to report a
 * ratio at all.
 *
 * WHY IT IS NOT OPTIONAL. A ratio is a comparison, and comparing two nearly
 * empty recordings is arithmetic on noise: a frozen surface encodes to a trickle
 * of skip-frames at EVERY tier, which lands the ratio near 1.00 and looks
 * exactly like "the tiers do nothing". That is a false claim about the product
 * drawn from a broken fixture, and it happened: 11 kB/s at the full tier, ratio
 * 1.12, from a run whose captured surface had gone static.
 */
const MIN_FULL_BYTES_PER_SECOND =
	Number(process.env.TIER_PROOF_MIN_FULL_BPS) || 40_000;
// The captured surface's load. Same knobs, same meaning as run-proof-inpage.mjs
// (its header carries the calibration table). See "THE SOURCE HAS TO MOVE"
// above for why the repaint rate defaults higher here than in the soak.
const VIDEO_LOAD_CELLS =
	process.env.PROOF_VIDEO_LOAD === undefined
		? 20
		: Number(process.env.PROOF_VIDEO_LOAD);
const VIDEO_LOAD_HZ =
	process.env.PROOF_VIDEO_LOAD_HZ === undefined
		? 30
		: Number(process.env.PROOF_VIDEO_LOAD_HZ);
const FAKE_MEET_URL =
	"https://meet.google.com/abc-defg-hij?tone=media" +
	(VIDEO_LOAD_CELLS > 0
		? `&load=${VIDEO_LOAD_CELLS}&loadhz=${VIDEO_LOAD_HZ}`
		: "");

const log = (m) => console.log(`[tier-bitrate] ${m}`);

function verdict(kind, detail) {
	console.log(`VERDICT=${kind} ${detail}`.trim());
	return kind === "PASS" ? 0 : 1;
}

/**
 * Bundle the REAL src/shared/recording-quality.ts and hand it to the page as a
 * global. Re-typing the tier table or the constraint steps here would defeat the
 * whole point: this proof must break when the product's tiers change, not when a
 * copy of them drifts. (Same technique, same reason, as
 * assert-tab-constraints.mjs.)
 */
function bundleRecordingQualityForPage() {
	const esbuild = require(join(here, "..", "node_modules", "esbuild"));
	const built = esbuild.buildSync({
		entryPoints: [srcModule],
		bundle: true,
		format: "iife",
		globalName: "RQ",
		write: false,
		platform: "browser",
	});
	return built.outputFiles[0].text;
}

/**
 * The measurement, run inside the page against ONE live display-capture track.
 *
 * Returns raw byte counts and the track settings the browser actually reported
 * at each step, so the log can show whether the caps were HONOURED — a refused
 * constraint set is the exact failure this proof exists to expose, and it must
 * be visible in the output rather than hidden inside a ratio.
 */
async function measureInPage(page, { windowMs, settleMs }) {
	return page.evaluate(
		async ({ windowMs, settleMs }) => {
			const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
			const RQ = window.RQ;
			const stream = window.__proofStream;
			const track = stream.getVideoTracks()[0];
			const mimeType = RQ.pickMimeType();
			const full = RQ.captureTierFor("full");
			const minimal = RQ.captureTierFor("minimal");

			// IDENTICAL for every window in this run. The headline isolates the
			// caps, so the encoder settings must not be allowed to vary with the
			// tier — and they cannot vary in production either, because
			// videoBitsPerSecond is fixed when the MediaRecorder is constructed and
			// the recorder is never rebuilt on a tier move.
			const recorderOptions = {
				videoBitsPerSecond: full.videoBitsPerSecond,
				audioBitsPerSecond: full.audioBitsPerSecond,
			};

			const applied = [];
			/** Apply a tier the same way every recorder path does: the shared
			 * steps, each in its own try/catch, refusals recorded not swallowed. */
			async function applyTier(tier, label) {
				const refusals = [];
				for (const step of RQ.captureTierConstraintSteps(tier)) {
					try {
						await track.applyConstraints(step);
					} catch (e) {
						refusals.push(String(e && e.name ? e.name : e));
					}
				}
				const s = track.getSettings();
				const note = {
					label,
					tier: tier.name,
					width: s.width,
					height: s.height,
					frameRate: s.frameRate
						? Math.round(s.frameRate * 10) / 10
						: s.frameRate,
					refusals,
				};
				applied.push(note);
				return note;
			}

			/**
			 * A COMPLETE recording of `windowMs` — every byte it produced,
			 * including the blob flushed at stop.
			 *
			 * Counting the whole file is not a convenience, it is the only correct
			 * option in a buffering container (see the header). The tiny one-off
			 * cost it includes — the opening keyframe and the container header — is
			 * paid by EVERY window and is a rounding error against a 20 s steady
			 * state.
			 */
			async function recordWhole(mime = mimeType) {
				let bytes = 0;
				const rec = new MediaRecorder(stream, {
					mimeType: mime,
					...recorderOptions,
				});
				rec.ondataavailable = (e) => {
					bytes += e.data.size;
				};
				const stopped = new Promise((r) => {
					rec.onstop = r;
				});
				const startedAt = performance.now();
				rec.start(1000);
				await sleep(windowMs);
				const elapsedMs = performance.now() - startedAt;
				rec.stop();
				await stopped;
				return { bytes, elapsedMs };
			}

			/**
			 * Does `mime` deliver bytes DURING a recording, or only at stop?
			 *
			 * The mid-run arm attributes bytes to a moment in time, which is only
			 * meaningful in a container that streams. Production's mp4 does not, and
			 * silently reporting a muxer's flush pattern as "the tier did nothing"
			 * is exactly the false measurement this self-test exists to prevent.
			 *
			 * "Any bytes at all" was the first criterion and it was TOO WEAK —
			 * measured: mp4 passed it on a container header of a few hundred bytes
			 * and then delivered zero-byte measurement windows. The criterion is
			 * therefore comparative: what arrives DURING the recording must outweigh
			 * what is flushed at stop, which is only true of a container that really
			 * is streaming its payload.
			 */
			async function streamsDuringRecording(mime) {
				if (!MediaRecorder.isTypeSupported(mime)) return false;
				let during = 0;
				let atStop = 0;
				let running = true;
				const rec = new MediaRecorder(stream, { mimeType: mime });
				rec.ondataavailable = (e) => {
					if (running) during += e.data.size;
					else atStop += e.data.size;
				};
				const stopped = new Promise((r) => {
					rec.onstop = r;
				});
				rec.start(500);
				await sleep(4000);
				running = false;
				rec.stop();
				await stopped;
				return during > atStop && during > 0;
			}

			/**
			 * ONE recorder, a real applyConstraints() drop in the middle of it —
			 * the closest model of production, where a tier move never rebuilds the
			 * MediaRecorder. Needs a streaming container to attribute bytes to
			 * before/after, so it runs in `mime` (which may not be production's) and
			 * says so in the result.
			 *
			 * IT CARRIES ITS OWN CONTROL, and that is not decoration. Two windows run
			 * back to back at the SAME tier BEFORE the drop: if this container's
			 * chunk delivery lags, or the encoder is still ramping, those two windows
			 * disagree even though nothing changed — and any "reduction" measured
			 * across the drop would be that same artefact wearing a meaningful name.
			 * An early run of this harness produced exactly that: an apparent 0.26x
			 * (bytes going UP after a drop). So the control's own drift is measured
			 * and reported, and the arm calls itself unreliable when the drift is too
			 * large to read a real effect through.
			 */
			async function recordMidRunDrop(mime) {
				let bucket = null;
				const buckets = { control: 0, before: 0, after: 0 };
				const rec = new MediaRecorder(stream, {
					mimeType: mime,
					...recorderOptions,
				});
				rec.ondataavailable = (e) => {
					if (bucket) buckets[bucket] += e.data.size;
				};
				const stopped = new Promise((r) => {
					rec.onstop = r;
				});
				rec.start(1000);
				await sleep(settleMs);
				// Control window: nothing changes between this one and the next.
				bucket = "control";
				let t0 = performance.now();
				await sleep(windowMs);
				bucket = null;
				const controlMs = performance.now() - t0;
				bucket = "before";
				t0 = performance.now();
				await sleep(windowMs);
				bucket = null;
				const beforeMs = performance.now() - t0;
				const dropped = await applyTier(minimal, "midrun-drop");
				await sleep(settleMs);
				bucket = "after";
				t0 = performance.now();
				await sleep(windowMs);
				bucket = null;
				const afterMs = performance.now() - t0;
				rec.stop();
				await stopped;
				return {
					control: { bytes: buckets.control, elapsedMs: controlMs },
					before: { bytes: buckets.before, elapsedMs: beforeMs },
					after: { bytes: buckets.after, elapsedMs: afterMs },
					dropped,
					mime,
				};
			}

			// ── THE HEADLINE: caps only, three windows ───────────────────────
			// full → minimal → full. The two full windows bracket the minimal one,
			// so any slow drift in the machine or the fixture shows up as a
			// disagreement between them rather than as a fake effect.
			const atFull1 = await applyTier(full, "full-1");
			await sleep(settleMs);
			const wFull1 = await recordWhole();
			const atMinimal = await applyTier(minimal, "minimal");
			await sleep(settleMs);
			const wMinimal = await recordWhole();
			const atFull2 = await applyTier(full, "full-2");
			await sleep(settleMs);
			const wFull2 = await recordWhole();

			// ── Corroboration: a real mid-run drop on ONE recorder ───────────
			let midRunMime = null;
			for (const candidate of [
				mimeType,
				"video/webm;codecs=vp9,opus",
				"video/webm;codecs=vp8,opus",
				"video/webm",
			]) {
				// eslint-disable-next-line no-await-in-loop -- deliberately serial
				if (await streamsDuringRecording(candidate)) {
					midRunMime = candidate;
					break;
				}
			}
			let midRun = null;
			if (midRunMime) {
				await applyTier(full, "midrun-start");
				await sleep(settleMs);
				midRun = await recordMidRunDrop(midRunMime);
			}

			return {
				mimeType,
				midRunMime,
				recorderOptions,
				tiers: { full, minimal },
				settings: [atFull1, atMinimal, atFull2],
				caps: { full1: wFull1, minimal: wMinimal, full2: wFull2 },
				midRun: midRun
					? {
							control: midRun.control,
							before: midRun.before,
							after: midRun.after,
						}
					: null,
				applied,
			};
		},
		{ windowMs, settleMs },
	);
}

const rate = (w) => (w.bytes / w.elapsedMs) * 1000;
const round = (n) => Math.round(n);

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
	let context;
	try {
		await new Promise((resolve, reject) => {
			const t = setTimeout(
				() => reject(new Error("serve.mjs did not start")),
				5000,
			);
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

		const userDataDir = mkdtempSync(join(tmpdir(), "tier-bitrate-profile-"));
		context = await chromium.launchPersistentContext(userDataDir, {
			headless: false, // screen capture needs a headed session
			viewport: { width: 1280, height: 800 },
			args: [
				// Auto-answers the picker with THIS tab, which is what
				// preferCurrentTab below asks for.
				"--auto-accept-this-tab-capture",
				"--auto-select-desktop-capture-source=Entire screen",
				"--autoplay-policy=no-user-gesture-required",
				`--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${SERVE_PORT}`,
				"--ignore-certificate-errors",
			],
		});
		const page = context.pages()[0] ?? (await context.newPage());
		await page.goto(FAKE_MEET_URL, { waitUntil: "domcontentloaded" });
		log(`fake meet loaded: load=${VIDEO_LOAD_CELLS} cells @ ${VIDEO_LOAD_HZ} Hz`);

		// The REAL tier table / constraint steps / mime picker, compiled from
		// source into this page.
		await page.addScriptTag({ content: bundleRecordingQualityForPage() });
		const tierNames = await page.evaluate(() =>
			window.RQ.CAPTURE_TIERS.map((t) => t.name),
		);
		if (!tierNames.includes("full") || !tierNames.includes("minimal")) {
			return verdict(
				"FAIL",
				`reason=tier-table-missing-a-tier tiers=${tierNames.join(",")}`,
			);
		}

		// getDisplayMedia needs a real user gesture; a Playwright click is one.
		// The picker is auto-answered by --auto-accept-this-tab-capture.
		await page.evaluate(() => {
			const b = document.createElement("button");
			b.id = "proof-capture";
			b.textContent = "start capture";
			b.style.cssText =
				"position:fixed;top:4px;left:4px;z-index:99999;padding:8px";
			b.addEventListener("click", () => {
				window.__proofStreamPromise = navigator.mediaDevices.getDisplayMedia({
					video: true,
					audio: false,
					// The fake-Meet tab itself: the deterministic canvas load is then
					// the whole recorded surface, not a window floating on a desktop
					// whose activity would set the bitrate instead.
					preferCurrentTab: true,
				});
			});
			document.body.appendChild(b);
		});
		await page.click("#proof-capture");
		const acquired = await page.evaluate(async () => {
			try {
				window.__proofStream = await window.__proofStreamPromise;
				const t = window.__proofStream.getVideoTracks()[0];
				const s = t.getSettings();
				return {
					ok: true,
					width: s.width,
					height: s.height,
					frameRate: s.frameRate,
					surface: s.displaySurface,
				};
			} catch (e) {
				return { ok: false, error: String(e) };
			}
		});
		if (!acquired.ok) {
			return verdict(
				"FAIL",
				`reason=no-display-capture detail=${acquired.error}`,
			);
		}
		log(
			`display capture acquired: ${acquired.width}x${acquired.height} @ ${acquired.frameRate} fps surface=${acquired.surface}`,
		);

		log(
			`measuring: ${WINDOW_MS / 1000}s complete recording per window, ${SETTLE_MS / 1000}s settle after each applyConstraints`,
		);
		const r = await measureInPage(page, {
			windowMs: WINDOW_MS,
			settleMs: SETTLE_MS,
		});

		log(
			`mime=${r.mimeType} midrun-mime=${r.midRunMime ?? "none-streams"} ` +
				`recorder-options-identical-in-every-window=video:${r.recorderOptions.videoBitsPerSecond}bps`,
		);
		for (const s of r.applied) {
			log(
				`applied ${s.label}: tier=${s.tier} ${s.width}x${s.height} @ ${s.frameRate} fps` +
					(s.refusals.length > 0 ? ` refused=[${s.refusals.join(",")}]` : ""),
			);
		}

		const full1 = rate(r.caps.full1);
		const full2 = rate(r.caps.full2);
		const minimal = rate(r.caps.minimal);

		// A zero-byte window is a broken measurement, not an infinite ratio. Say so
		// instead of dividing by it and reporting a spectacular pass.
		for (const [name, value] of [
			["full-1", full1],
			["minimal", minimal],
			["full-2", full2],
		]) {
			if (!(value > 0)) return verdict("FAIL", `reason=no-bytes-in-${name}`);
		}

		// The two same-tier windows are the mean the headline uses, so a one-off
		// spike in either cannot carry the ratio on its own.
		const fullMean = (full1 + full2) / 2;
		const drift = Math.max(full1 / full2, full2 / full1);
		log(
			`control: the SAME (full) tier recorded twice — ${round(full1)} B/s then ${round(full2)} B/s, drift=${drift.toFixed(2)}x (max ${MAX_DRIFT})`,
		);

		// The fixture has to be carrying real content before any ratio it produces
		// means anything. Checked BEFORE the ratio is computed, so a collapsed
		// surface reports what actually went wrong instead of a number.
		if (fullMean < MIN_FULL_BYTES_PER_SECOND) {
			return verdict(
				"BLOCKED",
				`reason=captured-surface-too-quiet full=${round(fullMean)}B/s floor=${MIN_FULL_BYTES_PER_SECOND}B/s ` +
					"(the fake-Meet load canvas is not reaching the encoder; a ratio between two near-empty " +
					"recordings would say nothing about the tiers)",
			);
		}
		if (!(drift <= MAX_DRIFT)) {
			return verdict(
				"BLOCKED",
				`reason=control-drift-too-large drift=${drift.toFixed(2)}x max=${MAX_DRIFT} ` +
					`full-1=${round(full1)}B/s full-2=${round(full2)}B/s ` +
					"(two windows at the SAME tier disagreed, so a reading taken across them would be that noise)",
			);
		}

		// Corroboration, reported honestly either way, never the gate.
		const MAX_MIDRUN_DRIFT = 1.5;
		let midRun = "unmeasurable(no-streaming-container)";
		if (r.midRun) {
			const cControl = rate(r.midRun.control);
			const cBefore = rate(r.midRun.before);
			const cAfter = rate(r.midRun.after);
			if (!(cControl > 0 && cBefore > 0 && cAfter > 0)) {
				midRun = "unmeasurable(zero-bytes-in-a-window)";
				log(`mid-run arm: ${midRun}`);
			} else {
				const d = Math.max(cControl / cBefore, cBefore / cControl);
				const reduction = cBefore / cAfter;
				midRun =
					d > MAX_MIDRUN_DRIFT
						? `unreliable(control-drift=${d.toFixed(2)}x)`
						: `${reduction.toFixed(2)}x`;
				log(
					`mid-run arm (ONE recorder, real applyConstraints drop, ${r.midRunMime}): ` +
						`control=${round(cControl)} B/s before=${round(cBefore)} B/s after=${round(cAfter)} B/s ` +
						`control-drift=${d.toFixed(2)}x reduction=${midRun}` +
						(d > MAX_MIDRUN_DRIFT
							? " — two windows at the SAME tier disagreed by more than the effect being looked for, so this arm reads nothing"
							: reduction < 1
								? " — below 1.00: the mid-run drop produced MORE bytes, not fewer"
								: ""),
				);
			}
		} else {
			log(`mid-run arm: ${midRun}`);
		}

		const ratio = fullMean / minimal;
		const headline = `tier bytes/s full=${round(fullMean)} minimal=${round(minimal)} ratio=${ratio.toFixed(2)}`;
		console.log(headline);

		if (!(ratio >= MIN_RATIO)) {
			return verdict(
				"FAIL",
				`metric=tier-bytes-per-second ${headline} floor=${MIN_RATIO} ` +
					`drift=${drift.toFixed(2)}x midrun=${midRun}`,
			);
		}
		return verdict(
			"PASS",
			`metric=tier-bytes-per-second ${headline} floor=${MIN_RATIO} ` +
				`drift=${drift.toFixed(2)}x midrun=${midRun} ` +
				`load=${VIDEO_LOAD_CELLS}cells@${VIDEO_LOAD_HZ}Hz`,
		);
	} catch (e) {
		return verdict(
			"FAIL",
			`reason=harness-error detail=${String(e).slice(0, 300)}`,
		);
	} finally {
		await context?.close().catch(() => {});
		server.kill();
	}
}

process.exit(await main());
