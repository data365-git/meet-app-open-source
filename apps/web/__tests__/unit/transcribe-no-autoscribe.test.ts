import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Product decision (owner + Codex 2026-07-15): ordinary transcription uses
// Gemini text AND Gemini timing only — it must never call the PAID ElevenLabs
// Scribe. Scribe runs ONLY from the explicit, owner-triggered
// refineVideoTimestampsWorkflow(). This test fails if anyone re-introduces an
// automatic Scribe call into the normal pipeline (which would silently spend
// money on every transcription).
const SRC = readFileSync(
	fileURLToPath(new URL("../../workflows/transcribe.ts", import.meta.url)),
	"utf8",
);

function bodyOf(name: string): string {
	const start = SRC.indexOf(`export async function ${name}`);
	expect(start, `${name} not found in transcribe.ts`).toBeGreaterThan(-1);
	// Slice up to the next top-level `export` (column 0) = the function's body.
	const next = SRC.indexOf("\nexport ", start + 1);
	return SRC.slice(start, next === -1 ? undefined : next);
}

describe("transcribe product decision — no auto-Scribe", () => {
	it("transcribeVideoWorkflow never invokes ElevenLabs Scribe", () => {
		const body = bodyOf("transcribeVideoWorkflow");
		expect(body).not.toMatch(/fetchScribeWordTimes|applyScribeTimingTransfer/);
	});

	it("Scribe is bridged in only from refineVideoTimestampsWorkflow", () => {
		const refine = bodyOf("refineVideoTimestampsWorkflow");
		expect(refine).toMatch(/applyScribeTimingTransfer/);
	});
});
