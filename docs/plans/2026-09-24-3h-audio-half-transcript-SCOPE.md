# SCOPE 2026-09-24 — 3-hour audios transcribe only ~the first third, then lie "COMPLETE"

## SCOPE (what is broken, reproducible from prod evidence)

Team uploads ~3-hour lesson audios (`dars1..7`, 2026-09-23). Expected: full transcript.
Observed on prod (container `data365-web:2c9dd6b`, DB `capdb`):

- `060m9ty4kqqspxp` (dars3, 204 min, transcriptionStatus **COMPLETE**):
  `transcriptionGaps = [{1829–2160}, {3210–3602}, {4315–12265}]` → covered only
  **0–~72 min of 204** (~35%). `aiStageChunksTotal/Done = 6/6`, `aiGenerationStatus COMPLETE`, step `done`.
- `etb3g4gw6c4bv4w` (darsli-2, 209 min, **COMPLETE**): gaps `{3229–3954}, {4308–12538}` → same shape, covered ~72 min.
- Container logs for both: dozens of `free-tier (gemini-3.5-flash / gemini-3-flash-preview)
  attempt failed ... HTTP 429 exceeded your current quota`, then
  `[generate-ai] all free-tier models failed ..., falling back to paid` — repeated per chunk.
  BUT `ai_usage_events` shows **zero paid transcription calls** (paid = summary only,
  `openrouter/google/gemini-3.7-flash`). Transcription used only 11 and 10 free calls.
- User then **soft-deleted both** (11:35) — re-upload behaviour hides the failure.
- Same day: `dars5` ERROR (`Video ... was deleted` mid-run), `dars6`/`dars7` transcriptionStatus NULL,
  metadata `{"isAudio": true}` only — the known never-started defect, still live.
- Baseline contrast: `tac11epy6pawmcf` (09-08, 123 min) has 78 `transcript_chunks` rows, 99.7% covered —
  the OLD pipeline wrote chunk rows; post-09-10 runs store text elsewhere (transcript_chunks empty).

So the user-visible bug "3 soatlik audio yarmi qilinyapti" = quota exhaustion mid-run +
a fallback that does not transcribe + completion marked despite gaps.

## METRIC (script-computed, prod SQL)

For every video with `duration >= 5400s` created after the fix deploy:

```
coveragePct = 100 * (1 - Σ(gap.endSec - gap.startSec) / duration)   [from metadata.transcriptionGaps]
honesty     = (transcriptionStatus = 'COMPLETE') ⇒ coveragePct >= 95
```

Fixed = on a fresh real ≥3h audio after deploy: `coveragePct >= 95` AND no
`COMPLETE` row with coverage < 95 anywhere in the table (existing bad rows repaired or re-run).

## DIRECTION (one change → measure → keep/discard)

1. Make the run HONEST first: never mark COMPLETE with uncovered gaps > tolerance —
   either keep retrying (quota wait) or surface ERROR/partial state to the user.
2. Make the paid fallback actually transcribe the gaps (or make quota-wait wait for the
   next window if owner prefers free), so coverage reaches ~100%.
3. Re-run the broken 3h audios (dars3/etb are soft-deleted; dars5/6/7 need the
   never-started fix or manual re-kick).

Each step lands separately, measured by the METRIC above; discard any step that does not move it.
