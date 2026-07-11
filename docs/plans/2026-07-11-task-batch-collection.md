# Ustoz — Task batch collection (2026-07-11)

> Owner is dumping MANY tasks. Method: (1) collect + understand all → (2) one combined analysis + spec + plan → (3) grill/consult owner → (4) execute parallel/workflow. DO NOT build until phase 3 approved. "Smart-group the tasks" = owner guidance for the analysis phase.

## Batch 1

**T1 — AI-analysis price verification (investigation).**
Video: `https://capweb-production-dd85.up.railway.app/s/fm3pz7yref328m7`. Owner: the AI-analysis price shown looks off — the chunk/batch cost looks "ancha arzon" (suspiciously cheap). Verify the cost recorded (ai_usage_events) vs actual token usage / pricing table; is the batch-rate accounting correct or under-counting?

**T2 — Import: "Import video" → "Import file" (video/audio).**
The import button/flow currently says/accepts video only. Should be "Import file" accepting BOTH video and audio.

**T3 — AI-analysis status: precise live steps + ETA + UI fixes.**
Status must show EXACTLY what is happening right now, down to fine steps (e.g. "sent 1/8 audio chunk to Gemini"). Show an estimated remaining time (ETA). Also fix the ugly/broken UI in the analysis/status design.

**T4 — Split video player vs audio player + "keep audio only" storage saver.**
(a) Video player and audio player should be SEPARATE (distinct UI per media type).
(b) New feature: one button to REPLACE the video with just its audio (video is heavy; if it's not important, drop the video and keep only audio). The existing AI analysis stays; only the media is replaced → saves storage.

**T5 — Mobile player seek controls broken.**
On phone: tapping the video only toggles pause/start. Needs: tap right/left once = seek ±5–10s (YouTube / MX / Arc player style); drag/swipe left-right on the video = scrub the playback position. Currently neither seek-tap nor drag-scrub works.

**T6 — Video does not resume after refresh.**
On page refresh the video restarts from 0 instead of resuming from the last watched position.

## Batch 2

**T7 — Remove clutter "data365 AI" labels/empty bubbles.**
Owner (with mobile screenshot of the Xulosa/analysis panel): the entries labeled "data365 AI" are not important. Screenshot shows the "data365 AI" sender-chip repeated 3+ times as EMPTY bubbles (chip with nothing after it) → UI junk. Clean them up / stop rendering empty AI-labeled bubbles. Reinforces T3 (ugly UI). [Interpretation to confirm in grill: he means the repeated empty "data365 AI" chips, not some recordings list.]

### Screenshot observations (evidence for T3 — analysis-panel UI on mobile, 2026-07-11)
- Repeated empty "data365 AI" chips (T7).
- "Rejim: Arzon — Tekin limit kutilmoqda, 4 soatda avtomatik tezlashadi" + "Pullikda tez davom et" button render OK.
- Stepper: Transkript ✓ · Xulosa ✓ · Tozalash (3, active) · Tayyor (4) — but "AI tahlili yaratilmoqda…" + skeleton shows WHILE stepper says step 3/Tozalash → the status text is generic, not the precise micro-step owner wants (T3).
- Chat bug: asked "Mijoz qaysi savollarni berdi?" → error "Transcript index is not ready because the transcript is missing or empty." The AI chat/Q&A fails when transcript index not ready — possible separate bug (note for analysis; confirm if owner wants it fixed).

## Batch 3

**CORRECTION — "smart group" is an APP task, not guidance to me.**
Screenshot text: "Not groupping the tasks at all / It should group smartly." Refers to the **Vazifalar (Tasks) tab** which shows the AI-extracted action items as a FLAT list ("VAZIFALAR 12"). → becomes **T8**. (Earlier I mis-read "smart-group" as guidance to me — wrong.)

**T8 — Vazifalar tab: group the AI-extracted tasks smartly.**
The AI-generated action-items/tasks are shown as one flat list (12 items). They should be grouped smartly (by theme / category / owner / priority — to define in grill), not flat.

**T9 — AI chat: restore the old blue-button → modal ask, bugs fixed (or show BOTH variants for the mentor to pick).**
The AI chat used to be a blue button that, when clicked, opened a window/modal to ask questions. Owner wants that back IF possible, but with its previous bugs/shortcomings fixed. Alternative he offered: show BOTH the old (blue-button modal) and the current (inline) variants equally, share a link, and his mentor ("ustozim") picks one. → PROTOTYPE candidate (2 variants via `?variant=`, decide by seeing). Ties to the T7 chat error ("Transcript index not ready").

**T10 — Pinned/sticky media player while reading the AI analysis (Telegram-style).**
Like Telegram's pinned voice-message player: while the user scrolls/reads the AI analysis, the audio (or video) player should stay PINNED at the top and keep playing, visible. "auto pin bo'ladi agar playing bo'lsa" = auto-pin when playback is active. Ties to T4 (video/audio split) + T3/T6 (analysis UI + player).

## Batch 4

**T11 — Recorder: full-screen / whole-screen capture, not just the current tab.**
Currently the recorder captures only "this tab". In Google Meet, when a participant shares their screen, the shared/presented window is a DIFFERENT window → tab-capture misses it (only the Meet tab shows, the presented content is invisible). Need entire-screen (or window) capture so the shared screen is recorded. [Blast-radius: this is a getDisplayMedia capture-surface change in the extension/browser recorder; check current capture constraints + upload path.]

**T12 — Meeting recorder: is the CLIENT's (remote participant's) voice being recorded? (investigation).**
Owner question: does the Meeting recorder capture the remote participant's audio, or only the local mic? Verify audio capture includes remote/system audio (tab audio / participants), not just the user's mic. If only mic → real gap to fix.

## DECISIONS (owner, grill round 1 — 2026-07-11)
- **T9 AI chat → BUILD BOTH VARIANTS AS A PROTOTYPE.** Old blue-button→modal + current inline, side by side via `?variant=`, share a link, mentor ("ustoz") picks. Then harden the winner. (→ `prototype` skill.)
- **T4b video→audio replace → IRREVERSIBLE WITH CONFIRM DIALOG.** Button → confirm → video deleted from storage, only audio kept, AI analysis retained. No undo. (Data-loss op → confirm copy must be explicit; blast-radius: storage delete + metadata.isAudio flip + player must then render audio.)
- **T8 tasks grouping → BY CATEGORY/THEME (AI decides).** AI groups the action items into themed sections (e.g. Sotuv/Marketing/Texnik).
- **PRIORITY (first wave): AI tahlil (T3,T7,T8,T9) + Recorder (T11,T12) + Import+narx (T2,T1).** Player cluster (T4,T5,T6,T10) = SECOND wave.

## RECON FINDINGS

### Player (T4/T5/T6/T10) — recon done
- Stack: native `<video>` via **media-chrome media-store**, **progressive MP4** (no HLS). Path: `s/[videoId]/page.tsx → Share.tsx → ShareVideo.tsx → DockableVideo.tsx → CapVideoPlayer.tsx → video/media-player.tsx`. Dead unused files: `AudioPlayer.tsx`, `HLSVideoPlayer.tsx`.
- **T4 (split video/audio):** ONE player; `metadata.isAudio` only paints a gradient+icon overlay on the SAME `<video>` (`CapVideoPlayer.tsx:753`). Split = branch on isAudio (or real audio component). isAudio set at ingest from `isAudioFile()` in `import/file/useImportUpload.ts:76`.
- **T5 (mobile seek):** NONE on the video surface — tap = play/pause only (`media-player.tsx:937-953`). ±5/±10s seek buttons exist but `hidden sm:inline-flex` (desktop-only). Drag-scrub only on the ~20px progress bar (`SegmentedProgressBar.tsx:184-195`). Must ADD a gesture layer (tap-thirds + swipe) dispatching MEDIA_SEEK_REQUEST.
- **T6 (resume position):** NOT persisted anywhere (grep confirmed). Only `?t=` deep-link seek (`Share.tsx:411-444`). Add write on timeupdate/pause/beforeunload keyed by videoId, restore on loadedmetadata (timeupdate listener already at `ShareVideo.tsx:306-329`).
- **T10 (pinned player mobile):** Player + tabs are in the SAME scrolling left column (`ShareVideo.tsx:763-868`), player scrolls away. `DockableVideo` IS a fixed floating mini-player but **desktop-only** (`min-width:1024px`, off on phone `:35-42,121-125`) and keeps the `<video>` mounted across dock (playback continuity already solvable). T10 = flip the mobile gate + add a Telegram-style pinned-top style.

### Import (T2) — recon done — MOSTLY ALREADY DONE
- `IMPORT_FILE_ACCEPT` already accepts video AND audio (`import/file/useImportUpload.ts:22-23`); both the standalone page and Caps one-step button use it; drag-drop `isMedia` allows audio; `isAudioFile()` sets `metadata.isAudio`. Duration probe tolerates no-dimensions (audio).
- REMAINING for T2: (a) rename button label "Import video"→"Import file" (`Caps.tsx:332`) + page copy "Upload a video file" (`ImportFilePage.tsx:60-63`); (b) server hard-codes `contentType:"video/mp4"` + `raw-upload.mp4` key + `source:webMP4` + default name "data365 Upload" (`create-for-processing.ts:69,73,97`) → an .mp3 stored under .mp4 key/type; **verify the processing worker handles audio** (thumbnail/transcode — `packages/web-backend/src/Videos`, `app/api/thumbnail/route.ts`); (c) `PreUploadTrimmer` is video-oriented — verify audio trims OK. → T2 = small labels + a few backend correctness spots + a LIVE audio-import verify.

### Recorder (T11/T12) — recon done — ⚠️ REAL TENSION
- MV3 extension. **T11 miss root:** the Meet popup path (`START_MEET`) is **pure TAB capture** (`offscreen/recorder.ts:104-116`, `sw.ts:393-431`) → structurally CANNOT see another window (a participant's shared screen). getDisplayMedia paths (in-page nudge, `recorder.html`, in-app `useWebRecorder`) CAN grab entire screen; only the in-app recorder FORCES monitor (`web-recorder-constants.ts:62-67`). MV3: full-screen getDisplayMedia must run in a visible page/content-script w/ user gesture, not the SW/offscreen.
- **T12 answer:** ONLY the extension TAB-capture path reliably records the **remote participant's audio** (it grabs the Meet tab's own audio, `offscreen/recorder.ts:110-128`). All getDisplayMedia paths capture "system/display audio" which on Windows + entire-screen usually returns NOTHING (in-app recorder even toasts this, `useWebRecorder.ts:923-941`). Mic = local only.
- **⚠️ T11 ↔ T12 DIRECT CONFLICT:** tab capture = remote audio but tab-locked (no full screen); entire-screen = the other window but drops remote/system audio on Windows. A correct fix must capture remote audio from a SEPARATE source (tab audio) and MIX it with the full-screen video. → **needs an owner direction decision (grill round 2).**

### Vazifalar grouping (T8) — recon done
- Tasks are FLAT objects `{title, assignee?, priority?, deadline?, done}` — **no category field** (Zod schema `generate-ai.ts:116-126`; `readTask` `:1582-1607` DROPS any extra key). Render: `TasksPanel.tsx:151-184` flat map.
- Owner chose "category/theme (AI)" → must extend pipeline in 3 places: Zod schema + `readTask` + both prompt JSON templates (`:1662`, `:1810/1826`), then render grouped. **Re-analysis needed to populate category on existing videos** (old videos stay flat until re-analyzed). Cheap fallback (group by existing `priority`, zero-backend) exists but owner wants themes.

### AI chat (T9) — recon done — old modal RECOVERABLE
- Old blue-button→modal existed: `AIChatPopup.tsx` (modal) + `AIFab.tsx` (blue-gradient FAB) + `ai-chat.css`. Removed in commit `21285ec`; last present at `967367f`. On-disk copy of `AIChatPopup.tsx` at `_deploy-baselines/ustoz-github-origin-main-e2d2aca/...` (FAB+css from git `967367f`).
- Current chat = inline in `SharePanel.tsx:414-520`, POSTs `/api/video/ai/chat` (unchanged, shared). Restore = front-end only. Owner chose PROTOTYPE both → `?variant=modal` vs `?variant=inline`.
- Chat error "Transcript index not ready" thrown `chat/route.ts:316-320` when `ensureTranscriptIndex` false (`transcript-index.ts:44-105`): no `transcription.vtt` or empty → i.e. transcription not finished / audio-only untranscribed. (Related to T7/T3.)

### AI pricing (T1) — recon + LIVE DB PROBE done — ANSWERED
- **Live probe of video `fm3pz7yref328m7`** (53-min meeting, `aiMode=fast`, NOT batched, transcriptionStatus COMPLETE): 43 ai_usage_events rows. **Total = $0.0727 (~7¢).** Transcription = 17 rows ALL `gemini-3.5-flash` at **$0** (free tier handled it). Summary/refine = 7 free ($0) + 19 paid `gemini-3-flash-preview` (~$0.001–0.008 each) = the whole ~7¢.
- **VERDICT: the displayed price is ACCURATE.** It looks cheap because free-tier `gemini-3.5-flash` transcribed the entire 53-min meeting at $0 (legitimate saving), and only summary/refine used the paid model. No undercount for this video.
- **⚠️ LATENT batch bug (real, not on this video):** in the durable Batch path, `audioInTokens` is derived only from `usageMetadata.promptTokensDetails.find(modality==="AUDIO")` (`gemini-batch-transcribe.ts:164-167`); if a Batch response omits that, audioInTokens→0 and the (mostly-audio) input is billed at the TEXT rate → with the 0.5 batch factor, ~2× UNDERCOUNT of the dominant cost. Same dependency in the sync path via `result.audioInTokens`. Batch is now live → worth hardening (verify against a real Batch usageMetadata payload; fallback: if audioInTokens==0, treat all input as audio for a transcription op).
- **Observation (quality, not price):** free-tier 3.5-flash SUMMARY failed/unusable for many chunks → fell through to paid (that's why summary has both free $0 + paid rows). Worth a separate look at free-summary usefulness. (Not a price bug — the free attempt is genuinely $0.)
- Display source: `MeetingCostPanel.tsx` → `getMonthlySpend` (current billing month only; a cross-month Batch collection could drop from the shown total — `route.ts:194` stamps month at collect time).

### AI status UI (T3/T7) — recon done
- All in `GenerateAiPanel.tsx` (`:196-370`). Stepper (Transkript/Xulosa/Tozalash/Tayyor) DERIVED from (`transcriptionStatus`, `aiGenerationStatus`, `aiProcessingStep`) — `:212-219`. Backend does NOT emit `aiProcessingStep` during transcription (`:206-211`).
- **ETA already exists but crude:** `etaMin = max(1, round((duration ?? 120)/120))` (`:243`). Real ETA needs chunk-rate.
- **"data365 AI" junk (T7):** `ShareVideo.tsx:792-794` renders a BARE `aiChatTitle="data365 AI"` chip with NO content, unconditionally on the Summary tab → the orphan chip. Overlaps the chat-header chip (`SharePanel.tsx:417`) + running badge (`GenerateAiPanel.tsx:254`). Fix = remove/re-gate `ShareVideo.tsx:792-794` + dedupe.
- **Fine-grained progress (T3):** transcription ALREADY persists `transcriptionChunksCompleted/Total` (`transcribe.ts:1516-1518`), shown "N/M" only on the Transcript tab (`ShareVideo.tsx:819-825`) — NOT in the stepper. Summary/refine has NO per-chunk counter (fan-out via `mapWithConcurrency` `generate-ai.ts:1649-1700,1486-1523`). Owner wants "1/8 audio sent to Gemini" live steps → lift the transcription counter into the stepper + add a new summary/refine counter (metadata written from inside mapWithConcurrency, analogous to `savePartialTranscription`) + rate-based ETA. `aiProcessingStep` type (`transcribe|summary|refined|done`) must widen for finer steps.

## DECISIONS (owner, grill round 2 — 2026-07-11)
- **T1 → FIX the latent batch undercount.** Display is otherwise correct (this video's $0.07 is real: free-tier transcription $0 + paid summary). Harden batch audioInTokens accounting.
- **T11/T12 recorder → "SMART" full approach.** Owner: he PRESENTS his own screen in Meet → his presented window must be recorded AND the client/remote audio must ALWAYS be recorded, together. So: capture his presentation via getDisplayMedia (screen/window, outside the browser tab) + ALWAYS capture the Meet remote audio (tab audio) + mic, MIX all into one recording. Not tab-only, not full-screen-without-remote-audio. This is extension (MV3) rework — the hardest task, likely its own design/prototype.

## Open clarifiers (hold for grill phase 3)
- T7: confirm it's the repeated empty "data365 AI" chips (UI), not a recordings list.
- Chat "Transcript index not ready" error — in scope to fix, or expected while analysis still running?
- T4b: replace-with-audio — irreversible? confirm dialog? applies to already-uploaded videos or new too?
- T3: which specific UI errors ("qo'pol UI xatolar") — need owner to point them out (screenshots) or I audit the analysis screen live.
- T6: resume position — per-device (localStorage) or synced across devices?
