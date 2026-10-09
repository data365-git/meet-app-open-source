# Codex to Claude — Timestamp Pipeline Audit

Date: 2026-07-14
Branch: `qa-fixes`
Status: read-only audit; no transcription code, environment, or deployment change

## Production verdict

- Live production does **not** use ElevenLabs timing.
- The live container has `GEMINI_API_KEY` and `GEMINI_API_KEY_FREE`, but `ELEVENLABS_API_KEY` is not set.
- `workflows/transcribe.ts` only calls `applyScribeTimingTransfer()` after Gemini transcription, and that function returns the Gemini VTT unchanged when the recording has one chunk or the ElevenLabs key is absent.
- Therefore, current live timestamps are Gemini-generated estimates. They are not deterministic forced alignment and can drift on long recordings.

## Dormant hybrid path

- `lib/eleven-scribe.ts` asks ElevenLabs for word timestamps and transfers those times onto the Gemini text.
- This is the right high-level separation: Gemini remains the canonical text/meaning source while another model is used only as the timing oracle.
- Historical project evidence reports that the hybrid reduced mean drift from 18.3 seconds to 3.7 seconds on a two-hour Uzbek recording, while preserving Gemini's stronger text and number retention.

## Blocking defect before enablement

- The integration currently sends `model_id=scribe_v1`.
- ElevenLabs now documents `scribe_v1` as deprecated with removal dated 2026-07-09.
- Do not merely add the production key. Upgrade the timing request to `scribe_v2` and repeat the real Uzbek/Russian A/B test first.

## Recommended next implementation

1. Keep Gemini as canonical text, speaker/meaning, and downstream AI input.
2. Upgrade the timing-only request from Scribe v1 to Scribe v2.
3. Keep word-level timestamp transfer, with alignment coverage/confidence checks.
4. When alignment quality is low, keep Gemini chunk timing but mark it as estimated instead of silently presenting it as precise.
5. Run Scribe only for long recordings or recordings whose observed drift warrants the extra cost.
6. A/B on real mixed Uzbek/Russian meetings; measure median and p95 cue error, number retention, runtime, and cost before enabling the key.

ElevenLabs Forced Alignment is conceptually cleaner because it accepts known text plus audio, but its official supported-language list does not include Uzbek and it does not support diarization. It is not the safe production choice for this product today.

## Files inspected

- `apps/web/workflows/transcribe.ts`
- `apps/web/lib/eleven-scribe.ts`
- root `.env` and `apps/web/.env.local` presence flags only; no secret values were printed
- live Contabo container environment presence flags only; no secret values were printed

## Boundary

No transcription code, secret, environment variable, commit, push, or deployment was changed. Treat this document as evidence and an implementation recommendation, not an applied migration.
