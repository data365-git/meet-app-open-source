# Task 001 — Manual AI generation (admin-gated) + status UI

## Goal
Make AI generation **manual** (triggered by an admin via one button) instead of **automatic on page load**, and show a clear **status / step indicator** while it runs (so the user never stares at a blank wait and never re-clicks). Speech-to-text + AI are expensive → must only run on explicit click.

This is teacher requirement #3 (the manual one-button + status part). Do NOT rebuild the AI engine — it works.

## Verified background (file:line)
- **AUTO-fire #1 (share page):** `apps/web/actions/videos/get-status.ts`
  - lines ~64–140: when `transcriptionStatus` is null + GEMINI_API_KEY set → auto-calls `transcribeVideo(...)` (line ~108) and returns "PROCESSING".
  - lines ~155–201: when `transcriptionStatus === "COMPLETE"` + no aiGenerationStatus/summary → auto-calls `startAiGeneration(...)` (line ~178).
  - The `queueDesktopSegmentsFinalization` branch (~75–102) is UPLOAD finalization, NOT AI — KEEP it.
- **AUTO-fire #2 (desktop/extension recordings):** `apps/web/workflows/finalize-desktop-recording.ts:~122` calls `queueFinalizedRecordingTranscription()` — auto-transcribes after a desktop/extension upload. KEEP the upload finalization, but do NOT auto-start transcription/AI here either (manual everywhere).
- **Single-call full pipeline:** `apps/web/lib/transcribe.ts` → `transcribeVideo(videoId, userId, aiGenerationEnabled=false)`. Calling with `aiGenerationEnabled = TRUE` runs the WHOLE chain (transcribe → AI gen). Use the video's **owner** id as `userId`. It already no-ops if status is COMPLETE/PROCESSING/etc (safe against double-run).
- **Admin gate pattern:** `apps/web/actions/organization/invite-by-email.ts:27–43` — look up `organizationMembers.role` for the current user in the video's org; allow only `owner` or `admin`.
- **Viewer role for UI:** `apps/web/app/s/[videoId]/page.tsx` already computes the viewer's effective org role (search `getEffectiveOrganizationRole`). Thread an `canGenerate` / role boolean to the client.
- **Existing polling:** `apps/web/app/s/[videoId]/Share.tsx` polls `getVideoStatus()` via React Query — reuse it to drive the status indicator.
- **Status fields:** `videos.transcriptionStatus` (PROCESSING|COMPLETE|ERROR|SKIPPED|NO_AUDIO) + `metadata.aiGenerationStatus` (QUEUED|PROCESSING|COMPLETE|ERROR|SKIPPED).
- **Existing manual retry endpoint (template only):** `apps/web/app/api/video/ai/route.ts` (GET, owner-gated, ERROR/SKIPPED retry).

## Files to TOUCH
1. `apps/web/actions/videos/get-status.ts` — REMOVE the auto-trigger of transcription (don't call `transcribeVideo`) and of AI generation (don't call `startAiGeneration`). Make `getVideoStatus` READ-ONLY: just read + return current status/content. When transcription hasn't started, return `transcriptionStatus: null` (NOT "PROCESSING"). KEEP the desktop-segments upload-finalization branch.
2. `apps/web/workflows/finalize-desktop-recording.ts` — remove/guard ONLY the automatic transcription queueing (`queueFinalizedRecordingTranscription`). Keep all upload/segment finalization + thumbnail logic intact.
3. NEW `apps/web/app/api/videos/[videoId]/generate/route.ts` (POST) — admin-gated (owner/admin of the video's org, per the invite-by-email pattern). Looks up the video, then calls `transcribeVideo(videoId, video.ownerId, /*aiGenerationEnabled*/ true)`. Returns `{ started: true }` or `{ alreadyRunning: true }`. Anonymous / non-admin → 403.
4. NEW `apps/web/app/s/[videoId]/_components/GenerateAiPanel.tsx` (or similar) — the button + status indicator. Wire it into the empty-state of the tabs area in `Share.tsx` / `BelowVideoTabs.tsx` (where "No AI summary available" etc. currently show). Behaviour:
   - Show **"AI tahlilni boshlash"** button ONLY if the viewer is owner/admin AND nothing generated yet.
   - On click → POST `/api/videos/[videoId]/generate`, then let the existing poll update.
   - While running, REPLACE the button with a disabled status stepper (prevent re-click):
     - `transcriptionStatus === "PROCESSING"` → step 1/2: **"Transkripsiya tayyorlanmoqda…"**
     - `transcriptionStatus === "COMPLETE"` && aiGenerationStatus `QUEUED`/`PROCESSING` → step 2/2: **"AI tahlil: xulosa, vazifalar, refined…"**
     - show a spinner; optionally a rough ETA derived from `video.duration` (e.g. ceil(duration/5)s) — optional, label it "taxminan".
   - `ERROR` (either field) → show a short error + **"Qayta urinish"** button (re-POST).
   - Non-admin viewer with no content → show a neutral empty message (current behaviour), NO button.
5. `apps/web/app/s/[videoId]/page.tsx` — pass the viewer's `canGenerate` (owner/admin) flag down to `Share.tsx` → the panel.

## Files NOT to touch
- The AI engine: `lib/gemini-transcribe.ts`, `lib/generate-ai.ts`, `workflows/transcribe.ts` (transcription/AI logic), `lib/gemini-embed.ts`, RAG/chat.
- Player, comments, emoji, auth.

## Acceptance criteria
1. Opening a share page whose `transcriptionStatus` is null does **NOT** start transcription/AI (no `[Get Status] ... triggering` / `[transcribeVideo] Triggering` logs on load; DB status stays null).
2. Owner/admin viewer sees the **"AI tahlilni boshlash"** button; anonymous + non-admin viewers do NOT.
3. Clicking starts the FULL pipeline in one call (transcribe → AI gen). The button turns into a disabled status stepper; re-clicking is impossible while running.
4. When complete, all tabs populate (summary / tasks / transcript / refined / chapters) exactly as before.
5. POST to `/api/videos/[videoId]/generate` as anonymous or non-admin → HTTP 403.
6. Desktop/extension recordings no longer auto-transcribe (await the manual button), but still upload/finalize/get thumbnails fine.

## Gate (run yourself, report output)
- REAL typecheck (root, NOT the no-op `-F @cap/web` one):
  `node "C:/Users/localhost/AppData/Roaming/npm/node_modules/pnpm/bin/pnpm.cjs" -C C:/Users/localhost/Desktop/ustoz-github run typecheck`
  (this runs `next typegen && tsc -b`). Must pass with 0 errors.

## Constraints
- Additive only; UTF-8; no DB schema drops/renames. Do NOT touch git or `docs/STATE.md`. Windows: `node` on PATH, pnpm via the cjs path above, `FFMPEG_PATH` already in `.env`. The dev server is already running on :3001 via the preview tool — do NOT restart it.
- Final report = files changed + typecheck result + any deviations + anything you intentionally left for a follow-up.
