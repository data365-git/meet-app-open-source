# Timestamp ladder v2 — after the Codex consultation (2026-07-29 night)

**Owner directive:** reach the smallest drift achievable with Gemini ALONE (no ElevenLabs), all
video lengths; don't stop until the Gemini-only maximum is proven. Consultation ordered by the
owner ("codex bilan maslahatlashib ko'r"); Codex ran read-only over this repo and its July work.
Full transcript: session scratchpad `codex-timestamp-consult` output; the load-bearing findings
are recorded here so they survive.

## What Codex found (each verified or actionable, not taken on faith)

1. **`audioTimestamp` — an untried, documented API lever.** Google's audio docs describe enabling
   audio timestamp understanding; we never set it. Also: on the latest models `temperature` is
   deprecated and `thinkingBudget` moves to `thinkingLevel` — so the experiment must be a
   CONTROLLED compatibility arm (pinned single model, no fallback chain), not a blind flag flip.
2. **Batch/Standard clock-parity bug — VERIFIED IN CODE tonight.** Standard chunks pass through
   `rescaleChunkVtt` (transcribe.ts:1102); Batch-collected chunks are merged RAW
   (`mergeBatchChunkIntoPartial` in lib/batch-merge.ts — offset only, no rescale) and then
   `isChunkCoveredByPartial` skips them on resume, so they NEVER get rescaled. A mixed
   Standard/Batch recording carries two different clocks — this alone can produce the oscillating
   drift the baseline measured. Fix note: the collector lacks the extract-time speech-span the
   Standard anchor uses; persist what the rescale needs at Batch submit, or rescale with the
   job's chunk duration as a bounded approximation.
3. **② (warp4 port) DEMOTED — composition falsified.** The shipped rescale already pins each
   chunk's last cue to the speech end; warp4 computes "missing time" from the already-rescaled
   span, so run after the rescale it mostly sees noise and can distort good chunks while passing
   every monotonicity check. If tried at all: ONE bounded OFFLINE experiment, raw-cues→warp4 as a
   REPLACEMENT (or an explicitly composed map) — never "rescale, then frozen spec" in production.
4. **③ redesigned: known-text localization with abstention.** Instead of blind-transcribe+match:
   give Gemini a narrow audio window PLUS two high-information existing cues and ask where that
   exact passage begins. Abstention rules to test first: silence/music windows must abstain;
   reject repeated/backchannel text (require uniqueness in the VTT + best-vs-second margin);
   probes and evaluation anchors must be DISJOINT (no circular validation); monotone outlier
   filtering; no extrapolation past first/last reliable anchor; warp both ends through one
   monotone map; a bad anchor may only lose its local correction.
5. **Honest floor estimate (Gemini-only, mixed Uzbek/Russian, 30–120 min):** median 3–5s,
   p95 8–12s, occasional >15s on pathological regions; 1–3s median plausible ONLY if
   `audioTimestamp` materially works. The current ±5s rig cannot PROVE a 3–5s floor — the final
   floor claim needs human-marked onsets (≥30/video, 10–12 held-out meetings, repeated runs,
   pre-declared equivalence margin). "Gain < 2×SE" stays the per-step keep/discard rule, but
   absence of detected improvement is not proof of equivalence.
6. **Tonight's 6→3-min re-measure is CONFOUNDED** — the same deploy also changed the free-model
   chain (different models transcribe different chunks with different timestamp biases) and added
   the cycling guard (can cut late anchors). Record per-chunk model/path/guard-fired when
   interpreting; treat the re-measure as indicative, not a clean A/B.

## The ladder now (each step measured, keep only if gain > 2×SE)

① 3-min chunks — SHIPPED tonight (`f2a39cc`), re-measure pending deploy.
② `audioTimestamp` + pinned-model A/B — one video, one model, no fallback chain; compare with
   the same rig. CHEAP; do first.
③ Batch clock-parity fix — correctness regardless of measurement; smaller in practice now that
   the free chain rescues more chunks into the Standard path, but it must die.
④ Known-text localization warp (redesigned ③) — abstaining anchors + piecewise monotone warp.
⑤ (only if chasing the last seconds) offline warp4-as-replacement experiment.
STOP: when the remaining candidates plateau within the rig's noise — then the "Gemini-only
maximum" is declared with the honest caveat that a sub-rig-noise floor needs the human-anchor
protocol above.
