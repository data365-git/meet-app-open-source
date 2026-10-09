# SPEC: VTT retime (pause-reinsertion) — production port

## Goal
Port the PROVEN scratchpad algorithm (warp4.mjs, corrected k-slope map) into the
transcription pipeline so every new long-audio transcription gets drift-corrected
timestamps at save time. Zero AI calls, pure math, regression-safe.

## New module: `apps/web/lib/vtt-retime.ts` (pure, no I/O)
Exports:
- `interface RetimeChunkSpec { startSec: number; durationSec: number }`
- `retimeVtt(vttText: string, silences: SilenceInterval[], chunks: RetimeChunkSpec[], totalDurationSec: number): string`
  (import SilenceInterval type from `@/lib/audio-extract` — already exported)

Behavior (mirror warp4.mjs exactly — the algorithm is FROZEN, do not "improve"):
1. Parse cues: lines containing `-->`; tolerate `HH:MM:SS.mmm` and `MM:SS.mmm`.
   Keep every non-timing line untouched (text, headers, settings after end token).
2. Per chunk k (span [startSec, startSec+durationSec)):
   - inChunk = cues with start in [c0-0.01, c1-0.01)
   - geminiSpan G = max(min(cue.end, cue.start+30)) - c0 ; skip chunk if no cues
   - chunk silences: overlap-clipped to chunk, chunk-relative, keep dur >= 0.4s
   - M = dur - G ; if G<=5 or |M|<2 -> identity for this chunk
   - if M/dur > 0.45 -> identity (sanity; log console.warn once per chunk)
   - S = dur - dSil ; rho = clamp((dSil - M)/dSil, 0.02, 1) ; gemSpeech = G - rho*dSil
   - if gemSpeech <= 1 -> identity ; k = S/gemSpeech ; if k>1.6 or k<0.6 -> identity
   - if M < 0 or dSil < 0.5 -> pure linear map g -> g * dur/G
   - else piecewise map: pauses pinned at audio positions, speech slope k,
     gemini pause advance rho*d (see warp4.mjs buildChunkMap — port 1:1,
     binary search, dg<1e-9 -> aPts[hi], overhang passes through)
   - new cue times: c0 + map(cue.start - c0), c0 + map(min(cue.end, cue.start+30) - c0)
3. Global monotone pass: starts non-decreasing, end >= start+0.2, clamp to
   [0, totalDurationSec].
4. **IDENTITY FAST-PATH: if NO chunk produced a non-identity map, return the
   ORIGINAL INPUT STRING unchanged (byte-identical).** Otherwise re-serialize only
   the timing lines (format `HH:MM:SS.mmm --> HH:MM:SS.mmm<restOfLine>`).

## Plumbing (surgical)
1. `apps/web/lib/audio-extract.ts`:
   - `AudioChunkExtractionResult` gains optional `silences?: SilenceInterval[]`.
   - Silence-anchored path returns the parsed `silences` it already computes.
   - Fixed-fallback path: leave undefined (no retime downstream). No other changes.
2. `apps/web/workflows/transcribe.ts`:
   - `ExtractedAudio` type gains optional `silences?: SilenceInterval[]`;
     `extractAudio` step passes them through from `extractAudioChunksFromUrl`
     (multi-chunk path only; single-file path leaves undefined).
   - NEW step `retimeTranscriptionStep` ("use step"): takes the merged vtt +
     audio.silences + audio.chunks (startSec/durationSec, filter durationSec!=null)
     + totalDurationSec; returns retimeVtt(...) or the input unchanged when
     silences missing / chunks.length < 2 / totalDurationSec == null.
   - Call order in `transcribeVideoWorkflow`: transcribeAudioChunks -> RETIME ->
     fillTranscriptGaps -> saveTranscription. (Gap-fill then operates on corrected
     times; its span extraction is true-time anchored.)
   - DO NOT touch: savePartialTranscription/loadPartialTranscription (partial
     stays in drift-frame — resume's isChunkCoveredByPartial depends on it),
     coverage/gap constants, speaker roster, restoreRussianScript.
3. Log one line when retime shifts anything:
   `[transcribe] retime: adjusted N cues, median shift Xs, max Ys for <videoId>`.

## Tests (`apps/web/__tests__/unit/vtt-retime.test.ts`)
Synthetic, no I/O:
1. Known compression recovered: build vtt for one chunk dur=100, silence [40,60],
   cues back-to-back with G=90 (M=10): post-map cue at g=70 starts at 80±0.3;
   cue before pause (g=30) unchanged ±0.3; chunk end maps to 100±0.3.
2. M>dSil case: dur=100, silence [40,50], G=70: cue g=39 -> ~60±0.5 (speech
   stretch k≈1.29, pause pinned at audio 40-50).
3. Identity: M<2 chunk -> INPUT STRING RETURNED UNCHANGED (===).
4. Sanity fallbacks: M/dur>0.45 -> unchanged; k out of [0.6,1.6] -> unchanged.
5. Monotonicity + min-duration preserved on a multi-chunk vtt with overlapping
   shifts; no cue crosses below its chunk start.
6. MM:SS.mmm input timestamps parse and serialize to HH:MM:SS.mmm only for
   ADJUSTED lines; untouched lines keep original formatting (identity path).
7. Multi-chunk: second chunk cues re-anchor at its startSec (its map is local).

## Gate (must all pass, run from repo root)
- `pnpm --filter @cap/web exec tsc --noEmit` -> 0 errors
- `pnpm --filter @cap/web run test` -> ALL green (806+ incl. new)
- `pnpm --filter @cap/web run build` (or `next build --turbopack` equivalent) -> SUCCESS

## Constraints
- Surgical: ONLY the files above. No refactors, no renames, no comment sweeps.
- Match existing code style (tabs, JSDoc tone in transcribe.ts/audio-extract.ts).
- Do NOT modify scratchpad files. Do NOT sub-delegate.
- If a test you didn't write fails, STOP and report (don't "fix" unrelated tests).
