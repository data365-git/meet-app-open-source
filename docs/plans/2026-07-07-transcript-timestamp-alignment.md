# Transcript ↔ audio timestamp alignment (drift fix)

Owner complaint (2026-07-07): on a 2-hour Uzbek meeting audio, the transcript
runs **ahead** of the spoken audio ("ancha oldinda"). Verified by measuring the
real VTT from R2, not guessed.

## Root cause (measured, confirmed)
- The display code, VTT data shape, and chunk offsets are all correct.
- **Gemini estimates timestamps — it does not force-align them.** This is a
  documented, unfixed Gemini bug ("progressive timestamp drift in audio
  transcription", Google AI dev forum). Within each transcription chunk the cues
  drift progressively ahead of the audio, then re-anchor at the next chunk's
  absolute start offset.
- Secondary: Gemini ignores leading silence inside a chunk, so a chunk that
  begins mid-silence has its cues shifted early. (On this audio the leading quiet
  is only ~1–2s — smaller than the owner's ~10s estimate — so this is a minor
  contributor; the progressive within-chunk drift dominates.)

## Stage 1 — Gemini-side mitigation (DONE, deployed)
The documented best-practice workaround for Gemini drift = silence-based
segmentation. Two commits on `qa-fixes`:
1. `LONG_AUDIO_CHUNK_DURATION_SEC` 15min → 6min + threshold 30min → 8min — bounds
   progressive drift to a shorter span (drift resets ~2.5× more often). Cost flat
   (audio sent once, non-overlapping chunks; only per-call prompt repeats).
2. **Silence-anchored chunking** (`audio-extract.ts`): an ffmpeg `silencedetect`
   pass finds speech onsets; chunk boundaries are cut at those onsets near each
   6-min target, using the REAL cut time as `startSec` and skipping leading
   silence. Each chunk then begins right at speech, so Gemini's 0:00 lines up with
   the true time. Pure boundary logic unit-tested; falls back to fixed-interval
   when silencedetect fails. Zero extra AI calls.

**Cost/latency note (measured):** the free-tier key (gemini-3.5-flash) rate-limits
past ~4 calls; the remaining ~20 chunks auto-fall-back to paid gemini-3-flash-preview.
A full 2h re-transcribe runs in ~7–10 min. So chunk COUNT does not raise $ (audio
tokens fixed), only free-tier throughput — the paid fallback absorbs it.

**Verification metric:** best is `cross-correlation lag` — shift the transcript's
cue-active signal against the audio's speech signal; the lag that maximizes
overlap = how many seconds the transcript is shifted (lag>0 = AHEAD). Measured on
the 2h audio (`bbzt2424z6vvy6t`):
- Baseline (6-min, pre-silence-anchor): **+22s ahead** (corr 0.75).
- Silence-anchored re-transcribe: **+12s ahead** (corr 0.74).

So silence-anchoring roughly **halved** the systematic lead (22s → 12s) — a real
improvement — but **~12s of ahead-drift remains**, i.e. NOT "completely gone".
(A weaker `cue-in-silence %` metric was ~flat 18.1%→18.6% because silences are
scattered; the cross-corr lag is the reliable measure.)

**Cost/latency of silence-anchoring:** the full 2h re-transcribe took ~11 min vs
~7.5 min for plain fixed 6-min chunks — the silencedetect full-decode pass + 20
sequential span extractions add local ffmpeg time. Background job, so users don't
wait synchronously, but it is a real slowdown.

**Verdict:** Stage 1 helps (22→12s) but does not fully fix. Owner decides:
(a) accept ~12s, (b) shrink chunks to ~3 min (~6s drift, but ~2× calls + slower),
(c) Stage 2 forced alignment (~0s, big infra).

## Stage 2 — forced alignment (PROPOSAL — owner approval needed; "2-katta ish")
Only pursue if Stage 1's measured result still shows unacceptable drift / the
owner's ear-test still says "ahead". This is the real "completely gone" fix.

**Approach:** keep Gemini for the TEXT (it transcribes Uzbek well), then run a
**forced-alignment** pass that maps that text onto the audio for exact word-level
timestamps, discarding Gemini's estimated ones.

**Uzbek feasibility — YES:** Meta **MMS forced aligner** (`mms-300m-1130-forced-aligner`,
wav2vec2 + CTC) supports 158 languages **including Uzbek** (MMS covers 1000+). A
single multilingual model also covers Russian/English, so mixed-language meetings
work. (WhisperX's default wav2vec2 models do NOT include Uzbek — MMS is the right
pick.) Accuracy: sub-100ms word timestamps.

**Cost / infra (the "big" part):**
- Needs a **Python worker service** (torch + transformers + the ~1GB MMS model),
  separate from the Next app. This is the backlog "worker-servis (D1-A)".
- CPU inference works (no GPU strictly required) but alignment of a 2h audio takes
  minutes of CPU; a small GPU is faster but adds hosting $. Recommend start on CPU
  worker, measure, add GPU only if too slow.
- Integration: transcribe workflow → after Gemini text, POST (audio span + text)
  to the aligner worker → receive aligned timestamps → write the VTT with those.
- Effort: multi-day (service scaffold, model hosting, integration, Uzbek accuracy
  verification, failure/fallback to Gemini timestamps).

**Recommendation:** ship Stage 1, measure + owner ear-test. If good enough → stop
(no Stage 2 = big savings). If not → build Stage 2 CPU worker as its own project.

## Sources
- Gemini progressive drift: https://discuss.ai.google.dev/t/bug-gemini-3-flash-and-3-1-pro-progressive-timestamp-drift-in-audio-transcription/129501
- WhisperX / alignment: https://arxiv.org/html/2303.00747v2
- MMS forced aligner (158 langs incl. Uzbek): https://sourceforge.net/projects/mms-300m-1130-forced-aligner/
