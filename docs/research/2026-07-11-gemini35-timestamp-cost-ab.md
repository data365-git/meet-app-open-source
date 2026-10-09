# Gemini 3.5 Flash timestamp + cost A/B (Phase A)

Date: 2026-07-11
Spec: `docs/plans/2026-07-11-ai-routing-batch-timestamp-cost-spec.md` §3
Status: **MEASUREMENT PENDING — blocked locally** (see "Blocker"). Harness is
ready; run it on the free key with three short clips to fill in the numbers.

## Question

Can the now-stable `gemini-3.5-flash` reach the existing ~1–2 s timing quality
**without** a separate ElevenLabs Scribe call, and would a future
3.5-Batch/no-Scribe route be cheaper than the current 3-Flash-Batch + Scribe?

This is a research spike only. Per spec §3, **production routing is NOT changed
to a no-Scribe model in this delivery** regardless of the result.

## Method

Reproducible harness: `apps/web/scripts/timestamp-ab/gemini35-timestamp-bench.mjs`.

- FREE project/key only (`GEMINI_API_KEY_FREE`); never spends paid tokens, never
  creates a project, never touches Vertex.
- ≤ 10 minutes of audio total — three representative clips (early / middle /
  late) with their absolute `--offset` in the source so cue times line up with
  the reference. **Does not** re-transcribe the full 2 h `bbzt2424z6vvy6t`.
- Two request variants through `gemini-3.5-flash`:
  1. the production WebVTT prompt + normalizer;
  2. structured segment JSON (`speaker,start,end,text`).
- Reference: `apps/web/scripts/scribe-poc/fixed-eleven-v2.vtt` (the Scribe-aligned
  VTT). **Not** an independent human ground truth — it is the current best
  practical reference; where possible cross-check with the existing
  high-confidence grid probes (`scribe-poc/grid-localize.mjs`).
- Metrics per variant: high-confidence anchor count; mean / median / p95 / max
  absolute timestamp error; monotonic + in-bounds cue count; number- and
  important-term retention vs the current Gemini transcript; Uzbek-Latin /
  Russian-Cyrillic preservation spot-check; input / audio / output tokens;
  wall-clock latency; and pass/fail on the gates below.

### Timestamp acceptance gates (for even considering a no-Scribe route)

- mean absolute error ≤ 2.0 s
- p95 absolute error ≤ 5.0 s
- no non-monotonic / out-of-bounds cues
- number + important-term retention not lower than the current Gemini transcript
- no measurable Cyrillic regression

## Cost comparison

Official Batch rates used (spec §3):

| Model | audio-in $/M | text-in $/M | output $/M |
|---|---|---|---|
| `gemini-3-flash-preview` (Batch) | 0.50 | 0.25 | 1.50 |
| `gemini-3.5-flash` (Batch) | 0.75 (input) | 0.75 (input) | 4.50 |
| ElevenLabs Scribe | — | — | $0.22 / audio-hour |

The exact token counts come from the (pending) benchmark. Worked example with
**documented placeholder assumptions** for 1 audio-hour — audio-in ≈ 32 tok/s ×
3600 = 115,200; prompt text-in ≈ 10,000; transcription output ≈ 12,000:

- **Route A — 3-Flash Batch + Scribe:**
  audio 115,200 × 0.50/M = $0.0576 · text 10,000 × 0.25/M = $0.0025 ·
  output 12,000 × 1.50/M = $0.0180 → Gemini ≈ **$0.078** + Scribe **$0.220**
  = **≈ $0.298 / hour**.
- **Route B — 3.5-Flash Batch, no Scribe:**
  input (115,200 + 10,000) × 0.75/M = $0.0939 · output 12,000 × 4.50/M = $0.0540
  → **≈ $0.148 / hour**.

**Break-even:** B beats A whenever Scribe's $0.22/hr exceeds the extra Gemini
cost of 3.5 over 3-Flash (≈ $0.148 − $0.078 = **$0.070/hr** under these
assumptions). Since $0.22 ≫ $0.07, **Route B is materially cheaper (~½) IF and
ONLY IF the timestamp gates pass** — Scribe's flat per-hour fee dominates. So the
whole decision hinges on the pending timing measurement, not on price.

> Replace the placeholder tokens with the benchmark's measured `tokens` block and
> re-check the break-even before recommending anything to the owner.

## Blocker (why numbers are pending)

Running the live experiment needs two things not available in this local
environment, and neither may be faked:

1. **`GEMINI_API_KEY_FREE`** — the free Gemini project/key. Only the paid
   `GEMINI_API_KEY` exists locally, and spec §3 forbids spending paid tokens on
   this spike. → owner action: expose the free key locally (or run the harness
   where it is set).
2. **The audio clips.** No local audio exists; the source lives in R2. → owner
   action: provide ≤ 10 min of clips (early/middle/late) with their absolute
   offsets, or run the harness where R2 + the free key are available.

Once both exist:

```
GEMINI_API_KEY_FREE=... node apps/web/scripts/timestamp-ab/gemini35-timestamp-bench.mjs \
  --clip early.mp3  --offset 0 \
  --clip mid.mp3    --offset 3000 \
  --clip late.mp3   --offset 6600 \
  --ref apps/web/scripts/scribe-poc/fixed-eleven-v2.vtt \
  --out docs/research/2026-07-11-gemini35-timestamp-cost-ab.data.json
```

Then paste the two `variants` blocks into a **Results** section here and mark
each gate pass/fail.

## Provisional conclusion

- If 3.5-flash **passes** the timing gates → a no-Scribe Route B is ~½ the cost;
  worth a follow-up spec to switch the paid Batch model + drop Scribe for long
  videos. **Not** done here.
- If it **fails** (the far likelier outcome given prior Whisper/free-retimer
  results — Gemini estimates rather than force-aligns timestamps): keep Scribe
  for long videos, do **not** ship a weaker free retimer. Phases B–E stand on
  their own regardless.
