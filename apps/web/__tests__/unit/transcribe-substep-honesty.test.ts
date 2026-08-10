/**
 * 2026-08-10 review finding #4: the "extract_audio" live-progress marker was
 * cleared only by savePartialTranscription / saveTranscription — but the
 * single-chunk transcription path never fires the progress callbacks, so a
 * short recording showed "Extracting audio from the video…" for the ENTIRE
 * Gemini call, and markError/markNoAudio left the marker set on terminal
 * states. A progress line that lies is worse than none (hard constraint of
 * the original brief), so this pins WHERE the marker may live: it is set at
 * the start of extractAudio and MUST be cleared by extractAudio itself on
 * every successful return path, by validateVideo for a fresh attempt, and by
 * the terminal markError/markNoAudio writers.
 *
 * Source-shape test (same technique as transcribe-no-autoscribe.test.ts):
 * RED against the pre-fix workflow, where extractAudio only SET the marker.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
	fileURLToPath(new URL("../../workflows/transcribe.ts", import.meta.url)),
	"utf8",
);

/** Body of a top-level (exported or not) async function, sliced up to the
 * next top-level function/export at column 0. */
function bodyOf(name: string): string {
	const exported = SRC.indexOf(`export async function ${name}(`);
	const plain = SRC.indexOf(`\nasync function ${name}(`);
	const start = exported !== -1 ? exported : plain;
	expect(start, `${name} not found in transcribe.ts`).toBeGreaterThan(-1);
	const next = SRC.slice(start + 1).search(/\n(?:export |async function |function )/);
	return next === -1 ? SRC.slice(start) : SRC.slice(start, start + 1 + next);
}

const SET_MARKER = /aiProcessingSubStep:\s*"extract_audio"/;
// Non-global for toMatch (a /g regex is stateful across .test calls);
// global variant only for counting occurrences.
const CLEAR_MARKER = /aiProcessingSubStep:\s*undefined/;
const CLEAR_MARKER_ALL = /aiProcessingSubStep:\s*undefined/g;

describe("extract_audio marker honesty — the live line must never lie", () => {
	it("extractAudio sets the marker and clears it on BOTH successful return paths (incl. single-chunk)", () => {
		const body = bodyOf("extractAudio");
		expect(body).toMatch(SET_MARKER);
		const clears = body.match(CLEAR_MARKER_ALL) ?? [];
		// One clear per successful return path: chunked and single-chunk. The
		// single-chunk path is the one that never reaches the progress
		// callbacks, so a clear anywhere else does not save it.
		expect(clears.length).toBeGreaterThanOrEqual(2);
	});

	it("extractAudio seeds the real chunk counters when it clears the marker (line hands over to honest 0/N data)", () => {
		const body = bodyOf("extractAudio");
		expect(body).toMatch(/transcriptionChunksTotal:\s*(chunks\.length|1)/);
	});

	it("a fresh attempt (validateVideo) does not inherit a dead run's marker", () => {
		// validateVideo writes via server-side JSON_REMOVE/JSON_SET (round-3
		// finding #4), so the clear is the JSON_REMOVE path, not a JS undefined.
		expect(bodyOf("validateVideo")).toMatch(/'\$\.aiProcessingSubStep'/);
	});

	it("validateVideo merges server-side — no spread of step-start metadata into the claim write (round-3 #4)", () => {
		const body = bodyOf("validateVideo");
		// A spread of the metadata read at workflow start reverts whatever a
		// concurrent run wrote in between — losing an aiBatchJobs handle means
		// a PAID Batch that is never collected and never cancelled.
		expect(body).toMatch(/JSON_SET\(/);
		expect(body).toMatch(/JSON_REMOVE\(/);
		expect(body).not.toMatch(/\.\.\.metadata/);
	});

	it("the workflow stamps the progress heartbeat where progress really happens", () => {
		// Claim (validateVideo), extraction done (extractAudio), every completed
		// chunk (savePartialTranscription) — the recovery cron judges staleness
		// by time since this stamp.
		expect(bodyOf("validateVideo")).toMatch(/'\$\.aiProgressAt'/);
		expect(bodyOf("extractAudio")).toMatch(/aiProgressAt:/);
		expect(bodyOf("savePartialTranscription")).toMatch(/aiProgressAt:/);
	});

	it("extraction ITSELF heartbeats: at start (covers the no-chunk-boundary branches) and inside the per-chunk loop (round-4 #4)", () => {
		// A recording whose download+transcode+upload exceeds the stale
		// threshold showed no life for the whole extraction, so the cron killed
		// and duplicated a healthy job. Four stamps: step start, per-chunk loop,
		// and the two end-of-branch counter writes.
		const body = bodyOf("extractAudio");
		const stamps = body.match(/aiProgressAt:/g) ?? [];
		expect(stamps.length).toBeGreaterThanOrEqual(4);
		// The per-chunk loop specifically must contain one — the natural
		// progress boundary for long extractions.
		const loop = body.slice(
			body.indexOf("for (const [index, chunk]"),
			body.indexOf("return { chunks, totalDurationSec }"),
		);
		expect(loop).toMatch(/aiProgressAt:/);
	});

	it("a SUCCESSFUL transcription refunds the free auto-recover budget (round-4 #5)", () => {
		// autoRecoverAttempts' only writer is the recovery cron; without this
		// reset a video that once used its retries starts every later cheap job
		// at attempts=2 and goes straight to the paid flip with zero free
		// re-kicks.
		expect(bodyOf("saveTranscription")).toMatch(
			/delete md\.autoRecoverAttempts/,
		);
	});

	it("terminal states (markError, markNoAudio) drop the marker", () => {
		expect(bodyOf("markError")).toMatch(CLEAR_MARKER);
		expect(bodyOf("markNoAudio")).toMatch(CLEAR_MARKER);
	});

	it("nothing outside extractAudio ever SETS the marker (no invented claims)", () => {
		const allSets = SRC.match(/aiProcessingSubStep:\s*"extract_audio"/g) ?? [];
		const inExtract =
			bodyOf("extractAudio").match(/aiProcessingSubStep:\s*"extract_audio"/g) ??
			[];
		expect(allSets.length).toBe(inExtract.length);
	});
});
