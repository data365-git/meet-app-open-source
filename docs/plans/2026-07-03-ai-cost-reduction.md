# AI Cost Reduction — Implementation Plan

> Owner-approved directions (2026-07-02): fix the ~7x-understated price table, add a
> Batch-API cheap mode with an admin toggle, show a passive upfront cost label.
> The blocking unknown — "does the Batch API accept audio?" — was spike-tested on
> 2026-07-03: **YES** (`apps/web/scratchpad/batch-spike-report.md`).

**Goal:** stop under-reporting AI spend, and cut real transcription cost ~50% via
the Gemini Batch API without changing output quality or format.

## Verified facts (do not re-derive)

- Real gemini-2.5-flash sync prices per 1M tokens: **text-in $0.30 · audio-in $1.00 · out $2.50**.
  Batch = 50%: $0.15 / $0.50 / $1.25. Audio ≈ 32 tokens/sec (1h audio ≈ 115,200 audio tokens).
- App table (`packages/utils/src/ai-pricing.ts`) currently says $0.10-in/$0.40-out for
  everything → total spend shown ~7x too low, and audio-in is priced as text.
- Batch spike (10-min mp3, real prompt from `gemini-transcribe.ts`, inline request):
  submitted → `BATCH_STATE_SUCCEEDED` in ~3-4 min; usable Uzbek transcript with cue
  timestamps; usageMetadata reports modality split (TEXT 6541 / AUDIO 19196 tokens).
  ⚠️ Terminal states are `BATCH_STATE_*` (NOT `JOB_STATE_*` as some docs say).
- Cost-recording chokepoint: `apps/web/lib/ai-cost-guard.ts` → `withCostGuard()` calls
  `priceForMicros(model, inputTokens, outputTokens)`; callers: `lib/transcribe.ts`,
  `lib/translate-ai.ts`, `lib/transcript-index.ts`, `workflows/generate-ai.ts` (usage
  read from `usageMetadata.promptTokenCount/candidatesTokenCount`),
  `app/api/video/ai/chat/route.ts`.

## Task 1 — Modality-aware pricing table (correctness, ship first)

**Files:** `packages/utils/src/ai-pricing.ts`, `apps/web/lib/ai-cost-guard.ts`, callers above.

1. Reshape `PRICES` to `{ textInPerMillion, audioInPerMillion, outputPerMillion }`;
   gemini-2.5-flash = 0.30 / 1.00 / 2.50; keep embedding at 0.
2. New signature `priceForMicros(model, { textInTokens, audioInTokens, outputTokens, batch })`
   — `batch: true` halves everything. Keep a back-compat overload or update ALL call sites
   in the same commit (grep `priceForMicros`).
3. `withCostGuard`'s `fn` result gains optional `audioInTokens` (default 0). Transcription
   callers extract it from `usageMetadata.promptTokensDetails` (modality `AUDIO`); the
   remainder is text-in. Non-audio callers unchanged (pass all prompt tokens as text).
4. Unit tests: audio-vs-text split priced correctly; batch halves; unknown model falls
   back to DEFAULT_PRICE (raise it to 2.5-flash rates so "unknown" never under-prices).

**Verify:** tsc 0 · pricing unit tests · one manual re-check: AiSpend page total for a
known video ≈ duration×rate hand-calc.
**Note:** forward-only — old `aiUsageEvents.costUsdMicros` rows stay understated; do NOT
backfill (owner can be told totals before 2026-07 are ~7x low).

## Task 2 — Batch transcription mode + admin "Arzon/Tez" toggle

**Files:** `apps/web/lib/gemini-transcribe.ts` (new batch submit/poll helpers — this file
is pipeline-heart: Opus writes or reviews line-by-line), org settings storage + admin
settings UI (same pattern as AI budget fields), `apps/web/lib/transcribe.ts` wiring.

1. Org-level setting `aiSpeedMode: "fast" | "cheap"` (default `fast`). Admin Settings →
   AI section: radio "Tez (sync)" / "Arzon (Batch, ~50% chegirma, sekinroq)". Plain-Uzbek
   helper text. No per-video override in v1.
2. `cheap` mode: each transcription chunk (and gap-fill span) goes through
   `models/<model>:batchGenerateContent` with the SAME contents/generationConfig as sync
   (spike-proven shape: `batch.input_config.requests.requests[0].request`), then poll
   the returned `batches/<id>` every 30-60s until `BATCH_STATE_{SUCCEEDED,FAILED,CANCELLED,EXPIRED}`.
   - Persist the batch name in job state/logs before polling (crash-safe re-attach).
   - Timeout: if not terminal in 30 min → cancel best-effort and FALL BACK to sync for
     that chunk (never fail the video because batch is slow).
   - Per-request inline errors (`inlinedResponses[].error`) → same retry path as sync errors.
   - Response text extraction: `response.inlinedResponses.inlinedResponses[0].response`
     (note the doubled nesting seen in the spike) — write a tolerant unwrap.
3. Files API upload for chunk audio (spike-proven) + DELETE the uploaded file in a
   `finally` after terminal state.
4. Cost guard: pass `batch: true` so recorded cost uses batch rates.
5. Concurrency: submit all chunks' batches up front, then poll (batch jobs run server-side;
   the 3-way `mapWithConcurrency` limit applies to submission+polling loops, not runtime).

**Verify:** unit tests for state mapping/unwrap/fallback · then ONE real short video on
cheap mode end-to-end (announce ~cost first; a 10-min chunk ≈ $0.017) · sync mode untouched
regression: re-transcribe smoke stays green.

## Task 3 — Passive upfront cost label in GenerateAiPanel

**Files:** `apps/web/app/s/[videoId]/_components/GenerateAiPanel.tsx`, `messages/{en,ru,uz}.json`.

- Under the generate button, one muted 11-12px line (NOT a dialog): estimated cost =
  `duration` × rate for the org's current mode, shown in so'm via `formatUzs`.
  Sync ≈ $0.45/soat, cheap ≈ $0.22/soat (recompute from Task 1 table at render, don't
  hardcode; duration prop already exists).
- i18n key e.g. `share.aiCostEstimate` = "Taxminiy narx: ~{amount}".

**Verify:** label matches hand-calc for a known duration; hidden when duration unknown.

## Task 4 (backlog, needs owner OK) — gemma text-stage experiment

Text-only stages (summary/refined/translate) on a cheaper model. Do NOT build until
Tasks 1-3 are live and measured; then A/B on the gemini-ab harness first.

## Routing

| Task | Executor |
|---|---|
| 1 (pricing) | Sonnet (spec-tight) + Opus review |
| 2 (batch pipeline) | Opus (pipeline-heart) |
| 3 (label) | Sonnet |
| Review | Codex adversarial |

Deploy rule unchanged: one push, full gate, no live PROCESSING job, live verify after.
