# AI cost tiers (Arzon/Tez) — build plan

Decisions locked in `docs/adr/2026-07-08-ai-cost-tier-and-scribe-timing.md`. Owner go
given 2026-07-08 ("codex limitim bor undan ham foydalan" = build, route DOING to Codex).

## Waves

### Wave 1 — Scribe timing integration (IN PROGRESS, Codex)
Spec: `docs/plans/2026-07-08-scribe-timing-transfer.md` + prompt `docs/_codex-wave1-scribe.txt`.
Output: `lib/eleven-scribe.ts`, `lib/vtt-timing-transfer.ts` (pure), hookup in
`workflows/transcribe.ts`, optional env `ELEVENLABS_API_KEY`, unit tests. No key = off.
Review: main session diff-review + gates. Deploy needs owner OK + Railway env var.

### Wave 2 — Arzon/Tez tier (after Wave-1 review)
Behavior contracts (implementer maps to existing schema/patterns — discover, don't invent):
1. **Mode field** (additive DB / metadata): AI job carries `mode: 'cheap' | 'fast'`,
   `jobStartedAt`, `nextRetryAt`. Default per NEW job comes from the chooser (4).
2. **Patient free-tier (cheap mode)**: free-key 429/quota error → do NOT fall back to
   paid; persist `nextRetryAt` (backoff 10→30min) and let the EXISTING recover-cron
   pattern re-run from checkpoint (`transcription-partial.vtt` resume already works).
   In-process waiting forbidden (deploy kills it — old Batch `after()` lesson).
3. **Cost ladder (owner refined 2026-07-08): free → BATCH → paid.**
   - Free (patient) exhausts → submit REMAINING chunks to **Gemini Batch API** (50% off).
     Batch is async: cron polls, collects returned chunks into `transcription-partial.vtt`.
   - **At 4h** (`now - jobStartedAt > 4h`): cron flips to paid, finishes whatever chunks
     Batch hasn't returned, from checkpoint. Never redo completed chunks.
   - Same cron drives patient-free retry + batch polling + 4h flip (one durable loop).
   - Batch NOT used in `fast` mode (fast = paid, instant).
4. **Chooser UI**: `GenerateAiPanel` confirm dialog → replace the amber "pul ketadi"
   Ha/Bekor with two actions: **Arzon (2-4 soat, ~$0)** / **Tez (pullik)**. Uz/ru/en i18n.
5. **Continue-fast button (admin)**: on a running/stalled cheap job, show
   "Pullikda tez davom et" → endpoint flips mode to fast + triggers immediate
   continuation (same code path as the 4h auto-flip).
6. **Free-tier-first for summary/refine**: `generate-ai.ts` `callAiApi` — try
   `GEMINI_API_KEY_FREE` (free flash model) first, fall back to paid. In cheap mode
   quota errors follow (2); in fast mode instant paid fallback (current spirit).
   Record $0 usage events like transcription does.
7. **Progress UI** (`get-status` + panel): expose mode, chunk k/N, quota-wait state
   ("kvota kutilmoqda, keyingi urinish ~X daq"), time to auto-paid; render like the
   existing stage cards. Show the continue-fast button here.
   Blast-radius: get-status consumers, i18n files, ai_usage_events dashboards.

### Wave 3 — bigger chunks (MEASUREMENT-GATED, last)
Raise `LONG_AUDIO_CHUNK_DURATION_SEC` 6min → 15-20min (2h ≈ 5-7 calls, owner "max 7").
Timing no longer depends on Gemini (Scribe rewrites it) — but TEXT quality must be
proven first: golden-eval (`scripts/eval-refined.mjs` / bbzt window number-retention)
old vs new chunk size. Ship only if quality holds; else keep 6min.

## Rails
- Codex builds; main session reviews every diff + runs gates (tsc · vitest · build).
- No commits by Codex; main commits after review. Deploy only with owner OK.
- Old drifted videos: NO backfill (owner decision).
