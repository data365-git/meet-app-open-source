// Verdict script: does the recorded file contain the 440 Hz tone?
// Usage: node analyze-audio.mjs <recording.(webm|mp4)>
// PASS  = audio stream exists AND band-passed (440 Hz) mean volume > threshold
// FAIL  = no audio stream, or the 440 Hz band is silence.
// Exit code 0/1 — the autoresearch loop keys off this, never off prose.
import { spawnSync } from "node:child_process";

const file = process.argv[2];
if (!file) {
	console.error("usage: node analyze-audio.mjs <recording>");
	process.exit(2);
}

// Resolve the repo's bundled ffmpeg (same binary prod uses via ffmpeg-static);
// locally the postinstall download may have been skipped → fall back to PATH.
let ffmpeg = "ffmpeg";
try {
	const { createRequire } = await import("node:module");
	const { existsSync } = await import("node:fs");
	const require = createRequire(new URL("../../web/package.json", import.meta.url));
	const candidate = require("ffmpeg-static");
	if (candidate && existsSync(candidate)) ffmpeg = candidate;
} catch {}

// ffmpeg writes ALL analysis (volumedetect, stream info) to STDERR, even on
// success — spawnSync captures both regardless of exit code.
const run = (args) => {
	const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
	return (r.stderr ?? "") + (r.stdout ?? "");
};

// 1. Does an audio stream exist at all?
const probe = run(["-hide_banner", "-i", file]);
const probeText = String(probe);
if (!/Stream #\d+:\d+.*Audio:/i.test(probeText)) {
	console.log("VERDICT=FAIL reason=no-audio-stream");
	process.exit(1);
}

// 2. Band-pass around 440 Hz, then measure. A recording that captured the tab's
//    tone shows a strong band; a mic-only/silent recording shows near-silence.
const stats = String(
	run([
		"-hide_banner", "-i", file,
		"-af", "bandpass=f=440:width_type=h:w=80,volumedetect",
		"-vn", "-f", "null", "-",
	]),
);
const mean = stats.match(/mean_volume:\s*(-?[\d.]+) dB/);
const max = stats.match(/max_volume:\s*(-?[\d.]+) dB/);
const meanDb = mean ? Number(mean[1]) : -Infinity;
const maxDb = max ? Number(max[1]) : -Infinity;

// Thresholds: pure silence ≈ -91 dB. A carried 0.5-gain sine lands way above -40.
const PASS_MEAN_DB = -50;
const verdict = meanDb > PASS_MEAN_DB ? "PASS" : "FAIL";
console.log(`VERDICT=${verdict} mean_440band_dB=${meanDb} max_dB=${maxDb} threshold=${PASS_MEAN_DB}`);
process.exit(verdict === "PASS" ? 0 : 1);
