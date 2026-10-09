# Is the free (Scribe-less) transcript timing at its ceiling? — independent review

Commissioned 2026-07-20 from a model that wrote none of this code, after the
owner asked exactly that question. Saved to disk because it is expensive to
reproduce (~90k tokens) and the conclusions decide what gets built next.

**Headline: NO, not the ceiling — but the remaining free headroom is ~2×, not ~10×.**

---

## 1. Today's fix did not break the July wall; it hit it from the other side

| method | when | mean drift |
|---|---|---|
| pause-reinsertion retime (global silence redistribution) | 2026-07-08, 2h video | ~10.8s |
| per-chunk linear cue rescale (`rescaleChunkVtt`) | 2026-07-20, 53-min video | 10.2s (max 28.6s) |

Two unrelated methods landing on ~10–11s is the signature of a **shared floor**.

What the rescale really bought: the *systematic* component. Mean signed drift
−49.5s → −2.7s. What it cannot buy: the *nonlinear* remainder. Inside one chunk
the measured drift runs −34, −79, −114, −120s at 100/100/50s spacing — roughly
linear, not exactly. The residual of the best single straight-line fit across a
360s chunk is ~5–10s, which is precisely the mean_abs left over. **One factor per
6-minute chunk can remove the average slope of a wrong clock, never its curvature.**

The anchor work (last non-stray cue, 3× median-gap rule) is judged sound for the
data — it targets the **max**, not the mean. Note `13dfa48` is still unmeasured
end-to-end (quota outage).

> The architecture — one linear stretch per 6-minute chunk — is now the binding
> constraint, not the anchor.

## 2. Untried options, ranked by gain per unit of work

**(a) 3-minute chunks + the existing rescale — do this FIRST.**
`LONG_AUDIO_CHUNK_DURATION_SEC` (workflows/transcribe.ts:113) 360 → 180. The
nonlinearity accumulates with span, so halving the span plausibly takes **mean
10 → 5–7s and max 28 → ~12–15s — i.e. it plausibly MEETS the ≤15s target.**
Audio-seconds billed are unchanged; only per-call prompt overhead doubles
(~+10–20%; a 53-min re-transcription costs roughly $0.2). Work: 1–2h including
the measurement. The code comment claiming shorter chunks only "cap" the error is
half-right: the two **compose** — rescale removes the slope, shorter chunks cap
the leftover curvature. Watch: more chunks = more failure surface + more
speaker-roster handoffs.

**(b) Grid-probe piecewise warp — the real ceiling-breaker, still nearly free.**
Turn the measuring rig into a correcting one: ~1 probe per 60–90s (35–50 clips
for 53 min ≈ 12–16 min of audio ≈ **$0.05–0.10 per hour**), LIS-monotonic outlier
filtering (already written in the 07-08 `transfer.mjs`), then piecewise-linear
warp between anchors. Each anchor is good to ±3–5s; interpolating between anchors
~90s apart should reach **~3–5s mean — Scribe-adjacent, at ~1/3 the price, no new
vendor, no new key.** Work: ~1 day, mostly reusing `grid-localize.mjs` +
`transfer.mjs` from the July harness.

**(c) ffmpeg silencedetect as interior anchors — dead end, already refuted.**
2h of audio had 2175 real silences; the Gemini transcript exposed only 20 gaps
≥1s. Interior anchoring needs a transcript-side event to match against, and those
events do not exist — which is exactly why pause-reinsertion capped at ~11s.
Silence is already used where it can be trusted: chunk boundaries via
`speechEndSec` (lib/audio-extract.ts:166-226).

**(d) Word-level timestamps from Gemini — low value.** Finer granularity of the
same ~0.64× clock is still wrong. One 6-min experiment (~$0.02) to confirm, not a
workstream.

**(e) MMS forced-align — the true $0 endgame, expensive to build.** Uzbek
acoustic model exists, ~0.1s accuracy, needs a Python sidecar + ~1GB model + text
normalization; 1–2 days. Only if (b) proves insufficient.

## 3. ⚠️ The INSTRUMENT is now a limiting factor — "10s" vs "5s" is barely distinguishable

Three quantified error sources in `scripts/measure-transcript-drift.mjs`:

- **Cue-start quantization** — `bestMatch` returns the first cue's start of the
  best window (line 99). With ~4.5s median cue duration that is **±2–5s even
  against a perfect transcript**.
- **Weak matches** — threshold is score ≥0.25 (line 190). A 0.33-score match can
  be off by one or two cues → ~10s of single-sample error. Today's samples ranged
  0.33–0.98, so **the "max 28.6s" rests on individual samples of unverified match
  quality — it is the least trustworthy number in the report.**
- **Sampling error** — with per-sample scatter σ≈8s, the standard error of a
  12-sample mean is ~2.3s. So 10.2 vs 5 is ~2 SE apart (marginal); **10 vs 7 is
  not distinguishable at all.**

**The 30-minute fix that settles it:** run the rig against the bbzt
Scribe-aligned VTT, whose true error is independently known to be ~1–2s.
Whatever mean_abs it reports there (expect 3–5s) **is** the instrument's noise
floor, measured rather than assumed. Until that number exists, no claim below
~8s means anything. Also cheap: raise the match threshold to 0.5 and use ~30
samples for any before/after comparison.

## 4. The order of work

1. **(~0.5h, ~$0.05)** Calibrate the instrument against the bbzt Scribe VTT.
   Nothing below is provable without it.
2. **(~1–2h, ~$0.2)** Measure the already-deployed `13dfa48` (one re-transcription
   of `fm3pz7yref328m7` on a fresh quota day) and in the SAME run flip chunks to
   3 minutes. Expected mean ~5–7s, max ~12–15s → **≤15s target plausibly met for
   ~$0.40 total.**
3. **(~1 day, $0.05–0.10/hr)** Only if ≤5s is wanted: grid-probe piecewise warp.
   Expected ~3–5s mean.
4. **Only if that fails:** Scribe at $0.22/hr is the proven 1–2s answer; MMS
   forced-align the proven-concept $0 answer at 1–2 days of infra.

## The caveat the owner should hear

For the fast multi-speaker **card** UI, the 07-08 analysis showed that even **3s**
of drift misses a 4s card **38%** of the time. So if the requirement ever returns
to "the highlighted card is always the right one", **no transcript-side free
method reaches it** — only step 3 or Scribe does.

---

Key files: `apps/web/lib/gemini-transcribe.ts` (rescale + anchor) ·
`apps/web/workflows/transcribe.ts` (6-min chunking at line 113, rescale call at
1040) · `apps/web/lib/audio-extract.ts` (silence-anchored cuts) ·
`scripts/measure-transcript-drift.mjs` (the instrument) · `docs/STATE.md` lines
~45–65 (today) and ~1043–1055 (the July investigation).
