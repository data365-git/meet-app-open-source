# Codex prompt — Gemini-only timestamp accuracy: what is left after 3 measured attempts?

Copy everything below into Codex CLI (run it from `D:\vibecoding\ustoz-github`).

---

You are auditing a transcription timestamp problem in this repo. Be adversarial and concrete. Do not repeat things already tried — the whole point is to find what we MISSED.

## The goal (owner's hard constraint)

Smallest possible drift between a transcript cue's timestamp and where the words actually are in the audio, using **Gemini alone** — no ElevenLabs, no other ASR vendor. All video lengths (2 min to 2 h), mixed Uzbek/Russian meeting speech.

## What the pipeline does today

- ffmpeg splits audio at silence boundaries into 3-minute chunks (`apps/web/workflows/transcribe.ts`).
- Each chunk goes to Gemini (`gemini-3.5-flash` free → `gemini-3-flash-preview` free → paid) asking for WebVTT with cue ranges.
- Each chunk's cues are then linearly rescaled to the chunk's real speech span (`rescaleChunkVtt` in `apps/web/lib/gemini-transcribe.ts`), because Gemini's internal clock runs at a near-constant fraction of real time within a chunk.
- Chunks are merged at absolute offsets; gaps are re-filled by a second pass.

## Measured results (real 25-min Uzbek meeting, 8 probe positions, rig noise ~±5s)

| attempt | median abs drift | max abs drift | verdict |
|---|---|---|---|
| 6-min chunks (before) | 8.7 s | 29.6 s | baseline |
| **3-min chunks (now live)** | **6.2 s** | **11.0 s** | KEPT |
| probe-anchored piecewise warp | 8.1 s | 11.9 s | **DISCARDED — worse** |

## What was already tried and FALSIFIED (do not propose these again)

1. **`audioTimestamp` generationConfig flag** — returns `400 Unknown name "audioTimestamp"` on the Gemini **Developer API** (generativelanguage.googleapis.com). It is Vertex-AI-only. Verified live with a control call.
2. **Probe-anchored warp (known-text localization)** — implemented exactly as designed: pick 8 high-information unique cues, cut a ±25 s audio window around each cue's claimed time, ask a pinned Gemini model where that exact passage begins, accept anchors (drop |shift|>45 s, drop non-monotone, need ≥3), warp the VTT with a monotone piecewise-linear map, constant offset outside the anchor range. Result: 8/8 anchors accepted, 5.4 s median shift applied, **drift got worse** (6.2 → 8.1 s median) plus a new ~−4 s systematic bias. Conclusion: Gemini localizing its own transcript is self-consistent, not ground truth. Code kept at `apps/web/lib/vtt-probe-warp.ts` (unwired) with 10 unit tests.
3. **warp4 / pause-reinsertion retime** (`docs/plans/recovered-retime-prototype/`) — July prototype, reached ~10.8 s alone. Demoted because it computes "missing time" from an already-rescaled span, so composing it after today's linear rescale mostly sees noise.
4. **ElevenLabs Scribe** — works (~3 s) but is explicitly out of scope by owner constraint.

## The measurement rig (and its known weakness)

Cut a 12 s audio window at a known wall-clock time → transcribe it alone with Gemini → find the best token-overlap match among the VTT cues → drift = matched cue start − window start. 8 probes per video. Per-probe noise ±5 s; standard error of the mean ~2.5 s. **Weakness: Gemini judging Gemini, and cue-start quantization.** Rule in force: keep a change only if the gain exceeds 2× the standard error.

## Your task — answer these, ranked, with concrete file/line-level proposals where relevant

1. Is there a **Gemini-only** technique we have not tried that could plausibly beat 6.2 s median / 11.0 s max? Judge each idea against the failure we already measured in #2 above (self-consistency ≠ ground truth). Say plainly if you believe there is none.
2. Is our **linear per-chunk rescale** the right correction shape at 3-minute spans, or is there a better closed-form correction derivable from data we already have locally (ffmpeg silence intervals, chunk speech-end anchors, cue density)? Note this must be **free** — no extra model calls.
3. Could **chunking differently** (2-min? overlapping chunks with cross-matching? silence-boundary-only cuts?) beat 3-minute chunks, and what would it cost in extra API calls and boundary artifacts?
4. **Critique the measurement rig.** If you think our numbers cannot distinguish 6 s from 4 s, say so and specify the cheapest rig upgrade that could — including exactly how many human-marked onsets would be needed and how they should be collected.
5. If your honest verdict is "6.2 s median is the practical Gemini-only floor on the Developer API", say that explicitly and state what evidence would be needed to publish that as a proven floor rather than an untested belief.

Answer in compact English markdown. Read the actual files before claiming anything about them. Do not change code — this is an audit.
