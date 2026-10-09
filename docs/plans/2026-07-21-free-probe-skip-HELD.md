# HELD: free-tier probe "stop after quota exhausted" (2026-07-21)

## What & why
Once the free Gemini key's ~20/day quota is spent, `transcribeAudio`'s fast path
still burns the full `FREE_TRANSCRIBE_PROBE_MS` (30s) on EVERY remaining chunk
before falling back to paid. Fix = remember the quota-exhausted signal for the
run and skip the free probe on later chunks.

## Why it is HELD (not committed)
A Sonnet agent implemented it (patch: `2026-07-21-free-probe-skip-HELD.patch`,
test: `*-test.ts.txt`) by threading a run-scoped `freeProbeState = {exhausted}`
object down into `transcribeAudio` and MUTATING it inside the step's catch block.
`transcribeAudio` is a `"use step"` (durable, `workflow` v4.2 pkg). Durable steps
serialize their inputs; mutating an input object inside a step is not guaranteed
to propagate back to the caller across the step boundary. The unit test passes
(in-process, no serialization) but the real prod effect is UNVERIFIED and the
pattern is fragile. STATE forbids unverifiable changes to the core transcription
pipeline during the current Gemini outage.

## The step-safe redesign (do this when credit returns)
Do not mutate-out across the step. Instead:
- The serial FIRST chunk runs; `transcribeAudio` RETURNS whether it hit a
  quota-like free failure (extend its result, or a sibling step, to carry the
  signal — return values ARE persisted/propagated).
- `transcribeAudioChunks` reads that signal and passes `skipFreeProbe=true` DOWN
  (as a read-only arg — serialized IN is fine) to every concurrent later chunk.
This is robust by construction (no reliance on reference identity) and matches
reality: the first chunk exhausts the quota, the rest skip.

## Verify (needs credit)
Re-transcribe a long video, grep server logs: later chunks must NOT log
`Free probe aborted after 30000ms` — they should go straight to paid with no 30s
wait. Time the run vs baseline.
