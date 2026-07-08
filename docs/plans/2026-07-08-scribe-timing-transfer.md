# Scribe timing-transfer — production integration plan (handoff)

**Owner decision (2026-07-08): make the accurate transcript timing PERMANENT for
new long videos.** Proven on bbzt (2h Uzbek meeting): drift 18s → ~1-2s. Do this
integration in the session AFTER the owner's `/clear`.

## What "done" looks like
Every NEW long video (multi-chunk, > 8 min) automatically gets its transcript cue
timestamps corrected to ~1-2s of the real audio, so the "Matn" tab's compact-block
highlight follows the audio. Short videos untouched (no drift). Graceful fallback
to Gemini times if the timing step fails or the key is missing.

## Already DONE + LIVE (do not redo)
- **Compact-block UI** (`51f64cd`, deployed): `apps/web/.../panels/TranscriptPanel.tsx`
  — cards cap at 3 cues / 20s; the active card highlights as ONE lit block;
  karaoke word-highlight removed. `getActiveTranscriptCardIndex` picks the active
  card. Tests in `group-cues-into-cards.test.ts` + `transcript-sync.test.ts`.
- **bbzt is live-repaired** to the v2 timing (`fixed-eleven-v2.vtt`) in R2; original
  backed up at key `{ownerId}/{videoId}/transcription.vtt.bak-predrift`
  (ownerId=25s3fqp7e7vc5p0, videoId=bbzt2424z6vvy6t).
- **Proven algorithm + data preserved** in `apps/web/scripts/scribe-poc/`:
  - `eleven-transcribe.mjs` — Scribe client POC (scribe_v1, language_code=uzb, word ts)
  - `transfer-dp.mjs` — THE transfer algorithm (~1-2s), see below
  - `eleven-words.json` — bbzt Scribe word-times (reuse; no need to re-call Scribe $)
  - `grid-localize.mjs` — ground-truth measurement harness (Gemini clip ASR grid)
  - `card-analysis.mjs`, `vtt-live.vtt`, `fixed-eleven-v2.vtt`

## The proven algorithm (port `scripts/scribe-poc/transfer-dp.mjs` → production, pure)
Input: Gemini VTT (good text, drifted times) + Scribe word list `[{word,start,end}]`
(good times). Output: same VTT with corrected times.
1. Tokenize both to stemmed word streams (stem = lowercase, apostrophe-normalize,
   first 5 chars, drop <3 chars). G = gemini words (keep cueIdx + wordIdxInCue), W
   = scribe words (keep absolute time).
2. **Skeleton anchors**: unique tri-grams then bi-grams present exactly once in
   BOTH streams → (gIdx→wIdx) pairs; keep monotonic via LIS on time. (~600 anchors)
3. **Densify**: between consecutive skeleton anchors run a bounded LCS DP on stems
   → dense word matches (~2700, 18% of words). Cap segment size (n*m ≤ 250k) to
   stay cheap.
4. **Outlier filter**: drop any dense match whose time deviates >8s from the
   skeleton interpolation (kills lone false LCS matches that land 100s off — this
   was the fix that took mean 24s → 3s).
5. **Per-cue start**: first matched word in the cue, corrected back by
   `wordIdxInCue * 0.38s` (avg word duration) to estimate the cue's first word;
   else interpolate from neighbor matches. Enforce monotonic starts + bounds.
6. Result on bbzt vs grid truth: 5/6 probes 0.9-2.1s (mean ~3s incl. one weak probe
   whose own ground-truth margin was 0.06 — real error ≈ measurement floor ±5s).

## Production integration spec
1. **`lib/eleven-scribe.ts`** (new): given the audio chunks the pipeline already
   extracts (`extractAudioChunksFromUrl`, mp3, with startSec), POST each to
   ElevenLabs batch STT `https://api.elevenlabs.io/v1/speech-to-text`
   (multipart: model_id=scribe_v1, language_code=uzb, timestamps_granularity=word,
   diarize=false; header `xi-api-key`), collect words with absolute time (word.start
   + chunk.startSec). Retry 429/5xx. Key from `ELEVENLABS_API_KEY` env.
2. **`lib/vtt-timing-transfer.ts`** (new, pure): the algorithm above.
   Unit-test: synthetic drift recovered, outlier rejected, monotonic, interpolation,
   identity when too few anchors (return input unchanged).
3. **`workflows/transcribe.ts`**: after `fillTranscriptGaps` (text finalized),
   BEFORE `saveTranscription`, and ONLY when `audio.chunks.length > 1` (long video)
   AND `ELEVENLABS_API_KEY` set: call scribe on the (still-available temp) chunks →
   transfer → replace times. On ANY failure, keep Gemini times (log + continue).
   Do NOT touch partial/resume (`transcription-partial.vtt`) — timing pass is final
   VTT only.
4. **Env**: set `ELEVENLABS_API_KEY` in Railway (@cap/web). Owner's key:
   `sk_d436b52e0bdf6560b3707d9155ea0152fff5d05a0f1cfb4d` (or owner rotates).
   `railway variables --service @cap/web --set ELEVENLABS_API_KEY=...`
5. **Cost/observability**: log `[transcribe] scribe-transfer: N cues shifted, mean Xs,
   Y dense matches`. Emit an ai_usage-style record if the project tracks spend.
6. **Repair existing long videos** (optional follow-up): a script mirroring
   `scripts/scribe-poc` to re-time already-COMPLETE long videos in R2 (backup first).

## Blast-radius
- Chapters/summary derive from TEXT, not times → unaffected.
- Player + compact-block highlight read cue times → improved.
- gap-fill runs BEFORE transfer (its span extraction uses true audio time; transfer
  only rewrites the final merged VTT).
- Partial-resume (`isChunkCoveredByPartial`) reads the drift-frame partial → untouched.

## Cost decision (owner asked about free/batch, 2026-07-08 — GROUNDED)
- **Speed is NOT a constraint**: ElevenLabs Scribe does 2h in ~12 min; batch/async
  handles up to 10h files with webhooks. A 2h video finishes far inside 2h.
- **Batch ≠ free**: ElevenLabs Scribe standard (batch/async) = **$0.22/hr = $0.44/2h**
  — that IS the cheap tier (realtime is $0.39/hr). Free plan is only ~30 min/month.
- **No free API handles Uzbek word-timestamps**: Groq/Whisper produce garbage on
  Uzbek (tested — 94% non-Uzbek output). ElevenLabs Scribe (Uzbek "Good") is the
  cheapest that works.
- **Only truly-free path = self-host** WhisperX/MMS forced-align (Apache-2.0, $0/video)
  BUT: needs a Python worker infra build, CPU is "impractically slow" for 2h (may need
  GPU $), and Uzbek alignment model (MMS via HF) needs setup + verification. Break-even
  vs $0.44/video is ~50-100+ long videos/month.
- **Recommendation**: ship ElevenLabs batch now ($0.44/long video — negligible at
  low/moderate volume). Revisit self-hosting only if long-video volume gets high.

## Verify (next session)
- Reuse `scripts/scribe-poc/eleven-words.json` + `grid-localize.mjs` to re-check the
  algorithm without spending Scribe $.
- After deploy: process a NEW long video, confirm log shows the transfer, ear-test.
- Owner's Gemini paid key spend-cap was RAISED (2026-07-08) — production refine/summary
  work again (verified with a live call).
