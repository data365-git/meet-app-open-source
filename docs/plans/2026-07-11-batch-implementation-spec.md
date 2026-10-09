# Ustoz — 12-task batch implementation spec (2026-07-11)

Source: task collection + recon + owner grill in `2026-07-11-task-batch-collection.md`. This is the buildable spec. Rules: Karpathy surgical (smallest diff, no bundled extras), blast-radius adapted in the same change, every task has a verify step, gate = `pnpm tsc -b` (root) + `pnpm --filter @cap/web run test` + `next build` for `"use server"`/route changes. Deploy only on owner GO; push = Railway auto-deploy on branch `qa-fixes`.

## Shared contracts (settle BEFORE fan-out — both backend & frontend depend on these)

1. **AI progress metadata (T3).** Extend `VideoMetadata` (`packages/database/types/metadata.ts`) with:
   - existing: `transcriptionChunksCompleted?`, `transcriptionChunksTotal?` (already written by `transcribe.ts:1516-1518`).
   - NEW: `aiStageChunksCompleted?: number`, `aiStageChunksTotal?: number` (per-stage counter for summary/refine passes).
   - Widen `aiProcessingStep` usage only if needed; keep the enum `transcribe|summary|refined|done` (do NOT add finer enum values — express fine progress via the counters, not new steps, to respect `GenerateAiPanel.tsx:206-211`).
2. **Task category (T8).** Add `category?: string` to the task object. Controlled vocab (AI picks one, else "Boshqa"): `Sotuv`, `Marketing`, `Moliya`, `Texnik`, `HR`, `Operatsion`, `Strategiya`, `Boshqa`. Field flows: Zod schema → `readTask` → prompts → render.
3. **Chat variant flag (T9).** `?variant=modal` | `?variant=inline` on `/s/<id>`; default `inline`. Read once in `ShareVideo.tsx`, pass down.

---

## STREAM A — AI pricing hardening (T1) — files: `lib/gemini-batch-transcribe.ts`, `app/api/cron/poll-batch-jobs/route.ts`, `lib/ai-cost-guard.ts`, `workflows/transcribe.ts`
**Goal:** batch/sync transcription must not undercount audio when `promptTokensDetails` lacks an AUDIO entry.
**Approach (surgical):** transcription input is essentially all audio. In `unwrapBatchResponse` (`gemini-batch-transcribe.ts:149-177`): if `audioInTokens===0 && inputTokens>0`, set `audioInTokens = inputTokens` (so text split = 0). Mirror the same guard at the sync transcription accounting where `result.audioInTokens` feeds `withCostGuard` (`transcribe.ts:656-675` / `ai-cost-guard.ts:281-289`) — ONLY for `operation:"transcription"` (summary/refine are genuinely text). Do not touch the 0.5 batch factor (correct).
**Verify:** unit test in `__tests__/unit/gemini-batch-transcribe.test.ts` — a usageMetadata blob with NO `promptTokensDetails` → `unwrapBatchResponse` yields `audioInTokens===inputTokens`; and a pricing assertion that the resulting cost uses the $1.00/M audio rate (×0.5), not $0.50/M text. Gate green.

## STREAM B — AI pipeline: task categories + stage progress counter (T8 + T3-backend) — files: `workflows/generate-ai.ts`, `packages/database/types/metadata.ts`, `app/s/[videoId]/_components/panels/TasksPanel.tsx`
**Goal:** (a) AI emits a `category` per task and the Vazifalar tab renders grouped by category; (b) summary/refine passes persist a per-chunk counter for the status UI.
**Approach:**
- T8: add `category` (enum in shared-contract vocab) to the Zod schema (`generate-ai.ts:116-126`), carry it in `RawTask`/`readTask` (`:1582-1607`, else it's dropped), and add it to BOTH prompt JSON templates (`:1662`, `:1810/1826`) with a one-line rule ("assign each task ONE category from: …; use Boshqa if unclear"). In `TasksPanel.tsx` render tasks grouped by `category` (stable vocab order), each group a labeled section; ungrouped/legacy tasks (no category) fall into "Boshqa". Keep the existing progress bar over the full set.
- T3-backend: in the summary fan-out (`generateMultipleChunks` `:1649-1700`) and refine fan-out (`generateChapterAlignedRefined` `:1486-1523`), write `aiStageChunksCompleted/Total` to metadata from inside the `mapWithConcurrency` completion callback (throttled read-modify-write, analogous to `savePartialTranscription`). Reset the counter at each stage transition.
**Verify:** unit test that `readTask` preserves `category`; a golden-eval re-analyze of one video shows grouped tasks; metadata shows `aiStageChunksCompleted` advancing (log/probe). Re-analysis needed for old videos (documented, acceptable).
**Blast-radius:** `dedupeTasks` (`:1616`) must dedupe by title across categories (keep). Language-aware summaries (`ShareVideo.tsx:722`) unaffected (category is language-neutral key rendered via i18n labels).

## STREAM C — Analysis-panel UI: fine status + ETA + junk cleanup + chat prototype (T3-frontend + T7 + T9) — files: `GenerateAiPanel.tsx`, `ShareVideo.tsx`, `SharePanel.tsx`, restore `AIChatPopup.tsx`+`AIFab.tsx`+`ai-chat.css`
**Goal:** the status panel shows the exact live step + a real ETA; remove the empty "data365 AI" chips; offer both chat variants for the mentor to choose.
**Approach:**
- T3-frontend: in `GenerateAiPanel.tsx` (`:196-370`) show, under the active step, the fine counter: transcription → `transcriptionChunksCompleted/Total` "Gemini'ga N/M audio yuborildi" (data already available via `get-transcript` / metadata); summary/refine → `aiStageChunksCompleted/Total` (from Stream B). Replace the crude `etaMin = duration/120` (`:243`) with a rate-based ETA: elapsed / completed × remaining, falling back to the heuristic when no rate yet. New i18n keys (uz/ru/en).
- T7: remove/again-gate the bare `aiChatTitle` chip at `ShareVideo.tsx:792-794` (renders empty, unconditionally) and dedupe against the real chat header chip (`SharePanel.tsx:417`). Ensure "data365 AI" appears at most once, tied to actual content.
- T9: restore `AIChatPopup.tsx` + `AIFab.tsx` + `ai-chat.css` from git `967367f` (on-disk `AIChatPopup.tsx` copy at `_deploy-baselines/ustoz-github-origin-main-e2d2aca/...`; FAB+css via `git show 967367f:…`). Gate by `?variant`: `modal` → render `AIFab`+`AIChatPopup` (blue button → dialog), hide inline chat; `inline` (default) → current `SharePanel` chat. Reuse the shared `/api/video/ai/chat` backend; reconcile the modal to the current `data365:aiChat` localStorage persistence + `ai-chat-timestamps.ts` citations. Also fix the chat "Transcript index is not ready" path (`chat/route.ts:316-320`): when transcript isn't ready, the UI should DISABLE the ask box with a friendly "Transkript hali tayyor emas" note instead of sending and erroring.
**Verify (browser pane, mobile + desktop):** watch a running analysis → fine N/M step + ETA visible; no empty "data365 AI" chip; `?variant=modal` shows blue FAB→modal, `?variant=inline` shows current; chat disabled with friendly note when transcript missing.
**Blast-radius:** `ShareVideo.tsx` is also touched by Stream F (player) — Stream F is WAVE 2, no wave-1 conflict. Within wave 1, Stream C OWNS `ShareVideo.tsx`.

## STREAM D — Import file: video + audio (T2) — files: `caps/Caps.tsx`, `import/file/ImportFilePage.tsx`, `import/file/useImportUpload.ts`, `actions/video/create-for-processing.ts`, worker check
**Goal:** "Import file" accepts video AND audio end-to-end (upload → process → transcribe → correct render), no video-only assumptions break audio.
**Approach:** accept filter is already video+audio. (a) Rename UI copy: `Caps.tsx:332` "Import video"→"Import file" (i18n), `ImportFilePage.tsx:60-63` heading/subtext to file (video/audio). (b) In `create-for-processing.ts:69,73,97`, when `isAudio`, use an audio-correct `contentType` + raw key extension + `source` + default name (not hard-coded `video/mp4`/`raw-upload.mp4`/"data365 Upload"). (c) VERIFY the processing worker (`packages/web-backend/src/Videos`, `app/api/thumbnail/route.ts`) does not hard-require a video frame for audio (thumbnail generation must skip/placeholder for audio). (d) Confirm `PreUploadTrimmer` trims audio without a video track.
**Verify:** LIVE — import a real `.mp3`/`.m4a` → uploads, no thumbnail crash, transcription runs, renders as audio (isAudio overlay). Headless where possible; owner device confirm for the picker.
**Blast-radius:** downstream `isAudio` consumers already handle audio (`VideoThumbnail`, `CapCard`, `ShareVideo`) — verify not regressed.

## STREAM E — Recorder: smart presentation + always remote audio (T11/T12) — files: `apps/browser-extension/*` (MV3)
**Goal:** when the owner presents his own screen in a Meet, the recording captures HIS presented screen/window (via getDisplayMedia, outside the browser tab) AND ALWAYS the remote participant audio (Meet tab audio) + his mic, mixed into one file.
**Approach (design-first — this is the hardest, MV3-constrained):**
- Video: `getDisplayMedia({ video: { displaySurface: "monitor"/"window" } })` in a visible content-script/page with a user gesture (NOT the SW/offscreen — MV3 constraint, see `offscreen/recorder.ts:1-17`). Let the owner pick his presentation screen/window.
- Remote audio: capture the Meet TAB audio via `chrome.tabCapture.getMediaStreamId({ targetTabId })` → offscreen `getUserMedia({ audio: { chromeMediaSource:"tab" } })` (the ONLY reliable remote-audio source; recon `offscreen/recorder.ts:110-128`).
- Mic: `getUserMedia({ audio })` (local).
- Mix all audio via `AudioContext` → `MediaStreamDestination`; combine with the getDisplayMedia video track → `MediaRecorder`.
- Rework the `START_MEET` path (`sw.ts:393-431`) away from tab-VIDEO capture toward this hybrid (screen video + tab audio). Keep tab audio re-routed to speakers so the meeting stays audible.
**Verify:** logic/unit test the stream-assembly (given N tracks → one mixed stream); real capture = owner device test (headless can't do the picker). Extension = separate build/reinstall by owner.
**Note:** consider a short prototype/design doc before the full rewrite; flag to owner this ships as an extension update he must reinstall.

## STREAM F — Player (T4, T5, T6, T10) — WAVE 2 — files: `CapVideoPlayer.tsx`, `video/media-player.tsx`, `DockableVideo.tsx`, `SegmentedProgressBar.tsx`, player block in `ShareVideo.tsx`
- **T4 split + replace-with-audio:** branch `CapVideoPlayer` on `metadata.isAudio` into a dedicated audio UI (waveform/simple transport) vs the video UI, instead of the current gradient overlay (`CapVideoPlayer.tsx:753`). Add a "Videoni audioga almashtirish (storage tejash)" button → confirm dialog → server action: extract audio from the stored video, upload as audio object, DELETE the video object from R2, set `metadata.isAudio=true`, keep AI analysis. IRREVERSIBLE (owner decision) — confirm copy must say so.
- **T5 mobile seek:** add a transparent gesture layer over `MediaPlayerVideo` (`media-player.tsx:924-978`): center third tap = play/pause (current), left third tap = seek −10s, right third tap = seek +10s (dispatch `MEDIA_SEEK_REQUEST`); horizontal drag/swipe = scrub. Keep desktop unchanged.
- **T6 resume position:** write `video.currentTime` (throttled) on `timeupdate`/`pause`/`beforeunload` to `localStorage` keyed by `videoId` (`ShareVideo.tsx:306-329` already has a timeupdate listener); restore on `loadedmetadata` unless within ~last 10s or a `?t=` deep-link is present.
- **T10 pinned player (mobile):** flip the desktop-only gate in `DockableVideo.tsx:36-42,121-125` to enable a Telegram-style pinned-top mini-player on mobile while scrolling the analysis; the `<video>` already stays mounted across dock (playback continuity solved). Restyle the mobile dock (pinned top bar, not draggable corner).
**Verify (browser pane, mobile):** tap sides seeks ±10s, drag scrubs; refresh resumes position; player pins at top and keeps playing while scrolling tabs; audio-only shows the audio UI.

---

## Execution plan (workflow)

**Wave 1 (parallel — owner priority: AI + Recorder + Import):** Streams A, B, C, D, E.
- File-ownership is disjoint per stream (A=pricing libs, B=generate-ai+TasksPanel+metadata type, C=analysis-panel UI incl. ShareVideo.tsx, D=import, E=extension). B and C share only the metadata contract (settled above) — no same-file edits. → safe parallel; worktree isolation NOT required (disjoint files) except E may run in its own worktree since it's a separate app.
- Each stream: implement → self-gate (tsc+test; +next build for D/route changes) → main-session diff review → adversarial verify for the risky ones (A pricing math, E stream assembly, C chat restore).

**Wave 2 (after Wave 1 merged & gated):** Stream F (Player) — owns `CapVideoPlayer`/`media-player`/`DockableVideo` + the player block in `ShareVideo.tsx` (which Wave 1 Stream C also touched → sequence after C to avoid conflict).

**Gate before any deploy:** `pnpm tsc -b` = 0 · `pnpm --filter @cap/web run test` green · `next build` SUCCESS · main-session diff review · live browser-pane verify of each observable change · owner GO (push = Railway auto-deploy). Recorder (E) + audio-import (D) + player (F) need owner device confirmation (headless can't).

**Prototype (T9):** the two chat variants ship behind `?variant=` so the owner sends the mentor a link to pick — decision-by-seeing, then harden the winner in a follow-up.
