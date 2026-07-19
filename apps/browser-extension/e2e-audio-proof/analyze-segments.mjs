// Segment-wise tone check: is the Meet tab's audio present THROUGHOUT the
// recording, or only while Chrome was in the foreground?
//
// Answers the owner's real usage question (2026-07-19): he presents slides from
// another desktop app during the call, so Chrome sits backgrounded for minutes.
// Recall.ai documents that tab audio can freeze in exactly that state, so
// "the tone is somewhere in the file" is NOT enough — it must be in every part.
//
// Usage: node analyze-segments.mjs <recording> [segments]
// PASS = every segment's 440Hz band is above the silence threshold.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const file = process.argv[2];
const SEGMENTS = Number(process.argv[3] ?? 4);
if (!file) {
	console.error("usage: node analyze-segments.mjs <recording> [segments]");
	process.exit(2);
}

let ffmpeg = "ffmpeg";
try {
	const require = createRequire(new URL("../../web/package.json", import.meta.url));
	const candidate = require("ffmpeg-static");
	if (candidate && existsSync(candidate)) ffmpeg = candidate;
} catch {}

const run = (args) => {
	const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
	return (r.stderr ?? "") + (r.stdout ?? "");
};

const probe = run(["-hide_banner", "-i", file]);
const dur = probe.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
if (!dur) {
	console.log("VERDICT=FAIL reason=no-duration");
	process.exit(1);
}
const total =
	Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) + Number(`0.${dur[4]}`);
const seg = total / SEGMENTS;
const PASS_MEAN_DB = -50;

let worst = 0;
const rows = [];
for (let i = 0; i < SEGMENTS; i++) {
	const from = (seg * i).toFixed(2);
	const stats = run([
		"-hide_banner", "-ss", from, "-t", seg.toFixed(2), "-i", file,
		"-af", "bandpass=f=440:width_type=h:w=80,volumedetect",
		"-vn", "-f", "null", "-",
	]);
	const m = stats.match(/mean_volume:\s*(-?[\d.]+) dB/);
	const db = m ? Number(m[1]) : -Infinity;
	const ok = db > PASS_MEAN_DB;
	rows.push(`seg${i + 1}(${from}s+${seg.toFixed(1)}s)=${db}dB${ok ? "" : " SILENT"}`);
	if (!ok) worst++;
}

console.log(rows.join("  "));
console.log(
	`VERDICT=${worst === 0 ? "PASS" : "FAIL"} segments=${SEGMENTS} silent=${worst} threshold=${PASS_MEAN_DB} total=${total.toFixed(1)}s`,
);
process.exit(worst === 0 ? 0 : 1);
