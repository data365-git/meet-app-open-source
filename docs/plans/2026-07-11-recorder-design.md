# Ustoz Meet Recorder — smart capture redesign (T11/T12) — 2026-07-11

Design for Stream E (NOT started — build AFTER wave 1 + a prototype spike). Research date 2026-07-11 (Chrome MV3). Owner decision: when he PRESENTS his own screen in a Meet, the recording must capture BOTH his presented screen/window (outside the browser tab) AND ALWAYS the remote participant audio AND his mic, mixed into one file.

## Current state (3 paths, verified)
All paths converge on the same SW upload pipeline (`RECORDER_STARTED → RECORDER_CHUNK → RECORDER_STOPPED`, `sw.ts:776-847` → `upload.ts:411-639`). They differ in WHERE the stream is built:
1. **Popup "Record Meeting" (`START_MEET`)** → `chrome.tabCapture.getMediaStreamId` (`sw.ts:412`) → offscreen `getUserMedia({video:{chromeMediaSource:"tab"}})` (`offscreen/recorder.ts:103-128`). **TAB VIDEO only → misses the presented out-of-tab window.** But tab capture DOES reliably carry remote audio, mixed at `recorder.ts:151-169`.
2. **In-page Meet nudge "Record now"** → `getDisplayMedia` in the content script (`meet-detect.ts:970-977`) → CAN grab the whole screen, but records in the content script with **getDisplayMedia audio (unreliable on Windows entire-screen)** → often screen video + mic only, no remote voices.
3. **"Record Instruction"** → `getDisplayMedia` in a visible `recorder.html` tab (`recorder-page.ts:155-162`). Same audio limitation; fine for instructions.
- Dead: `MEET_NUDGE_RECORD_NOW` handler (`sw.ts:660-717`) is never sent (type only, `meet-detect.ts:35`) — remove.

**Core defect:** no path combines out-of-tab screen video + reliable tabCapture remote audio.

## MV3 feasibility findings (web-researched)
- **(a) Can't split video-here / audio-there and mix.** A `MediaStream`/`MediaStreamTrack` cannot cross JS contexts (content-script ↔ offscreen); `chrome.runtime` messaging only carries serializable data — that's WHY tabCapture returns a *stream id* string. → both tracks feeding one `MediaRecorder` must be acquired in the SAME context.
- **(b) getDisplayMedia entire-screen audio is unreliable on Windows** (tab-audio is offered only in the *Chrome Tab* pane, not *Entire Screen*; full-screen system audio is version/OS-dependent). → get remote audio from `chrome.tabCapture` of the Meet tab (reliable), treat getDisplayMedia audio as ignored.
- **(c) The MV3 pattern = acquire everything in ONE context + record there.** Chrome's guide states `getDisplayMedia` **can run in an offscreen document** using the offscreen reason **`DISPLAY_MEDIA`**. So one offscreen context can hold screen video + tab audio + mic.
- **(d) Gotchas:** tabCapture-id→offscreen needs Chrome 116+; the stream id is single-use and expires in seconds (redeem immediately); `getMediaStreamId` needs a user gesture (current code bounces via popup). Offscreen doc is currently created with reason `USER_MEDIA` only (`sw.ts:72-76`) → must add `DISPLAY_MEDIA`.
- **⚠️ THE make-or-break unknown:** `getDisplayMedia` needs transient activation; an offscreen doc has no gesture. The `DISPLAY_MEDIA` reason exists precisely to enable offscreen getDisplayMedia, but reports are mixed on whether the picker actually appears/resolves. **This must be proven by a prototype before committing.**
- **Echo:** capturing the Meet tab audio and re-routing it to speakers from INSIDE the Meet tab feeds back → echo. The offscreen doc avoids this (its replay context isn't captured) — which is why the current Path-1 re-route (`recorder.ts:157-159`) is safe. → offscreen is the correct home.

## Chosen architecture
**Primary — Design B: "everything in the offscreen document".**
1. SW (on user gesture) mints tab-audio id: `getMediaStreamId({targetTabId: meetTabId})` — as today.
2. SW creates offscreen with **`reasons:[DISPLAY_MEDIA, USER_MEDIA]`**, posts `START_CAPTURE {streamId, micEnabled, micDeviceId, wantScreenVideo:true}`.
3. Offscreen: **screen video** = `getDisplayMedia({video:{…}, audio:false})`.
4. Offscreen: **remote audio** = `getUserMedia({audio:{mandatory:{chromeMediaSource:"tab", chromeMediaSourceId:streamId}}})` (audio only — drop the video branch).
5. Offscreen: **mic** = `getUserMedia({audio})` — as today.
6. Mix with the existing AudioContext recipe (`recorder.ts:151-169`): tab-audio→dest, tab-audio→destination (audible replay, safe here), mic→dest; record `[displayStream videoTrack, dest audioTrack]` → one MediaRecorder. Downstream unchanged.

**T11↔T12 resolution:** the `DISPLAY_MEDIA` offscreen reason is Chrome's sanctioned way to run getDisplayMedia from offscreen; IF the picker resolves, T12's "must be a visible tab" premise is false for this API → tension dissolves in favor of offscreen (T11). The gesture requirement is the single gating unknown → prototype.

**Fallback — Design A′: dedicated visible `recorder.html` tab.** Reuse the proven page (getDisplayMedia on button click), AND capture the Meet tab audio via `getMediaStreamId({targetTabId: meetTabId, consumerTabId: recorderTabId})` (a chosen tab redeems another tab's capture → no echo). Cost: extra visible tab + a second picker. Use only if the prototype falsifies offscreen getDisplayMedia.

**Do NOT** attempt content-script video + offscreen audio (can't mix across contexts; content-script audio path echoes).

## Prototype FIRST (~1hr throwaway, device-only) — the gate before the rewrite
Prove on the owner's Windows Chrome, in the offscreen doc:
1. `createDocument({reasons:[DISPLAY_MEDIA,USER_MEDIA]})` + offscreen `getDisplayMedia({video:true,audio:false})` **shows a picker and resolves a track** (not `InvalidStateError: user gesture`). Trigger immediately after a popup/nudge click to see if activation carries. **Make-or-break for Design B.**
2. Simultaneously redeem a SW-minted tabCapture id via `getUserMedia(chromeMediaSource:"tab", audio only)` in the same offscreen doc → live audio track while the video track is live (coexistence).
3. Mix both + mic → one MediaRecorder for ~5s → playable file where you HEAR the remote participant + SEE the presented out-of-tab window + NO echo.
4. Picker UX acceptable (which monitor; cancelable).
If (1) fails or (4) unacceptable → switch to Design A′ (prototype the `consumerTabId` redemption in `recorder.html`).

## File-level plan (Design B; apps/web untouched)
1. **`src/background/sw.ts`** — `ensureOffscreenDocument` (`:67-77`) add `DISPLAY_MEDIA` reason; `START_MEET` (`:393-431`) keep `getTabMediaStreamId` (`:412`), add `wantScreenVideo:true` to `START_CAPTURE`. Recommended: repoint the Meet nudge to this offscreen flow (so it gets reliable remote audio) → then `MEET_NUDGE_CAPTURE_READY` (`:722-759`) + the `contentRecorderTabId` routing (`:442-466,471-549,566-610,641-657,1115-1131`) can be removed. Delete dead `MEET_NUDGE_RECORD_NOW` (`:660-717`) + type (`meet-detect.ts:35`).
2. **`src/offscreen/recorder.ts`** (heart) — extend `StartCaptureMsg` (`:19-24`) with `wantScreenVideo?`; in `startCapture` (`:90-268`) add `getDisplayMedia({video:{caps like recorder-page.ts:156-161}, audio:false})` (handle cancel/`NotAllowedError` → `RECORDER_ERROR`); change the tabCapture `getUserMedia` (`:103-128`) to AUDIO ONLY (`tabAudioStream`); rework the mix (`:151-169`) → `recordStream = new MediaStream([...displayStream.getVideoTracks(), ...dest.stream.getAudioTracks()])`; update `cleanup` (`:84-88`), the `onended` stop-hook (`:224-231`), `RecordingState` (`:44-50`) to track both streams; keep the "wait for RECORDER_STARTED before recorder.start(200)" ordering (`:238-257`).
3. **`src/content/meet-detect.ts`** — if nudge repointed: remove `startNudgeRecording` getDisplayMedia+MediaRecorder body (`:957-1144`), `nudgeRecorder` machinery (`:66-72,159-167,948-955`), local STOP/PAUSE/RESUME (`:1249-1262`); button just sends a start message, pill driven by `STATE_CHANGED`.
4. **`manifest.json`** — no new permission (`tabCapture`, `offscreen`, `activeTab`, `tabs` present `:22-33`); offscreen reasons are passed at createDocument.
5. **No change** to `upload.ts`, `popup.ts`, `recorder-page.ts` (instruction path stays), `build.mjs`, `offscreen.html`.
If A′ instead: changes concentrate in `sw.ts` (mint id with `consumerTabId`, open/route to recorder.html for meetings) + `recorder-page.ts` (add tabCapture audio-only getUserMedia + mix); offscreen stays on Path 1.

## Verification
- **Unit/logic (no device):** START_CAPTURE payload carries `wantScreenVideo`; SW arming→recording on RECORDER_STARTED; mime pick; chunk-serialization queue (`enqueueRecorder`, `sw.ts:314-322`); offscreen `reasons` includes DISPLAY_MEDIA (assert on createDocument arg). MediaRecorder/getDisplayMedia/getUserMedia/AudioContext are NOT unit-testable — device only.
- **Device-only (owner — the real gate):** build `pnpm --filter @cap/browser-extension build` → chrome://extensions → Load unpacked `dist/` (reload after every rebuild) → real Meet with a 2nd participant, present a window that is NOT the Meet tab → record → confirm all three (presented window visible, remote audible, mic audible, NO echo). Negatives: cancel picker → clean error + lock released; sub-`MIN_VIABLE_BYTES` rejected (`upload.ts:507-518`); eviction mid-record still finalizes (`sw.ts:1060-1088`).

## Sources
Chrome docs: [tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) · [screen-capture how-to](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) · [offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) · [screen-sharing controls](https://developer.chrome.com/docs/web-platform/screen-sharing-controls/). Community: [offscreen getDisplayMedia caveats](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/3RanHldyp9c) · [recall.ai build-a-recording-extension](https://www.recall.ai/blog/how-to-build-a-chrome-recording-extension) · [addpipe getDisplayMedia demo](https://addpipe.com/getdisplaymedia-demo/) · [Chrome 137 full-screen audio](https://support.google.com/chrome/thread/349572226) · [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia). In-repo: `apps/web/.../useWebRecorder.ts:923-943` documents the Windows full-screen system-audio limitation.
