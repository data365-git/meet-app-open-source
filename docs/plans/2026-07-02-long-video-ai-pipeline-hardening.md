# Long-Video AI Pipeline Hardening — Implementation Plan

> **For agentic workers:** Use the `executing-plans` skill to implement this plan task-by-task (or dispatch a fresh subagent per task, reviewing between tasks). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the "dropped section" defect class on long (2-3h) videos, apply the Russian-script guard to every AI output surface with an expanded dictionary, and make the transcription pipeline identify real speaker names (fallback "Spiker 1/2") consistently across chunks.

**Architecture:** Three independent hardening layers on the existing Gemini pipeline: (1) a **merge-level gap-fill pass** — after all chunks merge, measure every hole >120s in the FINAL VTT, re-transcribe just those spans in ≤5-min slices (small audio = reliable), and record any hole that survives in metadata instead of silently shipping it; plus a one-retry on per-chunk summary JSON parses so a 15-min slice never silently vanishes from the summary. (2) A **deep script-guard** (`restoreRussianScriptDeep`) applied to the summary/refined/translation outputs (today only the transcript VTT is guarded) with a ~90-word dictionary expansion. (3) **Speaker naming**: the transcription prompt actively hunts for real names, falls back to "Spiker N", and a roster harvested from chunk 0 is carried into later chunks for cross-chunk consistency. The share-page UI already renders `<v Name>` labels fully (avatars, grouping) — zero UI work.

**Tech Stack:** Next.js monorepo (`apps/web`), TypeScript, Gemini 2.5 Flash (REST), ffmpeg (`ffmpeg-static`), R2 object storage (bucket API), Vitest, "workflow" durable-step library (`"use workflow"` / `"use step"` directives).

## Global Constraints

- Repo: `D:\vibecoding\ustoz-github`. App code lives in `apps/web`. Work on branch `qa-fixes`.
- **`git push` = Railway auto-deploy.** Commit locally per task; push ONLY once at the very end (Task 10), after gates pass and after confirming no transcription/AI job is currently running on the live site (a deploy restart kills in-flight jobs).
- Gate before push: ROOT `pnpm tsc -b` exits 0 AND `pnpm --filter @cap/web run test` passes. Known pre-existing flake: `developer-credits-checkout` (timeout; passes in isolation) — not caused by this work.
- Windows shell: Node may not be on PATH — run `$env:Path="C:\Program Files\nodejs;"+$env:Path` first (PowerShell).
- Never save a file with a UTF-8 BOM (previous incidents). Check changed files if unsure.
- A test MUST fail when the feature is broken. Never weaken assertions to go green.
- UI copy is Uzbek; code, comments, commits are English. Do not touch unrelated code.
- All prompts sent to Gemini are English (existing convention). Do not reformat/reindent template-literal prompt strings — literal whitespace becomes prompt text.
- `"use step"` functions are durable workflow steps: their arguments must stay JSON-serializable. Orchestration helpers called from the workflow body (like `transcribeAudioChunks`) are plain async functions that may call step functions.
- Live app: https://capweb-production-dd85.up.railway.app · admin `admin@ustoz.uz` / `<redacted — rotated 2026-07-14>` · DB via `railway variables --json` → `DATABASE_URL` (public proxy `thomas.proxy.rlwy.net:26774`).

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/web/workflows/transcribe.ts` | Add `findVttGaps`, `fillTranscriptGaps`, `extractGapSpanAudio` step; wire gap-fill into workflow; roster-carry restructure of `transcribeAudioChunks`; `saveTranscription` records remaining gaps; thread `knownSpeakers` |
| `apps/web/lib/audio-extract.ts` | Add `extractAudioSpanFromUrl` (ffmpeg `-ss`/`-t` span extraction) |
| `apps/web/lib/gemini-transcribe.ts` | `buildTranscriptionPrompt(opts)` speaker rules + roster block; `transcribeWithGemini` accepts `knownSpeakers`; add `extractSpeakerLabels` |
| `apps/web/lib/restore-russian-script.ts` | Dictionary expansion (~90 entries); add `restoreRussianScriptDeep` |
| `apps/web/workflows/generate-ai.ts` | `callAiJsonWithRetry` helper (per-chunk + final synthesis one-retry); apply `restoreRussianScriptDeep` to the final `AiResult` |
| `apps/web/lib/translate-ai.ts` | Apply script guard to translated summary + translated VTT cues |
| `packages/database/types/metadata.ts` | Add `transcriptionGaps` field |
| `apps/web/__tests__/unit/transcribe-gap-fill.test.ts` | NEW — `findVttGaps` + `fillTranscriptGaps` tests |
| `apps/web/__tests__/unit/restore-russian-script.test.ts` | Extend — new words, Uzbek loanwords untouched, deep guard |
| `apps/web/__tests__/unit/speaker-labels.test.ts` | NEW — `extractSpeakerLabels` + prompt roster tests |
| `apps/web/__tests__/unit/generate-ai-json-retry.test.ts` | NEW — retry helper contract test |

---

### Task 1: `findVttGaps` — measure every hole in a merged VTT

The existing `webVttLargestGapSec` (per-chunk, `apps/web/workflows/transcribe.ts:563`) returns only the single largest leading/internal gap and ignores trailing silence. Merge-level gap-fill needs ALL holes with their positions, including the trailing hole (a 2h video whose cues stop at 1:40 is a real defect at video level).

**Files:**
- Modify: `apps/web/workflows/transcribe.ts` (add below `webVttLargestGapSec`, ~line 591)
- Test: `apps/web/__tests__/unit/transcribe-gap-fill.test.ts` (create)

**Interfaces:**
- Produces: `export interface VttGap { startSec: number; endSec: number }` and `export function findVttGaps(vtt: string, totalDurationSec: number | null, minGapSec?: number): VttGap[]` — consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/__tests__/unit/transcribe-gap-fill.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { findVttGaps } from "../../workflows/transcribe";

function vtt(cues: Array<[number, number, string]>): string {
	const ts = (s: number) => {
		const h = String(Math.floor(s / 3600)).padStart(2, "0");
		const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
		const sec = String(Math.floor(s % 60)).padStart(2, "0");
		return `${h}:${m}:${sec}.000`;
	};
	let out = "WEBVTT\n\n";
	cues.forEach(([start, end, text], i) => {
		out += `${i + 1}\n${ts(start)} --> ${ts(end)}\n${text}\n\n`;
	});
	return out;
}

describe("findVttGaps", () => {
	it("returns no gaps for a well-covered transcript", () => {
		const v = vtt([[0, 50, "a"], [60, 110, "b"], [170, 220, "c"], [280, 300, "d"]]);
		expect(findVttGaps(v, 310)).toEqual([]);
	});

	it("detects a leading gap (the 'first 14 minutes missing' bug)", () => {
		const v = vtt([[854, 860, "late"], [900, 910, "more"]]);
		const gaps = findVttGaps(v, 950);
		expect(gaps).toEqual([{ startSec: 0, endSec: 854 }]);
	});

	it("detects an internal gap between cue starts", () => {
		const v = vtt([[0, 10, "a"], [30, 40, "b"], [900, 910, "c"]]);
		expect(findVttGaps(v, 950)).toEqual([{ startSec: 30, endSec: 900 }]);
	});

	it("detects a trailing gap when duration is known", () => {
		const v = vtt([[0, 10, "a"], [60, 70, "b"]]);
		expect(findVttGaps(v, 900)).toEqual([{ startSec: 60, endSec: 900 }]);
	});

	it("ignores the trailing hole when duration is unknown", () => {
		const v = vtt([[0, 10, "a"], [60, 70, "b"]]);
		expect(findVttGaps(v, null)).toEqual([]);
	});

	it("treats an empty VTT as one whole-duration gap", () => {
		expect(findVttGaps("WEBVTT\n\n", 600)).toEqual([{ startSec: 0, endSec: 600 }]);
	});

	it("returns multiple gaps in order", () => {
		const v = vtt([[400, 410, "a"], [420, 430, "b"], [1000, 1010, "c"]]);
		expect(findVttGaps(v, 1600)).toEqual([
			{ startSec: 0, endSec: 400 },
			{ startSec: 420, endSec: 1000 },
			{ startSec: 1000, endSec: 1600 },
		]);
	});

	it("respects a custom minGapSec", () => {
		const v = vtt([[0, 5, "a"], [100, 105, "b"]]);
		expect(findVttGaps(v, 110, 200)).toEqual([]);
		expect(findVttGaps(v, 110, 60)).toEqual([{ startSec: 0, endSec: 100 }]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-gap-fill.test.ts`
Expected: FAIL — `findVttGaps` is not exported.

- [ ] **Step 3: Implement `findVttGaps`**

In `apps/web/workflows/transcribe.ts`, directly after `webVttLargestGapSec` (after its closing brace, ~line 591), add:

```ts
export interface VttGap {
	startSec: number;
	endSec: number;
}

/**
 * All holes bigger than minGapSec in a MERGED (absolute-timestamped) VTT:
 * leading (0 → first cue start), internal (between consecutive cue starts),
 * and — unlike the per-chunk metric — TRAILING (last cue start → total
 * duration) when the real duration is known. This is the merge-level "did the
 * final transcript actually cover the whole video" measure that per-chunk
 * checks can never provide (a wholly-failed chunk merges in as silence).
 */
export function findVttGaps(
	vtt: string,
	totalDurationSec: number | null,
	minGapSec: number = MAX_CHUNK_GAP_SEC,
): VttGap[] {
	const starts: number[] = [];
	for (const line of vtt.split(/\r?\n/)) {
		const arrow = line.indexOf("-->");
		if (arrow === -1) continue;
		const m = line
			.slice(0, arrow)
			.match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
		if (!m) continue;
		starts.push(
			(m[1] ? Number(m[1]) : 0) * 3600 +
				Number(m[2]) * 60 +
				Number(m[3]) +
				Number(m[4]) / 1000,
		);
	}
	starts.sort((a, b) => a - b);

	const gaps: VttGap[] = [];
	if (starts.length === 0) {
		if (totalDurationSec != null && totalDurationSec > minGapSec) {
			gaps.push({ startSec: 0, endSec: totalDurationSec });
		}
		return gaps;
	}
	const first = starts[0] ?? 0;
	if (first > minGapSec) gaps.push({ startSec: 0, endSec: first });
	for (let i = 1; i < starts.length; i++) {
		const prev = starts[i - 1] ?? 0;
		const cur = starts[i] ?? 0;
		if (cur - prev > minGapSec) gaps.push({ startSec: prev, endSec: cur });
	}
	const last = starts[starts.length - 1] ?? 0;
	if (totalDurationSec != null && totalDurationSec - last > minGapSec) {
		gaps.push({ startSec: last, endSec: totalDurationSec });
	}
	return gaps;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-gap-fill.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/workflows/transcribe.ts apps/web/__tests__/unit/transcribe-gap-fill.test.ts
git commit -m "feat: findVttGaps measures every hole in a merged transcript"
```

---

### Task 2: `extractAudioSpanFromUrl` — ffmpeg span extraction

**Files:**
- Modify: `apps/web/lib/audio-extract.ts` (add after `extractAudioChunksFromUrl`, ~line 225)

**Interfaces:**
- Consumes: existing `getFfmpegPath()`, `AudioExtractionResult`, `DEFAULT_AUDIO_BITRATE` in the same file.
- Produces: `export function extractAudioSpanFromUrl(videoUrl: string, startSec: number, durationSec: number): Promise<AudioExtractionResult>` — consumed by Task 3.

No unit test (spawns real ffmpeg against a URL; same untested pattern as the sibling extractors). It is exercised by the live verification in Task 10.

- [ ] **Step 1: Implement**

In `apps/web/lib/audio-extract.ts`, after `extractAudioChunksFromUrl` (~line 225), add:

```ts
/**
 * Extract ONE audio span [startSec, startSec+durationSec) from a video URL as
 * mono mp3 — used by the transcript gap-fill pass to re-transcribe just the
 * missing stretch. `-ss` before `-i` = fast keyframe seek; the ± keyframe
 * imprecision is irrelevant for ASR.
 */
export async function extractAudioSpanFromUrl(
	videoUrl: string,
	startSec: number,
	durationSec: number,
): Promise<AudioExtractionResult> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-span-${randomUUID()}.mp3`);

	const ffmpegArgs = [
		"-ss",
		String(Math.max(0, startSec)),
		"-t",
		String(durationSec),
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio span extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({
					filePath: outputPath,
					mimeType: "audio/mpeg",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
						} catch {}
					},
				});
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(
					new Error(`Audio span extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc -b` (from repo root)
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/web/lib/audio-extract.ts
git commit -m "feat: extractAudioSpanFromUrl for targeted gap re-transcription"
```

---

### Task 3: Gap-fill pass + metadata flag — the class closure

After `transcribeAudioChunks` merges everything, measure gaps in the FINAL VTT; re-transcribe each gap in ≤5-min spans (short audio is far more reliable than the 15-min chunks that produced the hole); merge the recovered cues in; record whatever still can't be filled in `metadata.transcriptionGaps` (silence or persistent ASR failure) instead of silently shipping a holey transcript.

**Files:**
- Modify: `packages/database/types/metadata.ts` (~line 70, next to `transcriptionChunksTotal`)
- Modify: `apps/web/workflows/transcribe.ts` (workflow body ~line 97-109; new step + orchestrator; `saveTranscription` ~line 697)
- Test: `apps/web/__tests__/unit/transcribe-gap-fill.test.ts` (extend)

**Interfaces:**
- Consumes: `findVttGaps`/`VttGap` (Task 1), `extractAudioSpanFromUrl` (Task 2), existing `transcribeAudio` step, `mergeChunkedWebVtt`, `restoreRussianScript`, `mapWithConcurrency`, `AI_CHUNK_CONCURRENCY`, `cleanupTempAudioKeys`, `resolveVideoSourceUrl`, `getStorageAccessForVideo`.
- Produces: `export async function fillTranscriptGaps(args, deps?): Promise<{ transcription: string; remainingGaps: VttGap[] }>` and `VideoMetadata.transcriptionGaps?: { startSec: number; endSec: number }[]`.

- [ ] **Step 1: Add the metadata field**

In `packages/database/types/metadata.ts`, after `transcriptionChunksTotal?: number;` (line 70), add:

```ts
	/**
	 * Holes (>120s) left in the final transcript after the gap-fill pass —
	 * either genuine silence or a stretch the ASR persistently failed on.
	 * Absent/undefined when the transcript is fully covered.
	 */
	transcriptionGaps?: { startSec: number; endSec: number }[];
```

- [ ] **Step 2: Write the failing tests for `fillTranscriptGaps`**

Append to `apps/web/__tests__/unit/transcribe-gap-fill.test.ts`:

```ts
import { fillTranscriptGaps } from "../../workflows/transcribe";

const fakeVideo = {} as never; // deps are injected; the video row is never touched

function ctx() {
	return { userId: "u1", orgId: "o1", videoId: "v1" };
}

describe("fillTranscriptGaps", () => {
	it("returns the input unchanged when there are no gaps", async () => {
		const v = vtt([[0, 50, "a"], [60, 110, "b"]]);
		let extractCalled = false;
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: v, totalDurationSec: 120,
			},
			{
				extractSpans: async () => { extractCalled = true; return []; },
				transcribeFn: async () => "WEBVTT\n\n",
				cleanupFn: async () => {},
			},
		);
		expect(out.transcription).toBe(v);
		expect(out.remainingGaps).toEqual([]);
		expect(extractCalled).toBe(false);
	});

	it("fills a leading gap from re-transcribed spans", async () => {
		// Cues only from 854s; gap 0-854 must be filled by span transcription.
		const holey = vtt([[854, 860, "late"], [900, 906, "tail"]]);
		const requestedSpans: Array<{ startSec: number; durationSec: number }> = [];
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 910,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) => {
					requestedSpans.push(...spans);
					return spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
					}));
				},
				// Each span returns a cue every 60s so the hole disappears.
				transcribeFn: async (_url, durationSec) => {
					const cues: Array<[number, number, string]> = [];
					for (let t = 0; t < (durationSec ?? 0); t += 60) {
						cues.push([t, Math.min(t + 5, (durationSec ?? 0)), "filled"]);
					}
					return vtt(cues);
				},
				cleanupFn: async () => {},
			},
		);
		// 854s gap → ceil(854/300) = 3 spans of ≤300s
		expect(requestedSpans.length).toBe(3);
		expect(requestedSpans[0]).toEqual({ startSec: 0, durationSec: 300 });
		expect(out.remainingGaps).toEqual([]);
		expect(out.transcription).toContain("filled");
		expect(out.transcription).toContain("late");
	});

	it("keeps the gap in remainingGaps when span transcription fails (silence)", async () => {
		const holey = vtt([[854, 860, "late"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 900,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
					})),
				transcribeFn: async () => {
					throw new Error("empty transcript from Gemini");
				},
				cleanupFn: async () => {},
			},
		);
		expect(out.remainingGaps).toEqual([{ startSec: 0, endSec: 854 }]);
		expect(out.transcription).toContain("late");
	});

	it("survives a wholesale extraction failure (returns original + gaps)", async () => {
		const holey = vtt([[854, 860, "late"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 900,
			},
			{
				extractSpans: async () => { throw new Error("ffmpeg died"); },
				transcribeFn: async () => "WEBVTT\n\n",
				cleanupFn: async () => {},
			},
		);
		expect(out.transcription).toBe(holey);
		expect(out.remainingGaps).toEqual([{ startSec: 0, endSec: 854 }]);
	});

	it("cleans up every uploaded span key", async () => {
		const holey = vtt([[400, 410, "x"]]);
		const cleaned: string[] = [];
		await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 420,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `gap-key-${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
					})),
				transcribeFn: async () => vtt([[0, 5, "ok"]]),
				cleanupFn: async (keys) => { cleaned.push(...keys); },
			},
		);
		expect(cleaned.length).toBeGreaterThan(0);
		expect(cleaned.every((k) => k.startsWith("gap-key-"))).toBe(true);
	});
});
```

Note: `vtt()`, `describe/expect/it` already imported/defined in this file from Task 1.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-gap-fill.test.ts`
Expected: FAIL — `fillTranscriptGaps` is not exported.

- [ ] **Step 4: Implement the step + orchestrator**

In `apps/web/workflows/transcribe.ts`:

(a) Add the import of `extractAudioSpanFromUrl` to the existing `@/lib/audio-extract` import block (lines 24-28):

```ts
import {
	checkHasAudioTrack,
	extractAudioChunksFromUrl,
	extractAudioFromUrl,
	extractAudioSpanFromUrl,
} from "@/lib/audio-extract";
```

(b) After `findVttGaps` (Task 1 code), add the step and the orchestrator:

```ts
/** Gap-fill spans are deliberately SHORT: Gemini is far more reliable on ≤5-min
 * audio than on the 15-min chunks that produced the hole in the first place. */
export const GAP_FILL_SPAN_SEC = 5 * 60;
/** Upper bound on gap-fill work per video (12 spans = 1h of re-transcription). */
export const MAX_GAP_FILL_SPANS = 12;

interface GapSpanAudio {
	key: string;
	url: string;
	startSec: number;
	durationSec: number;
}

async function extractGapSpanAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	spans: Array<{ startSec: number; durationSec: number }>,
): Promise<GapSpanAudio[]> {
	"use step";

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const videoUrl = await resolveVideoSourceUrl(videoId, userId, video);

	const out: GapSpanAudio[] = [];
	for (const span of spans) {
		// One failed span must not kill the whole gap-fill pass.
		try {
			const result = await extractAudioSpanFromUrl(
				videoUrl,
				span.startSec,
				span.durationSec,
			);
			try {
				const audioBuffer = await fs.readFile(result.filePath);
				const key = `${userId}/${videoId}/audio-gap-${Math.round(span.startSec)}.mp3`;
				await bucket
					.putObject(key, audioBuffer, { contentType: "audio/mpeg" })
					.pipe(runPromise);
				const url = await bucket
					.getInternalSignedObjectUrl(key)
					.pipe(runPromise);
				out.push({ key, url, startSec: span.startSec, durationSec: span.durationSec });
			} finally {
				await result.cleanup();
			}
		} catch (error) {
			console.warn(
				`[transcribe] gap-fill span extraction at ${span.startSec}s failed for ${videoId}; skipping span`,
				error,
			);
		}
	}
	return out;
}

/**
 * Merge-level safety net for the "dropped section" class: whatever holes the
 * per-chunk retries left in the FINAL merged transcript get re-transcribed in
 * short spans and merged back in. Holes that survive (genuine silence or
 * persistent ASR failure) are returned so the caller can RECORD them instead
 * of silently shipping a gapped transcript as complete.
 */
export async function fillTranscriptGaps(
	{
		videoId,
		userId,
		video,
		ownerEncryptedGeminiKey,
		context,
		mergedVtt,
		totalDurationSec,
	}: {
		videoId: string;
		userId: string;
		video: typeof videos.$inferSelect;
		ownerEncryptedGeminiKey: string | null;
		context: { userId: string; orgId: string; videoId: string };
		mergedVtt: string;
		totalDurationSec: number | null;
	},
	deps: {
		extractSpans?: typeof extractGapSpanAudio;
		transcribeFn?: typeof transcribeAudio;
		cleanupFn?: typeof cleanupTempAudioKeys;
	} = {},
): Promise<{ transcription: string; remainingGaps: VttGap[] }> {
	const extractSpans = deps.extractSpans ?? extractGapSpanAudio;
	const transcribeFn = deps.transcribeFn ?? transcribeAudio;
	const cleanupFn = deps.cleanupFn ?? cleanupTempAudioKeys;

	const gaps = findVttGaps(mergedVtt, totalDurationSec);
	if (gaps.length === 0) {
		return { transcription: mergedVtt, remainingGaps: [] };
	}

	const spans: Array<{ startSec: number; durationSec: number }> = [];
	for (const gap of gaps) {
		for (let s = gap.startSec; s < gap.endSec; s += GAP_FILL_SPAN_SEC) {
			if (spans.length >= MAX_GAP_FILL_SPANS) break;
			spans.push({
				startSec: s,
				durationSec: Math.min(GAP_FILL_SPAN_SEC, gap.endSec - s),
			});
		}
	}
	console.warn(
		`[transcribe] gap-fill for ${videoId}: ${gaps.length} gap(s) -> ${spans.length} span(s): ${JSON.stringify(gaps.map((g) => [Math.round(g.startSec), Math.round(g.endSec)]))}`,
	);

	let spanAudios: GapSpanAudio[];
	try {
		spanAudios = await extractSpans(videoId, userId, video, spans);
	} catch (error) {
		console.error(
			`[transcribe] gap-fill audio extraction failed for ${videoId}; keeping gapped transcript`,
			error,
		);
		return { transcription: mergedVtt, remainingGaps: gaps };
	}

	const parts: Array<{ vtt: string; offsetSec: number }> = [
		{ vtt: mergedVtt, offsetSec: 0 },
	];
	await mapWithConcurrency(spanAudios, AI_CHUNK_CONCURRENCY, async (span) => {
		try {
			const vtt = await transcribeFn(
				span.url,
				span.durationSec,
				ownerEncryptedGeminiKey,
				context,
			);
			parts.push({ vtt, offsetSec: span.startSec });
		} catch (error) {
			console.warn(
				`[transcribe] gap-fill span at ${span.startSec}s failed for ${videoId} (silence or ASR failure)`,
				error,
			);
		}
	});

	await cleanupFn(spanAudios.map((s) => s.key), video);

	const filled =
		parts.length > 1
			? restoreRussianScript(mergeChunkedWebVtt(parts))
			: mergedVtt;
	const remainingGaps = findVttGaps(filled, totalDurationSec);
	if (remainingGaps.length > 0) {
		console.warn(
			`[transcribe] gap-fill for ${videoId}: ${remainingGaps.length} gap(s) REMAIN (recorded in metadata): ${JSON.stringify(remainingGaps.map((g) => [Math.round(g.startSec), Math.round(g.endSec)]))}`,
		);
	}
	return { transcription: filled, remainingGaps };
}
```

(c) Wire into the workflow body — replace lines 97-109 (`const transcription = await transcribeAudioChunks(...)` through `await saveTranscription(...)`) with:

```ts
		const transcription = await transcribeAudioChunks(
			audio,
			videoData.ownerEncryptedGeminiKey,
			{ userId, orgId: videoData.orgId, videoId },
			undefined,
			async (p) => {
				await savePartialTranscription(
					videoId, videoData.video, p.transcribedChunks, p.completed, p.total,
				);
			},
		);

		// Merge-level gap-fill: close any hole the per-chunk retries left behind.
		const gapFill = await fillTranscriptGaps({
			videoId,
			userId,
			video: videoData.video,
			ownerEncryptedGeminiKey: videoData.ownerEncryptedGeminiKey,
			context: { userId, orgId: videoData.orgId, videoId },
			mergedVtt: transcription,
			totalDurationSec: audio.totalDurationSec,
		});

		await saveTranscription(
			videoId,
			userId,
			videoData.video,
			gapFill.transcription,
			gapFill.remainingGaps,
		);
```

(d) Update `saveTranscription` (line 697) — new signature and gap recording. Replace the whole function with:

```ts
async function saveTranscription(
	videoId: string,
	_userId: string,
	video: typeof videos.$inferSelect,
	transcription: string,
	remainingGaps: VttGap[] = [],
): Promise<void> {
	"use step";

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

	await bucket
		.putObject(`${video.ownerId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);
	const md = { ...((row?.metadata as VideoMetadata) || {}) } as VideoMetadata;
	delete (md as any).transcriptionChunksCompleted;
	delete (md as any).transcriptionChunksTotal;
	if (remainingGaps.length > 0) {
		md.transcriptionGaps = remainingGaps.map((g) => ({
			startSec: Math.round(g.startSec),
			endSec: Math.round(g.endSec),
		}));
	} else {
		delete md.transcriptionGaps;
	}
	await db()
		.update(videos)
		.set({ transcriptionStatus: "COMPLETE", metadata: md })
		.where(eq(videos.id, videoId as Video.VideoId));
	// best-effort delete partial file (never throw)
	await bucket
		.deleteObject(`${video.ownerId}/${videoId}/transcription-partial.vtt`)
		.pipe(runPromise)
		.catch(() => {});
}
```

- [ ] **Step 5: Run tests + full unit suite + typecheck**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-gap-fill.test.ts` → PASS (13 tests).
Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-chunks.test.ts __tests__/unit/transcribe-chunk-coverage.test.ts` → PASS (no regression).
Run: `pnpm tsc -b` (root) → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/workflows/transcribe.ts packages/database/types/metadata.ts apps/web/__tests__/unit/transcribe-gap-fill.test.ts
git commit -m "feat: merge-level transcript gap-fill pass + transcriptionGaps metadata"
```

---

### Task 4: One-retry on summary-chunk & synthesis JSON parses

Today one malformed per-chunk JSON silently drops that 15-min section from the whole summary (`generate-ai.ts:1175-1178`), and a malformed final synthesis immediately falls back to concatenated chunk summaries (`generate-ai.ts:1383`). Both get exactly one fresh retry.

**Files:**
- Modify: `apps/web/workflows/generate-ai.ts` (add helper before `generateMultipleChunks` ~line 1117; use at lines ~1161-1178 and ~1345-1350)
- Test: `apps/web/__tests__/unit/generate-ai-json-retry.test.ts` (create)

**Interfaces:**
- Produces (internal): `parseJsonWithRetry(fetchContent: (attempt: number) => Promise<{ content: string; inputTokens: number; outputTokens: number; model: string }>, label: string)` → `Promise<{ parsed: Record<string, unknown> | null; inputTokens: number; outputTokens: number; model: string }>`. Exported for tests.

- [ ] **Step 1: Write the failing test**

Create `apps/web/__tests__/unit/generate-ai-json-retry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseJsonWithRetry } from "../../workflows/generate-ai";

function attemptSeq(contents: string[]) {
	let calls = 0;
	return {
		fetch: async (_attempt: number) => {
			const content = contents[calls] ?? "{}";
			calls++;
			return { content, inputTokens: 10, outputTokens: 5, model: "m" };
		},
		calls: () => calls,
	};
}

describe("parseJsonWithRetry", () => {
	it("parses on the first attempt without retrying", async () => {
		const seq = attemptSeq(['{"a":1}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 1 });
		expect(seq.calls()).toBe(1);
		expect(out.inputTokens).toBe(10);
	});

	it("retries ONCE on a malformed first response and succeeds", async () => {
		const seq = attemptSeq(['{"a": TRUNC', '{"a":2}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 2 });
		expect(seq.calls()).toBe(2);
		// tokens from BOTH attempts are accumulated (both were paid for)
		expect(out.inputTokens).toBe(20);
		expect(out.outputTokens).toBe(10);
	});

	it("returns parsed:null after two failures (no third attempt)", async () => {
		const seq = attemptSeq(["not json", "still not json", '{"never":1}']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toBeNull();
		expect(seq.calls()).toBe(2);
	});

	it("strips markdown code fences before parsing", async () => {
		const seq = attemptSeq(['```json\n{"a":3}\n```']);
		const out = await parseJsonWithRetry(seq.fetch, "test");
		expect(out.parsed).toEqual({ a: 3 });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/generate-ai-json-retry.test.ts`
Expected: FAIL — `parseJsonWithRetry` is not exported.

- [ ] **Step 3: Implement the helper**

In `apps/web/workflows/generate-ai.ts`, directly before `generateMultipleChunks` (~line 1117), add:

```ts
/**
 * Fetch AI content and JSON-parse it; on a parse failure make EXACTLY ONE
 * fresh attempt (a fresh Gemini call usually returns well-formed JSON — the
 * failures are stochastic truncation/markdown noise, not deterministic).
 * Token usage from ALL attempts is accumulated (both were paid for).
 * Returns parsed:null after both attempts fail; the caller decides fallback.
 */
export async function parseJsonWithRetry(
	fetchContent: (attempt: number) => Promise<{
		content: string;
		inputTokens: number;
		outputTokens: number;
		model: string;
	}>,
	label: string,
): Promise<{
	parsed: Record<string, unknown> | null;
	inputTokens: number;
	outputTokens: number;
	model: string;
}> {
	let inputTokens = 0;
	let outputTokens = 0;
	let model = "unknown";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const result = await fetchContent(attempt);
		inputTokens += result.inputTokens;
		outputTokens += result.outputTokens;
		model = result.model;
		try {
			return {
				parsed: JSON.parse(cleanJsonResponse(result.content).trim()),
				inputTokens,
				outputTokens,
				model,
			};
		} catch {
			console.error(
				`[generate-ai] ${label} JSON parse FAILED (attempt ${attempt}/2)`,
				{ contentLength: result.content.length, tail: result.content.slice(-150) },
			);
		}
	}
	return { parsed: null, inputTokens, outputTokens, model };
}
```

- [ ] **Step 4: Use it for per-chunk summaries**

In `generateMultipleChunks`, replace the per-chunk call/parse block (currently lines 1161-1178, from `const chunkResult = await callAiApi(chunkPrompt, {}, context);` through the `catch` returning `null`) with:

```ts
			const { parsed, inputTokens, outputTokens, model } =
				await parseJsonWithRetry(
					() => callAiApi(chunkPrompt, {}, context),
					`per-chunk summary [${chunk.startTime}-${chunk.endTime}s]`,
				);
			totalInputTokens += inputTokens;
			totalOutputTokens += outputTokens;
			usedModel = model;
			if (!parsed) {
				console.error(
					"[generate-ai] per-chunk summary FAILED after retry (chunk skipped)",
					{ startTime: chunk.startTime, endTime: chunk.endTime },
				);
				return null;
			}
			return {
				summary: (parsed.summary as string) || "",
				keyPoints: (parsed.keyPoints as string[]) || [],
				chapters: (parsed.chapters as { title: string; start: number }[]) || [],
				startTime: chunk.startTime,
				endTime: chunk.endTime,
				rawText: chunk.text,
			};
```

- [ ] **Step 5: Use it for the final synthesis**

Still in `generateMultipleChunks`, replace the final-synthesis block (currently lines 1345-1350: `const finalResult = await callAiApi(finalPrompt, {}, context);` + token accumulation + `try { const parsed = JSON.parse(...)`) so the structure becomes:

```ts
	const {
		parsed,
		inputTokens: finalInputTokens,
		outputTokens: finalOutputTokens,
		model: finalModel,
	} = await parseJsonWithRetry(
		() => callAiApi(finalPrompt, {}, context),
		"final synthesis",
	);
	totalInputTokens += finalInputTokens;
	totalOutputTokens += finalOutputTokens;
	usedModel = finalModel;
	if (parsed) {
		const aiSummaryRaw = parsed.aiSummary ?? {
			// ... keep the existing object body from the old try-block verbatim
		};
		// ... keep the rest of the existing try-block body verbatim (refinedTranscript
		//     override + return) — only the JSON.parse line is gone.
	}
	// keep the existing catch-block body verbatim as the fall-through when
	// parsed === null (remove the try/catch wrapper, delete only the
	// console.error line that logged the parse failure — parseJsonWithRetry
	// already logged both attempts).
	const fallbackSummary = chunkSummaries
		// ... existing fallback code unchanged ...
```

Concretely: the old `try { ... }` body (minus the `JSON.parse` line, using `parsed` directly) runs under `if (parsed) { ... return ... }`; the old `catch { ... }` body (minus its `console.error`) follows as straight-line code.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/generate-ai-json-retry.test.ts` → PASS (4 tests).
Run: `pnpm tsc -b` → exit 0.
Run: `pnpm --filter @cap/web run test` → no new failures.

- [ ] **Step 7: Commit**

```bash
git add apps/web/workflows/generate-ai.ts apps/web/__tests__/unit/generate-ai-json-retry.test.ts
git commit -m "feat: one-retry on per-chunk and synthesis JSON parses (no silent 15-min summary loss)"
```

---

### Task 5: `restoreRussianScriptDeep` + guard every AI output surface

Today `restoreRussianScript` runs ONLY on the transcript VTT (`workflows/transcribe.ts:440,513`). Summary, refined transcript, and translations rely on prompt rules alone — the very failure mode the guard exists for.

**Files:**
- Modify: `apps/web/lib/restore-russian-script.ts` (add deep variant)
- Modify: `apps/web/workflows/generate-ai.ts` (`generateWithAi` return, ~line 412)
- Modify: `apps/web/lib/translate-ai.ts` (`translateAiContent`, ~lines 549 and 563)
- Test: `apps/web/__tests__/unit/restore-russian-script.test.ts` (extend)

**Interfaces:**
- Produces: `export function restoreRussianScriptDeep<T>(value: T): T`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/__tests__/unit/restore-russian-script.test.ts`:

```ts
import { restoreRussianScriptDeep } from "../../lib/restore-russian-script";

describe("restoreRussianScriptDeep", () => {
	it("restores romanized Russian in every nested string field", () => {
		const input = {
			title: "Lyuboy plan",
			topics: [{ title: "Srazu boshladik", body: "U **vapshe** kelmadi" }],
			nextSteps: ["Konechno qilamiz"],
			nested: { deep: { list: ["znachit shunday"] } },
		};
		const out = restoreRussianScriptDeep(input);
		expect(out.title).toBe("Любой plan");
		expect(out.topics[0]?.title).toBe("Сразу boshladik");
		expect(out.topics[0]?.body).toBe("U **вообще** kelmadi");
		expect(out.nextSteps[0]).toBe("Конечно qilamiz");
		expect(out.nested.deep.list[0]).toBe("значит shunday");
	});

	it("leaves numbers, booleans, null and undefined untouched", () => {
		const input = { startSec: 120, done: false, missing: null, u: undefined };
		expect(restoreRussianScriptDeep(input)).toEqual(input);
	});

	it("does not mutate the input object", () => {
		const input = { s: "lyuboy" };
		const out = restoreRussianScriptDeep(input);
		expect(input.s).toBe("lyuboy");
		expect(out.s).toBe("любой");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/restore-russian-script.test.ts`
Expected: FAIL — `restoreRussianScriptDeep` is not exported.

- [ ] **Step 3: Implement the deep variant**

In `apps/web/lib/restore-russian-script.ts`, after `restoreRussianScript`, add:

```ts
/**
 * Apply restoreRussianScript to EVERY string inside an arbitrary JSON-like
 * value (AI summary objects, translated summaries…). Non-strings pass through
 * untouched; the input is never mutated. This is how the guard covers the
 * summary/refined/translation surfaces, not just the transcript VTT.
 */
export function restoreRussianScriptDeep<T>(value: T): T {
	if (typeof value === "string") {
		return restoreRussianScript(value) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => restoreRussianScriptDeep(item)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, inner] of Object.entries(value)) {
			out[key] = restoreRussianScriptDeep(inner);
		}
		return out as unknown as T;
	}
	return value;
}
```

- [ ] **Step 4: Apply at the generation surface**

In `apps/web/workflows/generate-ai.ts`:

(a) Add to imports (top of file):

```ts
import { restoreRussianScriptDeep } from "@/lib/restore-russian-script";
```

(b) In `generateWithAi`, change the final line (currently `return result;` at ~line 412) to:

```ts
	// Deterministic script guard on EVERY AI output surface (title, summary,
	// chapters, aiSummary incl. refined paragraphs) — the prompt asks, this
	// guarantees. _usage contains only numbers and passes through untouched.
	return restoreRussianScriptDeep(result);
```

- [ ] **Step 5: Apply at the translation surface**

In `apps/web/lib/translate-ai.ts`:

(a) Add to imports:

```ts
import {
	restoreRussianScript,
	restoreRussianScriptDeep,
} from "@/lib/restore-russian-script";
```

(b) At ~line 549, wrap the summary translation:

```ts
		const translatedSummary = restoreRussianScriptDeep(
			await translateAiSummary(baseSummary, language, context),
		);
```

(where `baseSummary` is whatever variable name the existing call passes — keep the existing arguments, only wrap the awaited result).

(c) At ~line 563, guard the translated cue texts:

```ts
				const translatedTexts = (
					await translateVttCueTexts(cues, language, context)
				).map(restoreRussianScript);
```

(keep the existing arguments to `translateVttCueTexts` exactly as they are; only add the `.map(restoreRussianScript)`).

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/restore-russian-script.test.ts` → PASS.
Run: `pnpm tsc -b` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/restore-russian-script.ts apps/web/workflows/generate-ai.ts apps/web/lib/translate-ai.ts apps/web/__tests__/unit/restore-russian-script.test.ts
git commit -m "feat: apply Russian-script guard to summary, refined and translation outputs"
```

---

### Task 6: Dictionary expansion (~90 conservative entries)

**Files:**
- Modify: `apps/web/lib/restore-russian-script.ts` (extend `ROMANIZED_RUSSIAN`, lines 19-60)
- Test: `apps/web/__tests__/unit/restore-russian-script.test.ts` (extend)

⚠️ **Curation rule (repeat of the file's own doc):** every entry must be unambiguously spoken Russian. NEVER add legitimate Uzbek-Latin vocabulary (byudjet, klient, proyekt, dogovor, printsip, moment, plan, prosent…) or common English words. The list below was pre-screened against Uzbek and English; while implementing, re-check any entry you doubt and DROP it rather than risk corrupting good text.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/__tests__/unit/restore-russian-script.test.ts`:

```ts
import { restoreRussianScript } from "../../lib/restore-russian-script";

describe("expanded dictionary", () => {
	it("restores newly added high-frequency spoken-Russian words", () => {
		const cases: Array<[string, string]> = [
			["eto muhim", "это muhim"],
			["esli kelsa", "если kelsa"],
			["mozhet bo'ladi", "может bo'ladi"],
			["mojno savol", "можно savol"],
			["nuzhno qilish", "нужно qilish"],
			["nado tezroq", "надо tezroq"],
			["budet yaxshi", "будет yaxshi"],
			["bylo qiziq", "было qiziq"],
			["horosho dedi", "хорошо dedi"],
			["xarasho dedi", "хорошо dedi"],
			["normalno ishladi", "нормально ishladi"],
			["ponyatno bo'ldi", "понятно bo'ldi"],
			["tolko bitta", "только bitta"],
			["ochen zo'r", "очень zo'r"],
			["potom qilamiz", "потом qilamiz"],
			["segodnya boshlaymiz", "сегодня boshlaymiz"],
			["hvatit endi", "хватит endi"],
			["xvatit endi", "хватит endi"],
			["posmotrim keyin", "посмотрим keyin"],
			["sovsem boshqa", "совсем boshqa"],
			["pravilno aytdingiz", "правильно aytdingiz"],
			["vazhno bu", "важно bu"],
			["poluchilos zo'r", "получилось zo'r"],
		];
		for (const [input, expected] of cases) {
			expect(restoreRussianScript(input)).toBe(expected);
		}
	});

	it("preserves capitalization on new words", () => {
		expect(restoreRussianScript("Horosho, boshladik")).toBe("Хорошо, boshladik");
		expect(restoreRussianScript("ETO muhim")).toBe("ЭТО muhim");
	});

	it("NEVER touches legitimate Uzbek loanwords or English words", () => {
		const untouched = [
			"byudjet tasdiqlandi",
			"klient keldi",
			"proyekt boshlandi",
			"printsip bo'yicha",
			"moment kutamiz",
			"dogovor imzolandi",
			"plan tayyor",
			"deadline ertaga",
			"dashboard ochildi",
			"bugun ish bor",
			"paket yetib keldi",
		];
		for (const text of untouched) {
			expect(restoreRussianScript(text)).toBe(text);
		}
	});
});
```

Note: if `restoreRussianScript` is already imported at the top of this test file, skip the duplicate import.

- [ ] **Step 2: Run tests to verify the new-words test fails**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/restore-russian-script.test.ts`
Expected: FAIL on "restores newly added..." (words not in dictionary yet); the "NEVER touches" test should already pass.

- [ ] **Step 3: Extend the dictionary**

In `apps/web/lib/restore-russian-script.ts`, inside `ROMANIZED_RUSSIAN` (after the existing `shto: "что",` entry), append:

```ts
	// --- expansion 2026-07-02: high-frequency spoken-Russian discourse words.
	// Same conservative rule: NOTHING that is legitimate Uzbek-Latin or common
	// English. Variants (h/kh/x for х, a for unstressed o) map to one target.
	eto: "это",
	etogo: "этого",
	etomu: "этому",
	esli: "если",
	toest: "то есть",
	tozhe: "тоже",
	toje: "тоже",
	mozhet: "может",
	mojet: "может",
	mozhno: "можно",
	mojno: "можно",
	nelzya: "нельзя",
	nuzhno: "нужно",
	nujno: "нужно",
	nado: "надо",
	budet: "будет",
	budem: "будем",
	budesh: "будешь",
	bylo: "было",
	byli: "были",
	horosho: "хорошо",
	khorosho: "хорошо",
	xorosho: "хорошо",
	harasho: "хорошо",
	xarasho: "хорошо",
	ploho: "плохо",
	plokho: "плохо",
	ploxo: "плохо",
	normalno: "нормально",
	narmalna: "нормально",
	konkretno: "конкретно",
	primerno: "примерно",
	ponyatno: "понятно",
	panyatna: "понятно",
	ponimaesh: "понимаешь",
	panimaesh: "понимаешь",
	ponimaete: "понимаете",
	znaesh: "знаешь",
	znaete: "знаете",
	smotri: "смотри",
	smotrite: "смотрите",
	slushay: "слушай",
	slushayte: "слушайте",
	davno: "давно",
	potom: "потом",
	patom: "потом",
	poetomu: "поэтому",
	teper: "теперь",
	tiper: "теперь",
	segodnya: "сегодня",
	sivodnya: "сегодня",
	zavtra: "завтра",
	vchera: "вчера",
	vchira: "вчера",
	vopros: "вопрос",
	voprosy: "вопросы",
	otvet: "ответ",
	tolko: "только",
	tolka: "только",
	ochen: "очень",
	ochin: "очень",
	bolshe: "больше",
	menshe: "меньше",
	luchshe: "лучше",
	luchche: "лучше",
	vazhno: "важно",
	vajno: "важно",
	interesno: "интересно",
	slozhno: "сложно",
	slojno: "сложно",
	bystro: "быстро",
	gotovo: "готово",
	gotov: "готов",
	gotovy: "готовы",
	otlichno: "отлично",
	atlichna: "отлично",
	soglasen: "согласен",
	soglasna: "согласна",
	soglasny: "согласны",
	kazhetsya: "кажется",
	kajetsya: "кажется",
	dopustim: "допустим",
	predstavlyaesh: "представляешь",
	obshem: "общем",
	obshchem: "общем",
	vaobshe: "вообще",
	pravilno: "правильно",
	nepravilno: "неправильно",
	vmeste: "вместе",
	otdelno: "отдельно",
	postoyanno: "постоянно",
	obychno: "обычно",
	abychna: "обычно",
	chasto: "часто",
	redko: "редко",
	pochti: "почти",
	sovsem: "совсем",
	savsem: "совсем",
	poprobuem: "попробуем",
	poprobuy: "попробуй",
	posmotrim: "посмотрим",
	posmotri: "посмотри",
	proverim: "проверим",
	podozhdi: "подожди",
	podojdi: "подожди",
	podozhdite: "подождите",
	hvatit: "хватит",
	khvatit: "хватит",
	xvatit: "хватит",
	poluchitsya: "получится",
	paluchitsya: "получится",
	poluchilos: "получилось",
	paluchilos: "получилось",
	rabotaet: "работает",
	rabotayet: "работает",
	sdelaem: "сделаем",
	sdelat: "сделать",
	sdelali: "сделали",
	naoborot: "наоборот",
	smysl: "смысл",
	smysle: "смысле",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/restore-russian-script.test.ts`
Expected: PASS — all new-word cases AND all untouched cases green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/restore-russian-script.ts apps/web/__tests__/unit/restore-russian-script.test.ts
git commit -m "feat: expand romanized-Russian dictionary (~90 conservative entries)"
```

---

### Task 7: Speaker naming — prompt upgrade + cross-chunk roster carry

The prompt already requests `<v Speaker N>` diarization and the UI already renders labels (avatars/grouping in `TranscriptPanel.tsx`). Two gaps: (1) name identification is passive ("if names are known"); (2) chunks are transcribed independently, so labels drift across chunks. Fix: hunt names actively, fall back to "Spiker N" (dominant-language spelling), and hand a name roster harvested from chunk 0 to every later chunk.

**Files:**
- Modify: `apps/web/lib/gemini-transcribe.ts` (`buildTranscriptionPrompt` ~line 435; `transcribeWithGemini` ~line 502; add `extractSpeakerLabels`)
- Modify: `apps/web/workflows/transcribe.ts` (`transcribeAudio` ~line 376; `transcribeAudioChunkWithRetry` ~line 593; `transcribeAudioChunks` ~line 430)
- Test: `apps/web/__tests__/unit/speaker-labels.test.ts` (create)

**Interfaces:**
- Produces: `export function extractSpeakerLabels(vtt: string): string[]`; `buildTranscriptionPrompt(opts?: { knownSpeakers?: string[] })`; `transcribeWithGemini(audioUrl, { apiKey, audioDurationSec?, knownSpeakers? })`; `transcribeAudio(audioUrl, audioDurationSec, ownerEncryptedGeminiKey, context, knownSpeakers?)`; `transcribeAudioChunkWithRetry({ chunk, ownerEncryptedGeminiKey, context, knownSpeakers? }, transcribeFn?)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/__tests__/unit/speaker-labels.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	buildTranscriptionPrompt,
	extractSpeakerLabels,
} from "../../lib/gemini-transcribe";

describe("extractSpeakerLabels", () => {
	it("collects unique real names from voice tags", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:01.000 --> 00:00:04.000",
			"<v Alisher>Assalomu alaykum</v>",
			"",
			"2",
			"00:00:05.000 --> 00:00:08.000",
			"<v Dilnoza>Va alaykum assalom</v>",
			"",
			"3",
			"00:00:09.000 --> 00:00:12.000",
			"<v Alisher>Boshlaymizmi?</v>",
			"",
		].join("\n");
		expect(extractSpeakerLabels(vtt)).toEqual(["Alisher", "Dilnoza"]);
	});

	it("filters out generic numbered labels and 'Boshqa ovoz'", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:01.000 --> 00:00:04.000",
			"<v Spiker 1>Salom</v>",
			"",
			"2",
			"00:00:05.000 --> 00:00:08.000",
			"<v Speaker 2>Hello</v>",
			"",
			"3",
			"00:00:09.000 --> 00:00:12.000",
			"<v Спикер 3>Привет</v>",
			"",
			"4",
			"00:00:13.000 --> 00:00:16.000",
			"<v Boshqa ovoz>...</v>",
			"",
			"5",
			"00:00:17.000 --> 00:00:20.000",
			"<v Alisher>Men keldim</v>",
			"",
		].join("\n");
		expect(extractSpeakerLabels(vtt)).toEqual(["Alisher"]);
	});

	it("returns [] for a VTT without voice tags", () => {
		expect(extractSpeakerLabels("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nplain\n\n")).toEqual([]);
	});
});

describe("buildTranscriptionPrompt speaker rules", () => {
	it("actively asks for name identification and Spiker fallback", () => {
		const prompt = buildTranscriptionPrompt();
		expect(prompt).toContain("ACTIVELY listen for speaker NAMES");
		expect(prompt).toContain("Spiker 1");
	});

	it("includes the roster block only when knownSpeakers is provided", () => {
		const without = buildTranscriptionPrompt();
		expect(without).not.toContain("Known speakers identified earlier");
		const withRoster = buildTranscriptionPrompt({
			knownSpeakers: ["Alisher", "Dilnoza"],
		});
		expect(withRoster).toContain("Known speakers identified earlier");
		expect(withRoster).toContain("Alisher, Dilnoza");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/speaker-labels.test.ts`
Expected: FAIL — `extractSpeakerLabels` not exported; prompt strings missing.

- [ ] **Step 3: Upgrade the prompt + add `extractSpeakerLabels`**

In `apps/web/lib/gemini-transcribe.ts`:

(a) Change the signature at line 435 to `export function buildTranscriptionPrompt(opts: { knownSpeakers?: string[] } = {}): string {` and replace rule 3 (lines 446-452) with:

```
3. Detect the content type from the recording:
- If it is a multi-speaker online/offline meeting, identify speakers by voice, context, and conversation flow.
- ACTIVELY listen for speaker NAMES throughout the whole recording: self-introductions ("Men Alisherman", "Меня зовут Дмитрий", "This is John"), people addressing each other ("Alisher aka, siz nima deysiz?", "Спасибо, Дмитрий", "Thanks, Sarah"), and names used in conversation. When you can confidently attach a name to a voice, use that NAME as the voice label for EVERY cue of that voice, e.g. <v Alisher>.
- If a voice's name is never revealed, use a numbered label in the dominant language — Uzbek: Spiker 1, Spiker 2; Russian: Спикер 1, Спикер 2; English: Speaker 1, Speaker 2 — and keep the SAME label for the same voice throughout.
- Never use both a name and a number for the same voice; once the name is known, use only the name.
- If two people talk over each other and both cannot be clearly separated, write [ustma-ust gaplashildi].
- If it is a one-speaker instruction, YouTube-style video, or voice note, do not invent speaker labels.
- If another person clearly speaks in the background and their words are important, use Boshqa ovoz.
```

(b) Update the OUTPUT FORMAT voice-tag line (currently line 497) to mention names:

```
- For multi-speaker cues, use standard WebVTT voice tags with the speaker's name when identified, else the numbered label: <v Alisher>spoken text</v> or <v Spiker 1>spoken text</v>.
```

(c) At the END of the returned template (after the last output-format line), append a conditional roster block. Change the function body to build the string, e.g.:

```ts
export function buildTranscriptionPrompt(
	opts: { knownSpeakers?: string[] } = {},
): string {
	const rosterBlock =
		opts.knownSpeakers && opts.knownSpeakers.length > 0
			? `\n\nKnown speakers identified earlier in this same recording: ${opts.knownSpeakers.join(", ")}.\nThis audio is a LATER segment of that same recording. When a voice clearly belongs to one of these people (they are named, addressed, or obvious from context), use exactly that label with the same spelling. Otherwise use the numbered fallback labels.`
			: "";
	return `...existing template, edited per (a) and (b)...${rosterBlock}`;
}
```

(d) Thread through `transcribeWithGemini`: extend its options type (line 505-508) with `knownSpeakers?: string[];`, destructure it (line 509), and change the prompt part at line 611 from `{ text: buildTranscriptionPrompt() }` to `{ text: buildTranscriptionPrompt({ knownSpeakers }) }`.

(e) Add `extractSpeakerLabels` after `mergeChunkedWebVtt`:

```ts
// Generic numbered fallback labels and the background-voice marker carry no
// cross-chunk identity — only REAL names go into the roster.
const GENERIC_SPEAKER_LABEL = /^(?:speaker|spiker|спикер)\s*\d+$/i;

/** Harvest real speaker names (<v Name> voice tags) from a chunk's VTT so
 * later chunks of the same recording can reuse the exact same labels. */
export function extractSpeakerLabels(vtt: string): string[] {
	const labels = new Set<string>();
	const re = /<v\s+([^>]+)>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(vtt)) !== null) {
		const label = (m[1] ?? "").trim();
		if (!label) continue;
		if (GENERIC_SPEAKER_LABEL.test(label)) continue;
		if (/^boshqa ovoz$/i.test(label)) continue;
		labels.add(label);
		if (labels.size >= 6) break;
	}
	return [...labels];
}
```

- [ ] **Step 4: Thread `knownSpeakers` through the workflow**

In `apps/web/workflows/transcribe.ts`:

(a) `transcribeAudio` (line 376): add a 5th parameter `knownSpeakers: string[] = []` and pass it into `transcribeWithGemini`:

```ts
async function transcribeAudio(
	audioUrl: string,
	audioDurationSec: number | null,
	ownerEncryptedGeminiKey: string | null,
	context: { userId: string; orgId: string; videoId: string },
	knownSpeakers: string[] = [],
): Promise<string> {
	"use step";
	// ...existing body unchanged until the transcribeWithGemini call:
				const res = await transcribeWithGemini(audioUrl, {
					apiKey: resolvedApiKey,
					audioDurationSec: audioDurationSec ?? undefined,
					knownSpeakers,
				});
	// ...rest unchanged
```

(b) `transcribeAudioChunkWithRetry` (line 593): add `knownSpeakers` to the input object type (`knownSpeakers?: string[];`), destructure it, and pass it on in the `transcribeFn` call inside the loop:

```ts
				const vtt = await transcribeFn(
					chunk.url,
					chunk.durationSec,
					ownerEncryptedGeminiKey,
					context,
					knownSpeakers ?? [],
				);
```

(c) Restructure the multi-chunk branch of `transcribeAudioChunks` (lines 456-497) — chunk 0 first (serial) to harvest the roster, then the rest concurrently. Replace the `const results = await mapWithConcurrency(...)` block with:

```ts
	// Worker shared by the serial first chunk and the concurrent rest — keeps
	// the fault-tolerance, progress-callback and result-indexing behavior
	// identical for every chunk.
	const processChunk = async (
		chunk: ExtractedAudioChunk,
		i: number,
		knownSpeakers: string[],
	): Promise<{ vtt: string; offsetSec: number }> => {
		let result: { vtt: string; offsetSec: number };
		try {
			const vtt = await transcribeChunk({
				chunk,
				ownerEncryptedGeminiKey,
				context,
				knownSpeakers,
			});
			result = { vtt, offsetSec: chunk.startSec };
		} catch (error) {
			// FAULT TOLERANCE (long-video fix): a single bad chunk must NOT discard the
			// whole transcript. Previously one failed chunk threw -> the outer catch marked
			// the ENTIRE video ERROR and dropped every successful chunk (root cause of
			// long-video AI failures). Now: log, keep a gap at this offset, and continue.
			failedChunkCount++;
			console.error(
				`[transcribe] Chunk at ${chunk.startSec}s FAILED for ${context.videoId} after retries; continuing with a gap:`,
				error,
			);
			result = { vtt: "WEBVTT\n\n", offsetSec: chunk.startSec };
		}
		completedResults[i] = result;
		completedCount++;
		if (onProgress) {
			try {
				await onProgress({
					transcribedChunks: completedResults.filter(
						(r): r is { vtt: string; offsetSec: number } => r !== undefined,
					),
					completed: completedCount,
					total: audio.chunks.length,
				});
			} catch (e) {
				console.error("[transcribe] partial-save progress callback failed (non-fatal):", e);
			}
		}
		return result;
	};

	// SPEAKER ROSTER CARRY: transcribe the FIRST chunk alone and harvest any
	// real speaker names it identified; every later chunk gets that roster so
	// labels stay consistent across independently-transcribed chunks.
	const firstChunk = audio.chunks[0];
	let knownSpeakers: string[] = [];
	if (firstChunk) {
		const firstResult = await processChunk(firstChunk, 0, []);
		knownSpeakers = extractSpeakerLabels(firstResult.vtt);
		if (knownSpeakers.length > 0) {
			console.log(
				`[transcribe] speaker roster for ${context.videoId}: ${knownSpeakers.join(", ")}`,
			);
		}
	}

	await mapWithConcurrency(
		audio.chunks.slice(1),
		AI_CHUNK_CONCURRENCY,
		(chunk, sliceIndex) => processChunk(chunk, sliceIndex + 1, knownSpeakers),
	);

	const transcribedChunks: Array<{ vtt: string; offsetSec: number }> =
		completedResults.filter(
			(r): r is { vtt: string; offsetSec: number } => r !== undefined,
		);
```

(d) Add `extractSpeakerLabels` to the import from `@/lib/gemini-transcribe` (lines 29-32):

```ts
import {
	extractSpeakerLabels,
	mergeChunkedWebVtt,
	transcribeWithGemini,
} from "@/lib/gemini-transcribe";
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/speaker-labels.test.ts` → PASS.
Run: `pnpm --filter @cap/web exec vitest run __tests__/unit/transcribe-chunks.test.ts __tests__/unit/transcribe-chunk-coverage.test.ts __tests__/unit/transcribe-gap-fill.test.ts` → PASS (the restructure must not break the fault-tolerance/progress tests; if a test injects `transcribeChunk` and asserts call ordering, sequential-chunk-0-then-parallel-rest still satisfies monotonic progress).
Run: `pnpm tsc -b` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/gemini-transcribe.ts apps/web/workflows/transcribe.ts apps/web/__tests__/unit/speaker-labels.test.ts
git commit -m "feat: active speaker-name identification with cross-chunk roster carry"
```

---

### Task 8: Full gate

- [ ] **Step 1: Root typecheck**

Run: `pnpm tsc -b`
Expected: exit 0.

- [ ] **Step 2: Full unit suite**

Run: `pnpm --filter @cap/web run test`
Expected: 0 failures beyond the known pre-existing `developer-credits-checkout` flake (re-run in isolation to confirm it's the flake, not this work).

- [ ] **Step 3: Review the whole diff**

Run: `git diff HEAD~7 --stat` and read every hunk of `git diff HEAD~7`. Check: no unrelated changes; no prompt template-literal got reindented (byte-diff the prompt strings if in doubt); no BOM added (`git diff HEAD~7 | Select-String -Pattern "\xEF\xBB\xBF"` should be empty).

- [ ] **Step 4: Commit any review fixes**

```bash
git add -A
git commit -m "chore: review fixes for long-video pipeline hardening"
```

(skip if nothing to fix)

---

### Task 9: Independent adversarial review

- [ ] **Step 1:** Get an independent review of the full diff (`git diff <base>..HEAD` where `<base>` is the commit before Task 1) from a DIFFERENT model family — Codex if available (`codex review` against the branch), else a FRESH reviewer session that did not author the code. Focus questions: (1) can gap-fill loop forever or double-bill (MAX_GAP_FILL_SPANS honored)? (2) can `fillTranscriptGaps` ever REPLACE good cues with worse span cues (merge is additive — verify)? (3) does the `transcribeAudioChunks` restructure preserve fault-tolerance for chunk 0 failing (roster just stays empty — verify)? (4) any dictionary entry that is legitimate Uzbek/English?
- [ ] **Step 2:** Fix real findings, re-run the Task 8 gate, commit.

---

### Task 10: Deploy + live proof on a real ≥2h video (autoresearch metric)

**Success metrics (measured, not assumed):**
1. **Gap metric:** final `transcription.vtt` of the re-transcribed 2h+ video has NO gap >120s (`findVttGaps` = 0 entries), OR every remaining gap is recorded in `metadata.transcriptionGaps` (honest flag, only acceptable for genuine silence — spot-check one by listening/scrubbing the video at that timestamp).
2. **Script metric:** 0 dictionary hits in the final VTT AND in `metadata.aiSummary` JSON (the guard leaves nothing for itself to fix downstream).
3. **Speaker metric:** VTT contains `<v ...>` labels; the same label set is used across the whole file (no per-chunk drift into different generic numbering when names were found in chunk 0); share page transcript panel shows the labels.

- [ ] **Step 1: Pre-deploy check** — confirm no transcription/AI job is currently running live (dashboard: no video in PROCESSING; or DB: `SELECT id FROM videos WHERE transcriptionStatus='PROCESSING' OR JSON_EXTRACT(metadata,'$.aiGenerationStatus')='PROCESSING';`). **Do not push while a job runs.**

- [ ] **Step 2: Push**

```bash
git push origin qa-fixes
```

Poll deploy: `railway deployment list` until SUCCESS.

- [ ] **Step 3: Re-transcribe the longest real video** (owner named no specific video — pick the longest, ideally ≥2h: `SELECT id, ownerId, duration FROM videos ORDER BY duration DESC LIMIT 5;`). Method (proven 2026-07-02): `UPDATE videos SET transcriptionStatus=NULL WHERE id='<id>';` then admin-session `POST /api/videos/<id>/generate` body `{"reprocess":true}` — runs the full transcribe pipeline (~10-20min for 2h; retries + gap-fill add time). **Do not deploy while this runs.**

- [ ] **Step 4: Measure.** Download the VTT from R2 (env from `railway variables --json`: `CAP_AWS_*`, bucket `ustoz-videos`, key `<ownerId>/<videoId>/transcription.vtt`) and the video row metadata. Run this measurement script (save as `scratchpad/measure-pipeline.mjs`, run with `node scratchpad/measure-pipeline.mjs <vtt-file> <metadata-json-file> <durationSec>`):

```js
import { readFileSync } from "node:fs";

const [vttPath, metaPath, durationArg] = process.argv.slice(2);
const vtt = readFileSync(vttPath, "utf8");
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
const duration = Number(durationArg);

// 1) gaps
const starts = [];
for (const line of vtt.split(/\r?\n/)) {
	const i = line.indexOf("-->");
	if (i === -1) continue;
	const m = line.slice(0, i).match(/(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/);
	if (!m) continue;
	starts.push((m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000);
}
starts.sort((a, b) => a - b);
const gaps = [];
if (starts.length === 0) gaps.push([0, duration]);
else {
	if (starts[0] > 120) gaps.push([0, starts[0]]);
	for (let i = 1; i < starts.length; i++)
		if (starts[i] - starts[i - 1] > 120) gaps.push([starts[i - 1], starts[i]]);
	if (duration - starts[starts.length - 1] > 120)
		gaps.push([starts[starts.length - 1], duration]);
}

// 2) romanized-Russian hits (mirror of the app dictionary's most frequent keys)
const dictWords = ["lyuboy","srazu","vapshe","voobshe","konechno","prosto","znachit","koroche","eto","esli","mozhet","mojno","nuzhno","nado","budet","bylo","horosho","xarasho","normalno","ponyatno","tolko","ochen","potom","segodnya","hvatit","xvatit","posmotrim","sovsem","pravilno","vazhno","poluchilos"];
const summaryText = JSON.stringify(meta.aiSummary ?? {});
const hits = (text) =>
	dictWords.flatMap((w) => {
		const m = text.match(new RegExp(`\\b${w}\\b`, "gi"));
		return m ? [[w, m.length]] : [];
	});

// 3) speakers
const labels = [...new Set([...vtt.matchAll(/<v\s+([^>]+)>/gi)].map((m) => m[1].trim()))];

console.log("cues:", starts.length);
console.log("gaps >120s:", JSON.stringify(gaps.map(([a, b]) => [Math.round(a), Math.round(b)])));
console.log("metadata.transcriptionGaps:", JSON.stringify(meta.transcriptionGaps ?? null));
console.log("romanized hits in VTT:", JSON.stringify(hits(vtt)));
console.log("romanized hits in aiSummary:", JSON.stringify(hits(summaryText)));
console.log("speaker labels:", JSON.stringify(labels));
```

Expected: `gaps >120s: []` (or every gap mirrored in `metadata.transcriptionGaps` and spot-checked as silence) · both romanized-hit lists `[]` · labels non-empty and consistent.

- [ ] **Step 5: Live UI walk** (per NON-NEGOTIABLE #2): open the share page of the re-transcribed video — first transcript pill near 00:00, no frozen caption, speaker labels/avatars visible in the Matn tab, Refined/Summary populated, light+dark+mobile, 0 console errors.

- [ ] **Step 6: If a metric fails** — iterate (autoresearch): diagnose from Railway logs (`[transcribe] gap-fill ...` lines say exactly which spans failed), fix, re-gate, re-deploy, re-measure. Do not report done until the metrics pass.

- [ ] **Step 7: Update `docs/STATE.md`** with the results (measured numbers, video id, commit hash) and tell the owner in short Uzbek.

---

## Self-Review Notes (already applied)

- **Spec coverage:** gap class → Tasks 1-4; script class → Tasks 5-6; speakers → Task 7; verification → Tasks 8-10. Owner's three asks all mapped.
- **Type consistency:** `VttGap` produced in Task 1, consumed in Tasks 3/10; `knownSpeakers` threading is `string[]` with `= []` defaults end-to-end; `parseJsonWithRetry` returns the same usage shape `callAiApi` produces.
- **Known deliberate scope cuts:** no UI for `transcriptionGaps` (metadata only — follow-up if owner wants a banner); `generateSingleChunk`'s `parseAiResponse` keeps its existing single-attempt fallback (short videos, low risk); no post-merge speaker-label case normalization (YAGNI — prompt now pins spelling; revisit only if drift shows up in live measurement).
- **Cost note:** gap-fill costs extra Gemini calls ONLY when gaps exist (healthy videos: zero extra); JSON retry only on parse failure; roster carry adds no calls (serializes chunk 0, ~1-3 min wall-clock on a 2h video).
