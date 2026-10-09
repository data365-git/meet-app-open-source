# Guaranteed client audio — meeting recording (v2, post Codex review #2)

**Owner requirement (hard):** admin shares his ENTIRE SCREEN in a Meet and
presents; the client keeps talking. The client's voice MUST be in the recording.
Silent loss is unacceptable — better to FAIL LOUDLY (don't start / stop) than
ship a client-less meeting recording.

**Supersedes v1** (`2026-07-14-guaranteed-client-audio-plan.md`). Codex
(gpt-5.6-sol) rejected v1's F2 assumption — *seeing* a tab's URL (`tabs`
permission) is NOT permission to *capture* its audio (`tabCapture` needs the
extension invoked ON that tab / activeTab). This v2 removes cross-tab minting and
makes the guarantee real: **fail-closed at start + hard-stop mid-recording +
deep liveness gate.**

## Principle

The guarantee is **capture-path health**, NOT audio-level analysis. A silent
client (not speaking) is normal and leaves the tab-audio track `live`+unmuted;
we NEVER try to detect "is the client speaking". We only enforce: for a meeting
recording, a HEALTHY client-audio capture path exists at start and stays healthy
— else the recording does not start / does not continue.

## Mode is EXPLICIT, never URL-guessed

- **Meeting mode** = the popup was opened ON a Meet tab (`meet.google.com/<id>`).
  That invocation grants activeTab on the Meet tab → we can mint a tabCapture
  streamId for it. The popup shows a distinct primary button:
  **"Record meeting (full screen)"** → `START_INSTRUCTION{sourceTabId, meeting:true}`.
- **Plain instruction** = popup opened on any non-Meet tab → **"Record screen"**
  → `START_INSTRUCTION{}` (no sourceTabId, no client-audio requirement, today's
  behavior, screen+mic+optional system audio). No regression.
- **Non-Meet tab but a Meet exists elsewhere:** the popup MAY show a hint
  "You have a meeting open — open it and press Record there" (via `tabs.query`
  for `meet.google.com/*`, read-only, just to focus that tab). We do NOT
  auto-capture it. Guidance only.

## Failure modes and required behavior

| # | Failure | v2 behavior |
|---|---------|-------------|
| F1 | Meeting mode, but tab-audio streamId mint fails / getUserMedia throws / 0 audio tracks | **Fail-closed:** stop+close every stream, `INSTRUCTION_CANCEL`→SW→idle, NO upload session created, blocking error view: "Mijoz ovozini ulab bo'lmadi — Meet tabini yangilab, qaytadan boshlang." |
| F2 | Meeting mode, tab-audio track acquired but NOT healthy (`readyState!=="live"` or `muted` or `audioCtx.state!=="running"` after `resume()`) | **Fail-closed** (same as F1) — a dead/muted track is not a guarantee. |
| F3 | Track dies MID-RECORDING (Meet tab closed/navigated/crashed → tab-audio `ended` or `mute`) | **Hard stop + finalize** the recording so far (video is still valuable) + `chrome.notifications.create` + recorder banner + badge "!". `mute` debounced ~1.5s to ignore transient blips; `ended` is terminal → immediate. |
| F4 | arming overwrite race (2nd start while picker open) | already guarded (Codex #1 fix: `REQUEST_TAB_AUDIO` requires `consumerTabId===state.recorderTabId`). Keep. |
| F5 | Plain instruction recording (no meeting) | unchanged: screen+mic, optional shared system audio, no blocking. |

## Exact changes (surgical, all in apps/browser-extension/src)

1. **popup.ts** — button label + explicit flag. On a Meet tab, primary button
   "Record meeting (full screen)" sends `{type:"START_INSTRUCTION", sourceTabId,
   meeting:true}`. Off a Meet tab, "Record screen" sends `{type:"START_INSTRUCTION"}`.
   Optional hint if a Meet exists elsewhere (tabs.query, focus only).
2. **sw.ts** — `START_INSTRUCTION` stores `sourceTabId` + a `meetingRequired`
   boolean in arming state. `REQUEST_TAB_AUDIO` returns
   `{streamId, required: meetingRequired}` (so the recorder knows blocking vs
   optional). Keep the `consumerTabId===recorderTabId` guard. New
   `TAB_AUDIO_LOST` handler → `chrome.notifications.create` + badge "!";
   badge cleared on stop/idle.
3. **state.ts** — add `meetingRequired?: boolean` to ArmingState/RecordingState.
4. **recorder-page.ts** — the core:
   - After getDisplayMedia + mic, `REQUEST_TAB_AUDIO`. If `required` and
     (no streamId | getUserMedia throws | 0 audio tracks) → **fail-closed**:
     cleanup, `INSTRUCTION_CANCEL`, `view-error` with the message, return.
   - **Liveness gate BEFORE `recorder.start()`**: `await audioCtx.resume()`;
     assert `audioCtx.state==="running"`, tab track `readyState==="live"` &&
     `!muted`, and the `dest.stream` audio track is live. If `required` and any
     fail → fail-closed. (Non-meeting: gate is advisory, still records.)
   - Echo fix retained (skip system audio when tab audio present).
   - **Mid-recording watchdog**: on the tab track, `onended`→stop now;
     `onmute`→setTimeout 1.5s, re-check `muted`; if still muted→stop. On stop
     from watchdog: send `TAB_AUDIO_LOST`, show banner, finalize normally
     (pendingChunks flush already handles a clean stop).
   - cleanup already stops tabAudioStream.
5. **recorder.html** — reuse `#rec-audio-warn` as the mid-recording red banner;
   the fail-closed path reuses `view-error` (already exists).

## Explicitly OUT of scope (Phase 2, flagged not silently dropped)

- **Meet nudge "Record now"** (content-script `getDisplayMedia`, `meet-detect.ts`)
  is a SEPARATE capture path with the SAME client-audio gap. Applying the guarantee
  there (content-script requests a tabCapture streamId for its own tab from the SW,
  same fail-closed/watchdog) is Phase 2 — do it after Phase 1 is device-confirmed,
  to keep this diff reviewable. Owner decides timing.
- **START_MEET** (offscreen tabCapture, records the Meet-tab video not the screen)
  is untouched and already captures client audio reliably — no regression.

## Verify

- esbuild build EXIT 0; bump manifest version; repackage zip (Compress-Archive).
- No NEW real tsc errors (pre-existing non-module RecordingState noise ~52-54 only).
- **Codex (gpt-5.6-sol) reviews THIS plan, then the diff** — build only after
  plan APPROVE.
- Owner device test (the only real oracle): (a) meeting mode, client talking +
  admin presenting fullscreen → client voice in file; (b) meeting mode, kill the
  Meet tab mid-recording → recording stops + notification; (c) meeting mode but
  deny/blocked audio → recording does NOT start, clear message; (d) plain screen
  recording from a non-Meet tab → works as before.
