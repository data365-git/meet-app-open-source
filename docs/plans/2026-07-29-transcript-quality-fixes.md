# Transcript quality fixes — fabrication detector · markdown strip · per-chunk progress

**Status: PLAN, not built. Written 2026-07-29 evening from live-prod evidence; goes through
plan-review before any code.**

Owner-reported, all three confirmed against prod data the same evening:

## 1. Degeneration (fabrication) detector — the important one

**Evidence:** the owner's 2:47 test video (`9btpw8ce39f88a4`) produced a VTT that is 2–3 real
sentences followed by the same lines looped 6+ times, timestamps marching on. Classic Gemini
repetition degeneration on short/sparse audio. The summary was then built on that garbage —
"videoda gapirilmagan gaplarimni to'qib chiqarib qo'yibdi". The three real meetings the team
recorded the same day are CLEAN: dup-ratio 1–5%, `maxConsecRepeat=1`, top repeats are natural
backchannel ("Xo'p", "Mhm", "Aha"). So the failure is confined to short/quiet recordings — but
those are exactly what a new team member records first, and one fabricated transcript teaches
the team to distrust all of them ([[feedback_no_false_alarms]] applies to OUTPUT quality too).

**Side effect proven by the cost rows:** the loop inflated output tokens — that video's first
transcription call cost 77,018 micros vs 6,489 for its second; fixing degeneration also removes
the ~10× cost spike on affected videos.

**Fix shape (post-transcription, per chunk result — NOT a prompt-only hope):**
- Compute the same two numbers the clean/dirty split was verified with: unique-cue ratio and
  max-consecutive-repeat over normalized cue texts.
- Thresholds from tonight's measurements: clean meetings sit at dup ≤5% / maxRun 1; the broken
  one is dup ≫30% with runs ≥3. Flag when dup-ratio >20% OR maxConsecRepeat ≥3 (tune against
  both datasets before shipping).
- On flag: retry that chunk ONCE (temperature already 0 → retry with tightened prompt
  "transcribe only actually spoken words; leave silence gaps empty"); if still degenerate,
  COLLAPSE the repeated cues (keep first occurrence, drop the loop tail) and mark the video's
  transcript `quality: "degraded"` — surfaced honestly in the UI ("Transkript qisman —
  yozuvning katta qismi jim") instead of a confident fake.
- Summary generation reads the flag: degraded transcript → summary prompt told the transcript
  may be partial; or skip auto-summary and show "transkript sifatsiz, xulosa qilinmadi".
- **Metric (RED→GREEN):** feeding the stored looped VTT through the detector flags it; feeding
  the three clean meeting VTTs does not. Unit tests with those real texts as fixtures.

## 2. Markdown leak into cue text

The broken VTT contains `**shrift**`-style bold inside cue text (renders as literal asterisks
in the player). Strip markdown emphasis markers when parsing Gemini output into cues.
One function + test; bundle with fix 1.

## 3. Per-chunk progress ("konkret nima qilyapti?") — owner asked twice

Today the share page shows only PROCESSING while a 2-hour video runs 10–15+ chunks. Wanted:
"Transkript: 15 bo'lakdan 2-chisi Geminida" at a glance.

- The transcribe workflow already iterates chunks (`AI_CHUNK_CONCURRENCY = 3`); write
  `{phase, chunksTotal, chunksDone}` to the video row (or a small progress JSON column) as each
  chunk settles.
- Share page + dashboard read it (poll or existing refresh) and render the concrete line.
- Blast radius: the durable-step workflow must not double-write on retries (progress writes are
  idempotent counters computed from settled chunk indexes, not increments).
- **Metric:** during a live transcription, the UI shows N/M advancing; on completion the display
  clears; a retried chunk does not double-count.

## Deliberately NOT in this change

- No prompt-only "please don't hallucinate" fix presented as the solution (unverifiable).
- No participant-counting heuristics (Meet's own badge showed "2" while the owner was alone).
- No free-tier/model routing changes (separate cost stream — free path currently unused, real
  lever, needs its own measured pass).
- No timestamp work — that runs on its own ladder (see STATE, goal = Gemini-only maximum).

## Order

Fix 1+2 first (one PR, RED→GREEN on real fixtures) → review → deploy → owner re-records a short
test video and sees either a clean transcript or an honest "degraded" label. Fix 3 second PR.
