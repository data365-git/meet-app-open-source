// Real-Chrome acceptance assertion for the NEW tab-audio constraint object.
//
// WHY THIS EXISTS
// ---------------
// `tabAudioConstraints()` (src/shared/recording-quality.ts) hands Chrome a
// LEGACY `mandatory: {...}` dictionary carrying the three audio-processing flags
// in both the modern and the goog-prefixed spelling. A unit test can only assert
// the shape of that object; it cannot tell us whether a real Chrome ACCEPTS it.
// The failure mode we are guarding against is silent and total: if Chrome's
// legacy parser refused the flag names, every meeting recording would lose the
// other participant's voice, and the only place that shows up is a real browser.
//
// WHAT IT ASSERTS (both arms run in a REAL headed Chrome with the real
// extension loaded, and both carry a CONTROL that proves the arm can fail):
//
//   ARM A — the literal object, in the only context where `chromeMediaSource:
//   "tab"` means anything (an extension page). We call
//   `getUserMedia({ audio: tabAudioConstraints(id) })` with the real exported
//   function (compiled from source here, never hand-copied). It must NOT be
//   rejected at the CONSTRAINT level; it may only fail later, at tab-capture
//   resolution, because this harness cannot mint a real streamId.
//   Control: the same call site with a genuinely unsatisfiable constraint must
//   produce a constraint-level rejection — otherwise our detector is blind and
//   arm A is reported as FAILING rather than passing vacuously.
//
//   ARM B — the three flag NAMES, against a LIVE audio track. Chrome is launched
//   with a fake audio device, so this is deterministic and does not depend on
//   the machine owning a microphone.
//     B-names: `navigator.mediaDevices.getSupportedConstraints()` must list all
//       three. Control: an invented constraint name must be ABSENT, which proves
//       that list is a real allowlist and not something that says yes to
//       anything.
//     B: `getUserMedia({ audio: {...TAB_AUDIO_CONSTRAINTS} })` must RESOLVE with
//       an audio track whose readyState is "live" — the literal "resolves with a
//       live track rather than being rejected" guarantee.
//     B-apply: `track.applyConstraints(TAB_AUDIO_CONSTRAINTS)` — the sanctioned
//       post-acquisition route — must not be rejected and the track must survive.
//       Control: an impossible constraint on the SAME track must be rejected,
//       proving applyConstraints here really does police what it is given.
//
//   Deliberately NOT asserted in arm B: that getSettings() echoes the three
//   flags back as false. That was tried and MEASURED to be blind — Chrome's fake
//   audio device reports all three false no matter what is requested, so the
//   check passed unchanged after the source was flipped to `true`. Asserting it
//   would have been a green light that means nothing. The flag VALUES are
//   covered by src/shared/tab-audio-unprocessed.test.ts; what a real browser
//   adds, and all this file claims, is that Chrome ACCEPTS the object and the
//   names.
//
// WHAT IT HONESTLY DOES NOT PROVE
// -------------------------------
// It does not capture a real tab. Minting a `chrome.tabCapture` streamId needs
// an activeTab grant, which needs a real OS-level invocation of the extension;
// `probe-gesture.mjs` measured that Playwright cannot produce one, and the
// Win32 keychord path (send-shortcut.ps1, used by run-proof.mjs) needs an idle
// foreground desktop and reports "sent-but-not-foreground" in an automated run.
// The end-to-end tab-capture path therefore stays the job of run-proof.mjs on an
// interactive desktop. What this file closes is the question that change
// introduced: does real Chrome accept the new constraint object and honour the
// flag names, or does it reject them.
//
// Usage: imported by run-proof-inpage.mjs, or `node assert-tab-constraints.mjs`.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const srcModule = join(here, "..", "src", "shared", "recording-quality.ts");
const require = createRequire(join(here, "..", "..", "web", "package.json"));

// A rejection with one of these names means Chrome refused the CONSTRAINTS
// themselves — the regression this assertion exists to catch.
const CONSTRAINT_LEVEL_ERRORS = new Set([
	"OverconstrainedError",
	"NotSupportedError",
	"TypeError",
]);

/**
 * Load the REAL exported constraint helpers by compiling the TypeScript module
 * in-process. Re-typing the object here would defeat the point: the assertion
 * must break when `recording-quality.ts` changes, not when a copy drifts.
 */
async function loadRealConstraints() {
	const esbuild = require(join(here, "..", "node_modules", "esbuild"));
	const built = esbuild.buildSync({
		entryPoints: [srcModule],
		bundle: true,
		format: "esm",
		write: false,
		platform: "neutral",
	});
	const code = built.outputFiles[0].text;
	return import(
		`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
	);
}

/**
 * @returns {Promise<{ ok: boolean, claim: string }>} `claim` is a single token
 * safe to splice into the harness verdict line. On success it deliberately does
 * NOT name any error class, so a passing run's output stays free of the words
 * that mean "this broke".
 */
export async function assertTabAudioConstraints({ servePort } = {}) {
	let chromium;
	for (const pkg of ["playwright", "@playwright/test", "playwright-core"]) {
		try {
			({ chromium } = require(pkg));
			break;
		} catch {}
	}
	if (!chromium) return { ok: false, claim: "tabconstraints=BLOCKED(no-playwright)" };

	const { tabAudioConstraints, TAB_AUDIO_CONSTRAINTS } = await loadRealConstraints();

	const args = [
		`--disable-extensions-except=${distDir}`,
		`--load-extension=${distDir}`,
		"--ignore-certificate-errors",
		// Deterministic audio input: the assertion must not depend on this
		// machine owning a microphone. A fake device would poison the 440 Hz
		// tone measurement, which is why this runs in its OWN browser instance
		// and never in the recording one.
		"--use-fake-device-for-media-stream",
		"--use-fake-ui-for-media-stream",
	];
	if (servePort) {
		args.push(`--host-resolver-rules=MAP meet.google.com:443 127.0.0.1:${servePort}`);
	}

	const context = await chromium.launchPersistentContext(
		mkdtempSync(join(tmpdir(), "assert-tabconstraints-")),
		{ headless: false, viewport: { width: 800, height: 600 }, args },
	);
	try {
		let [sw] = context.serviceWorkers();
		if (!sw) {
			sw = await context
				.waitForEvent("serviceworker", { timeout: 15_000 })
				.catch(() => null);
		}
		if (!sw) return { ok: false, claim: "tabconstraints=BLOCKED(no-service-worker)" };
		const extId = new URL(sw.url()).host;

		// Same environment as the recording harness: the fake Meet origin is
		// reachable and its cert is accepted, so this is not measuring some
		// stripped-down browser.
		if (servePort) {
			const meet = await context.newPage();
			await meet
				.goto("https://meet.google.com/abc-defg-hij", { waitUntil: "domcontentloaded" })
				.catch(() => {});
		}

		const page = await context.newPage();
		await page.goto(`chrome-extension://${extId}/options.html`);

		const result = await page.evaluate(
			async ({ tabConstraints, flags, constraintErrors }) => {
				const nameOf = (e) => String(e?.name ?? "UnknownError");
				const out = { arms: [] };

				const record = (id, ok, note) => out.arms.push({ id, ok, note });

				// ── ARM A: the literal legacy `mandatory` dictionary ──────────
				let armA = null;
				try {
					const stream = await navigator.mediaDevices.getUserMedia({
						audio: tabConstraints,
					});
					const live = stream.getAudioTracks().some((t) => t.readyState === "live");
					for (const t of stream.getTracks()) t.stop();
					armA = { rejected: false, live };
				} catch (e) {
					armA = { rejected: true, name: nameOf(e) };
				}
				if (armA.rejected && constraintErrors.includes(armA.name)) {
					record("A", false, `constraint-level-rejection:${armA.name}`);
				} else {
					record("A", true, armA.rejected ? "reached-capture-stage" : "acquired");
				}

				// ARM A control: prove this call site DOES surface a
				// constraint-level rejection when the constraints are impossible.
				let controlA = "none";
				try {
					const s = await navigator.mediaDevices.getUserMedia({
						audio: { sampleRate: { exact: 12345 }, deviceId: { exact: "no-such-device" } },
					});
					for (const t of s.getTracks()) t.stop();
					controlA = "accepted";
				} catch (e) {
					controlA = nameOf(e);
				}
				record(
					"A-control",
					constraintErrors.includes(controlA),
					constraintErrors.includes(controlA) ? "detector-has-teeth" : `blind:${controlA}`,
				);

				// ── ARM B-names: are these real constraint names to this Chrome? ──
				const supported = navigator.mediaDevices.getSupportedConstraints();
				const missing = Object.keys(flags).filter((k) => supported[k] !== true);
				record(
					"B-names",
					missing.length === 0,
					missing.length === 0 ? "all-recognised" : `unrecognised:${missing.join("/")}`,
				);
				// Control: the allowlist must say NO to something, or "yes" is worthless.
				record(
					"B-names-control",
					supported.zzzDefinitelyNotAConstraint !== true,
					supported.zzzDefinitelyNotAConstraint !== true
						? "detector-has-teeth"
						: "blind:allowlist-says-yes-to-anything",
				);

				// ── ARM B: a LIVE track from the three flag names ─────────────
				let track = null;
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...flags } });
					track = stream.getAudioTracks()[0] ?? null;
					if (!track) record("B", false, "no-audio-track");
				} catch (e) {
					record("B", false, `acquire-failed:${nameOf(e)}`);
				}
				if (track) {
					record(
						"B",
						track.readyState === "live",
						track.readyState === "live" ? "live-track" : `track-not-live:${track.readyState}`,
					);

					// applyConstraints — the post-acquisition route.
					try {
						await track.applyConstraints({ ...flags });
						record(
							"B-apply",
							track.readyState === "live",
							track.readyState === "live" ? "applied-track-alive" : "track-died",
						);
					} catch (e) {
						record("B-apply", false, `apply-rejected:${nameOf(e)}`);
					}

					// ARM B control: an impossible constraint on the SAME track must
					// be rejected, or "apply succeeded" means nothing.
					let controlB = "none";
					try {
						await track.applyConstraints({ sampleRate: { exact: 12345 } });
						controlB = "accepted";
					} catch (e) {
						controlB = nameOf(e);
					}
					record(
						"B-control",
						constraintErrors.includes(controlB),
						constraintErrors.includes(controlB) ? "detector-has-teeth" : `blind:${controlB}`,
					);

					track.stop();
				}

				return out;
			},
			{
				tabConstraints: tabAudioConstraints("proof-tab-stream-id"),
				flags: { ...TAB_AUDIO_CONSTRAINTS },
				constraintErrors: [...CONSTRAINT_LEVEL_ERRORS],
			},
		);

		const failed = result.arms.filter((a) => !a.ok);
		if (failed.length === 0) {
			return {
				ok: true,
				claim: `tabconstraints=OK(${result.arms.map((a) => `${a.id}:${a.note}`).join(",")})`,
			};
		}
		return {
			ok: false,
			claim: `tabconstraints=FAILED(${failed.map((a) => `${a.id}:${a.note}`).join(",")})`,
		};
	} catch (e) {
		return { ok: false, claim: `tabconstraints=FAILED(harness:${e?.message ?? e})` };
	} finally {
		await context.close().catch(() => {});
	}
}

// Standalone use, so the assertion can be re-measured on its own. (Compared via
// pathToFileURL: on Windows a hand-built `file://D:/…` never equals Node's
// `file:///D:/…`, which silently turned this whole block into a no-op.)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const r = await assertTabAudioConstraints({});
	console.log(r.claim);
	process.exit(r.ok ? 0 : 1);
}
