# Ready to apply: 6-minute chunks → 3 minutes

Not applied yet, on purpose: a parallel session is editing
`apps/web/workflows/transcribe.ts` in the same checkout right now, and an edit
made here was silently overwritten within a minute. Apply this once that work is
committed.

## The change

`apps/web/workflows/transcribe.ts` (~line 115):

```diff
-const LONG_AUDIO_CHUNK_DURATION_SEC = 6 * 60;
-const LONG_AUDIO_CHUNK_THRESHOLD_SEC = 8 * 60;
+const LONG_AUDIO_CHUNK_DURATION_SEC = 3 * 60;
+const LONG_AUDIO_CHUNK_THRESHOLD_SEC = 4 * 60;
```

Nothing else. `computeSilenceAnchoredCuts` already scales with the target
(`WINDOW = targetChunkSec * 0.4`, `MIN_CHUNK = 60`), so 180s needs no other
tuning.

## Why

The per-chunk cue rescale (shipped 2026-07-20) removes the **average slope** of
Gemini's wrong clock but not its **curvature**, and the leftover curvature is
what the residual drift is made of. Measured on a 53-minute meeting: mean
|drift| stalled at **~10s** with 6-minute chunks *after* the rescale — the same
floor a completely different free method reached in July (~11s). **Two unrelated
methods hitting the same number is the signature of the SPAN being the
constraint, not the correction.** Halving the span halves the room the curvature
has to accumulate; the two compose (rescale removes the slope, the shorter chunk
caps what remains).

Expected: **mean ~5-7s, max ~12-15s** — i.e. it plausibly meets the ≤15s target
that 6-minute chunks could not.

## What it costs

- Twice as many Gemini calls for the same audio seconds (~+10-20% in repeated
  prompt overhead — audio seconds, the expensive part, are unchanged).
- Twice as many speaker-roster handoffs between chunks.
- Twice the failure surface per recording (more calls = more chances one 429s).

## How to know it worked, and when to revert

Re-transcribe `fm3pz7yref328m7` (53 min) and run:

```
node /tmp/measure-transcript-drift.mjs fm3pz7yref328m7 12 20
```

Baseline to beat, same video, same rig, 6-minute chunks: **max 28.6s, mean 10.2s**.

**If the re-measure shows no real improvement, REVERT to `6 * 60`** rather than
leaving a change that only buys extra API calls. And read the instrument caveat
in `docs/plans/2026-07-20-free-timing-ceiling-review.md` first: the rig's own
noise is ±2-5s, so "10 vs 7" is not a distinguishable result — only a move to
~5-7s with max under ~15s counts as proof.
