import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Owner-reported 2026-08-10: press "AI tahlil", reload the page, and the
// progress panel is gone — leaving no way to tell a running job from a
// cancelled one.
//
// The invariant that fixes it is an ORDERING one: `transcribeVideo` must write
// `transcriptionStatus = "PROCESSING"` to the row BEFORE it launches the
// workflow. The workflow's own PROCESSING write happens after it has fetched
// the video, the owner and the org settings; a reload inside that window reads
// NULL and the panel correctly renders "not started".
//
// This is asserted against the SOURCE rather than through a behaviour harness
// on purpose, and the choice is a narrow one: the thing being guaranteed is the
// ORDER OF TWO STATEMENTS inside one function, and `lib/transcribe.ts` pulls in
// storage, the budget guard and the workflow module, so a behaviour test would
// need a dozen mocks to observe a fact that is plainly visible here. Same shape
// as `transcribe-no-autoscribe.test.ts`, which this repo already relies on for
// an invariant of exactly this kind.
const SRC = readFileSync(
	fileURLToPath(new URL("../../lib/transcribe.ts", import.meta.url)),
	"utf8",
);

function bodyOf(name: string): string {
	const start = SRC.indexOf(`export async function ${name}`);
	expect(start, `${name} not found in lib/transcribe.ts`).toBeGreaterThan(-1);
	const next = SRC.indexOf("\nexport ", start + 1);
	return SRC.slice(start, next === -1 ? undefined : next);
}

describe("transcribeVideo claims the job before launching the workflow", () => {
	const body = bodyOf("transcribeVideo");

	it("writes transcriptionStatus PROCESSING in this function", () => {
		expect(body).toMatch(/transcriptionStatus:\s*"PROCESSING"/);
	});

	it("writes it BEFORE the workflow is launched, not after", () => {
		const claim = body.search(/transcriptionStatus:\s*"PROCESSING"/);
		const launch = body.indexOf("after(runTranscribe)");

		expect(claim, "PROCESSING claim not found").toBeGreaterThan(-1);
		expect(launch, "workflow launch not found").toBeGreaterThan(-1);
		// A claim written after the launch would leave the same blind window the
		// owner hit — the row says nothing while the job is already running.
		expect(claim).toBeLessThan(launch);
	});

	it("records processingStartedAt with the claim, so a stuck job is detectable", () => {
		// The recovery cron finds stale PROCESSING rows by age; without a start
		// timestamp a job that dies before the workflow writes anything would sit
		// as PROCESSING forever, which is the failure mode this fix must not swap
		// the old one for.
		expect(body).toMatch(/processingStartedAt/);
	});

	it("merges metadata server-side instead of writing back the row it read", () => {
		// The row is read at the top of the function; the claim happens after an
		// owner lookup, a decrypt, an upload check and the budget guard. Spreading
		// that stale object would revert whatever a concurrent writer (retry-ai,
		// the batch-poll cron) set in between. Found by a blind review, 2026-08-10.
		const claim = body.slice(body.search(/transcriptionStatus:\s*"PROCESSING"/));
		expect(claim).toMatch(/JSON_SET\(/);
	});

	it("claims NO aiMode — the speed-mode split is deleted, one stale threshold serves every row", () => {
		const claim = body.slice(body.search(/transcriptionStatus:\s*"PROCESSING"/));
		expect(claim).not.toMatch(/\$\.aiMode/);
	});

	it("still clears the claim if the workflow could not be started", () => {
		// The catch below resets the row, so a failure to launch does not leave a
		// recording stuck showing progress that will never happen.
		expect(body).toMatch(/transcriptionStatus:\s*null/);
	});
});
