# ИSH 3 — Multi-language (uz/ru/en) — DESIGN + DECISIONS (Jarvis, overnight 2026-06-30)

Owner asleep; authorized: ONE final deploy at end · additive-only live-DB change OK · "decide deeply yourself, write down choices, tell me in the morning" · spend Gemini freely.

## KEY DECISION — NO DB SCHEMA MIGRATION NEEDED
AI content already lives in `videos.metadata` (JSON column, typed `VideoMetadata` in `packages/database/types/metadata.ts`). Adding language versions = extend the TS type + write new JSON keys + new R2 keys. The JSON column accepts any shape → **no `db:push`, no live-DB schema change, no migration risk.** (Owner approved a migration, but the simplest/safest path avoids one entirely. Karpathy: simplicity first.)

## DATA MODEL (additive to VideoMetadata)
- `aiSummary` (existing) — the BASE generation, untouched (back-compat).
- `aiBaseLanguage?: "uz"|"ru"|"en"` — best-effort language of the base (label so the picker can show it). If unknown/auto, default-label "uz" is NOT assumed; we show base as its detected lang or fall back to org default label.
- `aiSummaryByLanguage?: { uz?: AiSummary; ru?: AiSummary; en?: AiSummary }` — translated cached versions (analysis + refinedTranscript per language).
- `aiTranslationStatus?: { uz?: S; ru?: S; en?: S }` where S = "PROCESSING"|"COMPLETE"|"ERROR" — for on-demand polling.
- `preferredLanguage?: "uz"|"ru"|"en"` — per-video default to display (set by owner/org member). Initial selection = `preferredLanguage ?? orgDefault(aiGenerationLanguage) ?? aiBaseLanguage`.
- Captions: BASE `{ownerId}/{videoId}/transcription.vtt` (unchanged). Translated: `{ownerId}/{videoId}/transcription.{lang}.vtt` in R2 (timestamps preserved, cue text translated).

## ON-DEMAND TRANSLATION FLOW
- `POST /api/video/ai/translate` { videoId, language } — AUTH-GATED: only owner OR org member (guests rejected 403). Idempotent: if `aiSummaryByLanguage[lang]` COMPLETE → no-op return.
- Sets `aiTranslationStatus[lang]=PROCESSING`, fires inline (fire-and-forget `.catch`) translation:
  1. Load base `aiSummary` + base transcript VTT (R2).
  2. Gemini translate (one or few calls, `withCostGuard`, reuse `getAiLanguageInstruction`): translate overview/topics/nextSteps/tasks/chapters titles+body + refinedTranscript paragraphs → target lang. Keep numbers/timestamps.
  3. Translate captions: parse base VTT cues → translate cue texts (batch) → re-emit VTT with SAME timestamps → write `transcription.{lang}.vtt`.
  4. Write `aiSummaryByLanguage[lang]` + status COMPLETE (or ERROR on fail). maxOutputTokens 65536 (LLM-JSON-truncation lesson).
- `GET /api/video/ai/translate?videoId=&language=` — returns status (for polling hook, use-ai-status style, 4s interval, stop on terminal).

## UI
- Language picker component on share-page top, NEXT TO the dark/light toggle. 3 langs uz/ru/en. Each shows: available (cached ✓) or, for owner/member, "generate" (creates ~30s). Guests: only switch among existing; no generate affordance.
- `ShareVideo` gains `selectedLanguage` state. Panels (Summary/Chapters/Refined/Transcript) read `aiSummaryByLanguage[selected] ?? aiSummary`; caption `<track>` swaps to `transcription.{selected}.vtt` (or base). Instant for cached; for a fresh generate → optimistic PROCESSING + poll → swap when COMPLETE.
- Owner/member can set per-video `preferredLanguage` (the act of generating + selecting persists it; minimal UI — selecting a lang as owner sets preferred).

## BUILD CHUNKS (delegate to Sonnet 5, Opus reviews each diff; gate = ROOT `pnpm tsc -b` + BOM)
- [A] Types + read helper (`metadata.ts` + a `getAiSummaryForLanguage` util). DONE-marker below.
- [B] Translate backend: route + lib `translateAiContent` (auth gate, Gemini, cost guard, captions, R2, status).
- [C] Status GET + polling hook (`use-ai-translation.ts`).
- [D] Picker UI + ShareVideo wiring + panel/caption language swap + guest gating.
- [E] Per-video preferred + initial-selection wiring + org default.

## VERIFY METRIC (live, after the single deploy)
Russian video → pick UZ (as owner) → generates → analysis+refined+captions become Uzbek; ru↔uz switch instant after cache; guest can switch existing but cannot generate. Short video first (cost), then one long.

## DECISION LOG (append as I go)
- D1 (start): No DB migration — use metadata JSON + R2 keys. Rationale: zero live-DB risk, matches existing aiSummary storage.
- D2: Types extended in `packages/database/types/metadata.ts` (ShareLanguage, TranslationStatus, + 4 VideoMetadata fields). DONE.
- D3: Frontend lives ENTIRELY inside `ShareVideo` (no new cross-component context). `LanguagePicker` rendered at the top of ShareVideo's tabs area; drives a local `selectedLanguage` state. Rationale: ShareHeader is OUTSIDE the Share/CaptionProvider subtree, so a header-placed picker would need a page-level context — too invasive. ShareVideo already receives `canGenerate` (owner/member gate) + full `data.metadata` (availability) + owns the panels + caption pipeline. Simplest correct home. (Grill said "near dark/light toggle"; there is NO theme toggle on the share page currently, so "share-page top, visible" = above the analysis tabs.)
- D4: Picker availability/status read from server-rendered `data.metadata` (aiSummaryByLanguage / aiTranslationStatus / aiBaseLanguage / preferredLanguage). After a fresh translate COMPLETE → `router.refresh()` reloads data, then auto-select that language. No get-status change needed for availability; a dedicated GET /api/video/ai/translate is used only for ~30s poll.
- D5: Selected language drives: panels read `aiSummaryByLanguage[sel] ?? aiSummary`; transcript+caption VTT fetched via `getTranscript(videoId, sel)` (translated R2 key, base fallback). Base option always present + labelled by `aiBaseLanguage` (or "asl").
- D6: `AiOperation` union (`packages/database/schema.ts:1537`) gained `"translate"` for cost-tracking. The `operation` column is `varchar(32)` (NOT a MySQL enum) → NO DB migration needed, just the TS union. Fixed the only tsc error from the backend agent.
- D7: Translate route AUTH gate = owner OR org **admin/owner** (mirrors the existing `generate` endpoint, stricter than "any member"). Matches `canGenerate` passed to ShareVideo, so UI + API agree. Guests (no session) → 403; can only SWITCH already-translated languages, never trigger paid Gemini. Cost-protected.
- D9 (DONE): ИSH 3 code-complete + ROOT `pnpm tsc -b` EXIT 0 + BOM-clean + Opus-reviewed. Files: types(metadata.ts), schema.ts(AiOperation+translate), lib/translate-ai.ts(batched), api/video/ai/translate/route.ts, actions/videos/get-transcript.ts(lang param), hooks/use-ai-translation.ts, _components/LanguagePicker.tsx, ShareVideo.tsx(wiring), messages/{en,ru,uz}.json(2 keys). Full vitest pending test-fix agent. NOT pushed.
- D10 (minor follow-up, non-blocking): `aiBaseLanguage` is never SET at base generation (generate-ai.ts unmodified) → base item shows "Original" + all 3 langs offered for generation (translating to same-as-base is wasteful but not broken). Could record org default lang as aiBaseLanguage later.
- D11 (REVIEWS): Two INDEPENDENT adversarial reviews ran (owner asked for Codex). Codex CLI binary found at `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` (v0.142.4); `codex review --uncommitted` works (no custom-prompt with that flag). Plus a fresh Opus reviewer (sanctioned fallback). Findings + fixes:
  - Opus HIGH — TasksPanel optimistic toggle clobbered on every parent re-render (currentTime updates during playback give `activeAiSummary?.tasks ?? []` a fresh identity → re-sync effect wipes the in-flight toggle). FIXED: memoized `activeTasks` in ShareVideo (`useMemo([activeAiSummary])`) → stable identity.
  - Codex P2 — translate-ai.ts could cache a LOSSY translation if Gemini omits items (zod `.default([])` accepts short arrays). FIXED: count-guard before reassembly (topics/nextSteps/tasks/chapters/refinedTitles lengths must equal source → else throw → ERROR status, no silent loss).
  - Codex P2 — `/api/video/ai` GET status poll was owner-ONLY (403 for org admins who CAN generate) → poll stuck. FIXED: GET now allows owner OR org owner/admin (same gate as translate/generate).
  - Opus MEDIUM (noted, NOT fixed — acceptable single-owner): metadata read-modify-write is non-atomic → concurrent translate+toggle or concurrent multi-lang translate can last-write-wins silently. Fine for one owner clicking sequentially; revisit before multi-admin concurrent use.
  Post-fix gate: tsc 0 · vitest 602/0 · BOM clean.
- D8: Anti-truncation for 2-hour videos — translation is BATCHED (captions ~80 cues/call; refinedTranscript paragraphs ~50/call; compact summary fields in one call). Numeric `startSec` timings copied from the SOURCE structure, never trusted from model output. Rationale: a single Gemini call on a 2h transcript would hit MAX_TOKENS → ERROR (the known LLM-JSON-truncation lesson). Owner's reported pain is exactly 2h videos.
