// Ground-truth verification: run the PRODUCTION port against real bbzt data and
// compare to the proven-good POC output (fixed-eleven-v2.vtt).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	transferVttTimingWithStats,
	type ScribeWord,
} from "../../lib/vtt-timing-transfer.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));

function firstStarts(vtt: string): number[] {
	const out: number[] = [];
	for (const line of vtt.split(/\r?\n/)) {
		const a = line.indexOf("-->");
		if (a < 0) continue;
		const t = line.slice(0, a).trim().split(":");
		if (t.length !== 3) continue;
		out.push(Number(t[0]) * 3600 + Number(t[1]) * 60 + Number(t[2]));
	}
	return out;
}

const input = await fs.readFile(path.join(dir, "vtt-live.vtt"), "utf8");
const proven = await fs.readFile(path.join(dir, "fixed-eleven-v2.vtt"), "utf8");
const words = JSON.parse(
	await fs.readFile(path.join(dir, "eleven-words.json"), "utf8"),
) as ScribeWord[];

const { vtt: ported, stats } = transferVttTimingWithStats(input, words);

const inS = firstStarts(input);
const portS = firstStarts(ported);
const provenS = firstStarts(proven);

console.log("stats:", JSON.stringify(stats));
console.log(`cues: input=${inS.length} ported=${portS.length} proven=${provenS.length}`);

// How far does the PORT land from the PROVEN output, per cue?
const n = Math.min(portS.length, provenS.length);
let sum = 0;
let max = 0;
const diffs: number[] = [];
for (let i = 0; i < n; i++) {
	const d = Math.abs((portS[i] ?? 0) - (provenS[i] ?? 0));
	diffs.push(d);
	sum += d;
	if (d > max) max = d;
}
diffs.sort((a, b) => a - b);
const median = diffs[Math.floor(diffs.length / 2)] ?? 0;
const p90 = diffs[Math.floor(diffs.length * 0.9)] ?? 0;
console.log(
	`PORT vs PROVEN start-time delta: mean=${(sum / n).toFixed(2)}s median=${median.toFixed(2)}s p90=${p90.toFixed(2)}s max=${max.toFixed(2)}s`,
);

// Sanity: how far was the DRIFTED input from proven (what we are correcting)?
let inSum = 0;
const mIn = Math.min(inS.length, provenS.length);
for (let i = 0; i < mIn; i++) inSum += Math.abs((inS[i] ?? 0) - (provenS[i] ?? 0));
console.log(`DRIFTED input vs proven: mean=${(inSum / mIn).toFixed(2)}s (this is the error we remove)`);

console.log(`first cue: input=${inS[0]?.toFixed(2)} ported=${portS[0]?.toFixed(2)} proven=${provenS[0]?.toFixed(2)}`);
