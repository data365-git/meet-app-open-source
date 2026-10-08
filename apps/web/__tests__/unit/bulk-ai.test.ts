/**
 * Bulk AI from selection: the pure planner in lib/bulk-ai.ts (skip rules for
 * both modes incl. the F1 transcriptionStatus-COMPLETE pre-skip, running-job
 * skip, duration-summed estimates with the F4 unknown-duration count, empty
 * selection, the >10 rule), the admin visibility rule, and the sequential
 * start loop (402 budget stop, 403 skip, other-error continue, strict
 * one-at-a-time) with exactly ONE result toast per run (F3).
 */
import { describe, expect, it, vi } from "vitest";

import {
	BULK_AI_MAX_SELECTION,
	buildBulkAiResultToast,
	bulkAiButtonState,
	formatAudioLengthUz,
	planBulkAi,
	runBulkAiStarts,
	SKIP_REASON_FULL_DONE,
	SKIP_REASON_RUNNING,
	SKIP_REASON_TRANSCRIPT_DONE,
	splitSkippedReasons,
} from "@/lib/bulk-ai";
import { isAiJobRunning } from "@/lib/ai-job-status";

const cap = (overrides: Record<string, unknown> = {}) => ({
	id: "v1",
	durationSec: 3600,
	metadata: null,
	...overrides,
});

describe("isAiJobRunning (shared with CapCard)", () => {
	it("PROCESSING and QUEUED mean a job is running", () => {
		expect(isAiJobRunning({ aiGenerationStatus: "PROCESSING" } as never)).toBe(
			true,
		);
		expect(isAiJobRunning({ aiGenerationStatus: "QUEUED" } as never)).toBe(
			true,
		);
	});

	it("COMPLETE / ERROR / absent mean no job is running", () => {
		expect(isAiJobRunning({ aiGenerationStatus: "COMPLETE" } as never)).toBe(
			false,
		);
		expect(isAiJobRunning(null)).toBe(false);
		expect(isAiJobRunning(undefined)).toBe(false);
	});
});

describe("planBulkAi - skip rules, transcript mode", () => {
	// F1: the grid now selects videos.transcriptionStatus, and this rule is the
	// only thing standing between "Faqat transkript" and an unrequested FULL AI
	// run (the generate route's COMPLETE branch ignores startMode).
	it("F1: skips a video whose transcript is COMPLETE (no AI yet) instead of letting it become a full run", () => {
		const plan = planBulkAi(
			[cap({ id: "done", transcriptionStatus: "COMPLETE" })],
			"transcript",
		);
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped).toEqual([
			{ id: "done", reason: SKIP_REASON_TRANSCRIPT_DONE },
		]);
	});

	it("full mode: a COMPLETE transcript with NO AI content still RUNS (only the AI part is missing)", () => {
		const plan = planBulkAi(
			[cap({ id: "transcribed", transcriptionStatus: "COMPLETE" })],
			"full",
		);
		expect(plan.toRun).toEqual(["transcribed"]);
		expect(plan.skipped).toEqual([]);
	});

	it("skips a video whose FULL analysis is done (the transcript exists too)", () => {
		const plan = planBulkAi(
			[
				cap({
					id: "fulldone",
					metadata: { aiGenerationStatus: "COMPLETE", summary: "tayyor" },
				}),
			],
			"transcript",
		);
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped).toEqual([
			{ id: "fulldone", reason: SKIP_REASON_TRANSCRIPT_DONE },
		]);
	});

	it("runs a fresh video with no AI state at all", () => {
		const plan = planBulkAi([cap()], "transcript");
		expect(plan.toRun).toEqual(["v1"]);
		expect(plan.skipped).toEqual([]);
	});
});

describe("planBulkAi - skip rules, full mode", () => {
	it("skips a video whose AI summary already exists (no re-run)", () => {
		const plan = planBulkAi(
			[
				cap({
					id: "fulldone",
					metadata: {
						aiGenerationStatus: "COMPLETE",
						aiSummary: { overview: "xulosa" } as never,
					},
				}),
			],
			"full",
		);
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped).toEqual([
			{ id: "fulldone", reason: SKIP_REASON_FULL_DONE },
		]);
	});

	it("does NOT skip COMPLETE-but-empty content (the generate route retries those)", () => {
		const plan = planBulkAi(
			[cap({ metadata: { aiGenerationStatus: "COMPLETE" } })],
			"full",
		);
		expect(plan.toRun).toEqual(["v1"]);
		expect(plan.skipped).toEqual([]);
	});
});

describe("planBulkAi - running job is skipped in BOTH modes", () => {
	for (const mode of ["transcript", "full"] as const) {
		it(`${mode}: aiGenerationStatus PROCESSING is skipped`, () => {
			const plan = planBulkAi(
				[cap({ metadata: { aiGenerationStatus: "PROCESSING" } })],
				mode,
			);
			expect(plan.toRun).toEqual([]);
			expect(plan.skipped).toEqual([{ id: "v1", reason: SKIP_REASON_RUNNING }]);
		});

		it(`${mode}: aiGenerationStatus QUEUED is skipped`, () => {
			const plan = planBulkAi(
				[cap({ metadata: { aiGenerationStatus: "QUEUED" } })],
				mode,
			);
			expect(plan.skipped[0]?.reason).toBe(SKIP_REASON_RUNNING);
		});

		it(`${mode}: transcriptionStatus PROCESSING is skipped`, () => {
			const plan = planBulkAi(
				[cap({ transcriptionStatus: "PROCESSING" })],
				mode,
			);
			expect(plan.skipped[0]?.reason).toBe(SKIP_REASON_RUNNING);
		});
	}
});

describe("planBulkAi - estimate", () => {
	it("sums durations and prices ONLY the videos that will run", () => {
		const plan = planBulkAi(
			[
				cap({ id: "a", durationSec: 1800 }),
				cap({ id: "b", durationSec: 3600 }),
				cap({
					id: "c",
					durationSec: 7200,
					metadata: { aiGenerationStatus: "COMPLETE", summary: "bor" },
				}),
			],
			"transcript",
		);
		expect(plan.toRun).toEqual(["a", "b"]);
		expect(plan.skipped.map((s) => s.id)).toEqual(["c"]);
		expect(plan.totalAudioSec).toBe(5400);
		// 5400s * 32 audio tokens/s * $1.00/M = $0.1728 -> $0.17 rounded for
		// display (gemini-2.5-flash audio-in rate, packages/utils ai-pricing).
		expect(plan.estimatedUsd).toBe(0.17);
	});

	it("full mode uses the whole-pipeline estimate (~$0.45/hour anchor)", () => {
		const plan = planBulkAi([cap({ durationSec: 3600 })], "full");
		expect(plan.totalAudioSec).toBe(3600);
		expect(plan.estimatedUsd).toBeCloseTo(0.45, 2);
	});

	it("unknown duration contributes nothing instead of guessing", () => {
		const plan = planBulkAi(
			[
				cap({ id: "a", durationSec: null }),
				cap({ id: "b", durationSec: undefined }),
			],
			"transcript",
		);
		expect(plan.totalAudioSec).toBe(0);
		expect(plan.estimatedUsd).toBe(0);
		// F4: both unknown -> the dialog shows "narxi noma'lum", not a $0 lie.
		expect(plan.unknownDurationCount).toBe(2);
	});

	it("F4: counts the SOME-unknown case so the dialog can say the price is partial", () => {
		const plan = planBulkAi(
			[
				cap({ id: "a", durationSec: 1800 }),
				cap({ id: "b", durationSec: null }),
			],
			"transcript",
		);
		expect(plan.toRun).toEqual(["a", "b"]);
		expect(plan.totalAudioSec).toBe(1800);
		expect(plan.unknownDurationCount).toBe(1);
		// Skipped videos' durations never enter the unknown count.
		const plan2 = planBulkAi(
			[cap({ id: "skip", durationSec: null, transcriptionStatus: "COMPLETE" })],
			"transcript",
		);
		expect(plan2.unknownDurationCount).toBe(0);
	});
});

describe("planBulkAi - empty selection", () => {
	it("returns an empty plan", () => {
		const plan = planBulkAi([], "transcript");
		expect(plan.toRun).toEqual([]);
		expect(plan.skipped).toEqual([]);
		expect(plan.totalAudioSec).toBe(0);
		expect(plan.estimatedUsd).toBe(0);
	});
});

describe("bulkAiButtonState - visibility and the >10 rule", () => {
	it("admin with cap data sees the buttons", () => {
		expect(
			bulkAiButtonState({ isAdmin: true, selectedCount: 3, hasCapData: true }),
		).toEqual({ visible: true, disabled: false, hint: null });
	});

	it("a member NEVER sees the buttons", () => {
		expect(
			bulkAiButtonState({ isAdmin: false, selectedCount: 3, hasCapData: true }),
		).toEqual({ visible: false, disabled: false, hint: null });
		expect(
			bulkAiButtonState({
				isAdmin: undefined,
				selectedCount: 3,
				hasCapData: true,
			}).visible,
		).toBe(false);
	});

	it("hidden when the caller has no AI data for the selection", () => {
		expect(
			bulkAiButtonState({ isAdmin: true, selectedCount: 3, hasCapData: false })
				.visible,
		).toBe(false);
	});

	it("exactly 10 is allowed, 11 is disabled with the Uzbek hint", () => {
		expect(
			bulkAiButtonState({
				isAdmin: true,
				selectedCount: BULK_AI_MAX_SELECTION,
				hasCapData: true,
			}).disabled,
		).toBe(false);
		const over = bulkAiButtonState({
			isAdmin: true,
			selectedCount: BULK_AI_MAX_SELECTION + 1,
			hasCapData: true,
		});
		expect(over.disabled).toBe(true);
		expect(BULK_AI_MAX_SELECTION).toBe(10);
		expect(over.hint).toBe("Bir martada 10 tagacha");
	});
});

describe("formatAudioLengthUz", () => {
	it("minutes under an hour, ~hours above it", () => {
		expect(formatAudioLengthUz(40 * 60)).toBe("40 daqiqa");
		expect(formatAudioLengthUz(90 * 60)).toBe("~1.5 soat");
		expect(formatAudioLengthUz(0)).toBe("0 daqiqa");
	});
});

const jsonResponse = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

describe("runBulkAiStarts - the sequential start loop", () => {
	it("starts one at a time: call 2 fires only after call 1 resolves", async () => {
		const urls: string[] = [];
		let releaseFirst!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const fetchMock = vi.fn(async (url: string) => {
			urls.push(url);
			if (urls.length === 1) await gate;
			return jsonResponse(200, { started: true });
		});

		const running = runBulkAiStarts(
			["a", "b"],
			"transcript",
			fetchMock as unknown as typeof fetch,
		);
		// Let the loop enter call 1, then prove call 2 has NOT fired yet.
		await vi.waitFor(() => expect(urls.length).toBe(1));
		expect(urls).toEqual(["/api/videos/a/generate"]);
		releaseFirst();
		const outcome = await running;
		expect(urls).toEqual(["/api/videos/a/generate", "/api/videos/b/generate"]);
		expect(outcome.started).toBe(2);
	});

	it("402 AI_BUDGET_EXCEEDED on item 2 of 4 STOPS the loop (3-4 never fetched)", async () => {
		const fetchMock = vi.fn(async () => {
			const n = fetchMock.mock.calls.length;
			if (n === 1) return jsonResponse(200, { started: true });
			return jsonResponse(402, {
				error: "AI budget exceeded",
				code: "AI_BUDGET_EXCEEDED",
			});
		});

		const outcome = await runBulkAiStarts(
			["a", "b", "c", "d"],
			"full",
			fetchMock as unknown as typeof fetch,
		);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(outcome).toEqual({
			started: 1,
			startedIds: ["a"],
			skipped: 0,
			failed: 0,
			budgetStopped: true,
			notStartedCount: 3,
			total: 4,
		});
	});

	it("startedIds carries EXACTLY the accepted ids (200 incl. alreadyRunning), never 403/500", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(200, { started: true }))
			.mockResolvedValueOnce(jsonResponse(403, { error: "Forbidden" }))
			.mockResolvedValueOnce(jsonResponse(200, { alreadyRunning: true }))
			.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }));

		const outcome = await runBulkAiStarts(
			["a", "b", "c", "d"],
			"transcript",
			fetchMock as unknown as typeof fetch,
		);

		expect(outcome.started).toBe(2);
		expect(outcome.startedIds).toEqual(["a", "c"]);
	});

	it("403 counts as skipped and the loop CONTINUES", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse(403, { error: "Forbidden" }))
			.mockResolvedValueOnce(jsonResponse(200, { started: true }));

		const outcome = await runBulkAiStarts(
			["a", "b"],
			"transcript",
			fetchMock as unknown as typeof fetch,
		);

		expect(outcome.skipped).toBe(1);
		expect(outcome.started).toBe(1);
	});

	it("a 500 / a network failure counts as failed and the loop CONTINUES", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("network down"))
			.mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
			.mockResolvedValueOnce(jsonResponse(200, { alreadyRunning: true }));

		const outcome = await runBulkAiStarts(
			["a", "b", "c"],
			"transcript",
			fetchMock as unknown as typeof fetch,
		);

		expect(outcome.failed).toBe(2);
		expect(outcome.started).toBe(1); // alreadyRunning counts as started
		expect(outcome.total).toBe(3);
	});

	it("NEVER sends reprocess:true and posts the chosen mode", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse(200, { started: true }));

		await runBulkAiStarts(["a"], "full", fetchMock as unknown as typeof fetch);

		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({ mode: "full" });
	});
});

describe("buildBulkAiResultToast - exactly ONE toast per run (F3)", () => {
	it("all started -> a SUCCESS toast", () => {
		expect(
			buildBulkAiResultToast({
				started: 2,
				startedIds: ["a", "b"],
				skipped: 0,
				failed: 0,
				budgetStopped: false,
				notStartedCount: 0,
				total: 2,
			}),
		).toEqual({ kind: "success", text: "2 tadan 2 tasi boshlandi" });
	});

	it("started + skipped (no failures) is still a SUCCESS toast", () => {
		expect(
			buildBulkAiResultToast({
				started: 3,
				startedIds: ["a", "b", "c"],
				skipped: 1,
				failed: 0,
				budgetStopped: false,
				notStartedCount: 0,
				total: 4,
			}),
		).toEqual({
			kind: "success",
			text: "4 tadan 3 tasi boshlandi · 1 tasi o'tkazib yuborildi (ruxsat yo'q yoki ishlanmoqda)",
		});
	});

	it("ALL FAILED -> NOT a success toast (error with the counts)", () => {
		expect(
			buildBulkAiResultToast({
				started: 0,
				startedIds: [],
				skipped: 0,
				failed: 2,
				budgetStopped: false,
				notStartedCount: 0,
				total: 2,
			}),
		).toEqual({
			kind: "error",
			text: "2 tadan 0 tasi boshlandi · 2 tasi xatolik bilan to'xtadi",
		});
	});

	it("budget stop: the limit line is MERGED into the SAME single toast (error)", () => {
		expect(
			buildBulkAiResultToast({
				started: 1,
				startedIds: ["a"],
				skipped: 0,
				failed: 0,
				budgetStopped: true,
				notStartedCount: 3,
				total: 4,
			}),
		).toEqual({
			kind: "error",
			text: "4 tadan 1 tasi boshlandi · Oylik AI limiti tugadi - 3 ta video boshlanmadi",
		});
	});

	it("some failed (some started) -> error toast carrying every count", () => {
		expect(
			buildBulkAiResultToast({
				started: 3,
				startedIds: ["a", "b", "c"],
				skipped: 1,
				failed: 1,
				budgetStopped: false,
				notStartedCount: 0,
				total: 5,
			}).kind,
		).toBe("error");
	});
});

describe("splitSkippedReasons (F4 dialog split)", () => {
	it("done vs. running are counted separately", () => {
		const { doneCount, runningCount } = splitSkippedReasons([
			{ id: "a", reason: SKIP_REASON_TRANSCRIPT_DONE },
			{ id: "b", reason: SKIP_REASON_FULL_DONE },
			{ id: "c", reason: SKIP_REASON_RUNNING },
		]);
		expect(doneCount).toBe(2);
		expect(runningCount).toBe(1);
	});

	it("empty skipped list -> both zero", () => {
		expect(splitSkippedReasons([])).toEqual({ doneCount: 0, runningCount: 0 });
	});
});
