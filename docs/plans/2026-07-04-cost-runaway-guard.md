# Plan — Transcription cost runaway guard (2026-07-04)

## Why (measured, real)
Video `9w7xac4wvgj6em5` (53 min) cost **$0.63 (~8000 so'm)** — an OUTLIER.
A comparable 53-min video (`151qnwcyxkarpdk`) cost only **$0.07 (~890 so'm)**.
Measured from `ai_usage_events` (proxy `thomas.proxy.rlwy.net:26774`, repo `mysql2`):

- 8 transcription calls in ONE run (12:59–13:05) — pipeline chunking + gap-fill, NOT my re-tests.
- One call at 13:04:14 emitted **out=65537 tokens** = it hit the MAX output cap → the model
  went into a **repetition/runaway loop**, produced garbage, and cost **$0.19 (~2400 so'm)** alone.
- Model was `gemini-2.5-flash` (this video predates the 3-flash switch).

So: typical 50-min ≈ 900–1500 so'm (cheap). The 8000 so'm was a runaway glitch, not the norm.

## Scope
Transcription cost per video — cap the blast radius of a runaway/repetition chunk and
stop paying repeatedly for garbage output.

## Metric (verifiable)
- Runaway events (a chunk whose output ≥ ~90% of its max-output cap) → **0** reach billing uncaught.
- A real ~50-min video re-transcribed end-to-end on `gemini-3-flash-preview` → **≤ ~$0.15 (~1900 so'm)**.
- No regression: transcript coverage % and speaker labels unchanged vs a clean baseline.

## Direction (iterate → verify → keep/discard)
1. **Lower per-chunk `maxOutputTokens`** to a sane bound. A ~15-min chunk transcript cannot
   legitimately exceed a few thousand tokens; the current cap (~65k) lets a loop run for a long
   time before stopping. Set a tight cap (measure a normal chunk's output first; e.g. ~12–16k).
   File: `apps/web/lib/gemini-transcribe.ts` (`generationConfig.maxOutputTokens`).
2. **Runaway detection + guard:** if a chunk returns output at/near the cap (repetition signature —
   e.g. long runs of a repeated line, or `finishReason === "MAX_TOKENS"`), DISCARD that output,
   retry ONCE at a lower temperature / lower cap; if still runaway, mark the span as a gap
   (`transcriptionGaps`) instead of accepting garbage. Never re-charge for the same garbage in a loop.
3. **Verify 3-flash is less prone:** re-transcribe one real long video on `gemini-3-flash-preview`
   (method: DB `transcriptionStatus=NULL` → admin `POST /api/videos/:id/generate {reprocess:true}`;
   ⚠️ do NOT deploy while the job runs) and measure cost + runaway count. If 3-flash alone already
   holds ≤ metric, the guard is a cheap belt-and-suspenders; keep it anyway.
4. **(optional) Gap-fill cost cap:** `MAX_GAP_FILL_SPANS=12` already bounds it; log how many spans
   fired per video so a future video that needs many gap-fills is visible, not silent.

## Files
- `apps/web/lib/gemini-transcribe.ts` — maxOutputTokens, runaway detection on the transcription call.
- `apps/web/workflows/transcribe.ts` — retry/gap-fill orchestration + per-run cost logging.
- Cost measurement helper: query `ai_usage_events` via the proxy (recipe in the memory
  `feedback_search_when_stuck` — swap internal host → `thomas.proxy.rlwy.net:26774`, use `mysql2`).

## Gate
tsc 0 · relevant vitest green · a real long-video re-transcribe on 3-flash hitting the Metric.
Independent (Codex) review of the guard before commit (billing/pipeline = correctness-critical).
