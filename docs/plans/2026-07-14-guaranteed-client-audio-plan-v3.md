# Guaranteed client audio — meeting recording (v3, folds in Codex review #2)

**Owner requirement (hard):** admin shares his ENTIRE SCREEN in a Meet and
presents; the client keeps talking. The client's voice MUST be in the recording.
Fail LOUDLY (don't start / stop) rather than ship a client-less recording.

Supersedes v1/v2. v3 folds in Codex's 8 must-fixes on v2. **Guarantee = capture-
path health, never audio-level analysis** (a silent client is normal; only
track/tab/context DEATH is failure).

## Mode (Codex #1) — explicit, invocation-based

Meeting mode is set ONLY when the user invokes the extension ACTION (popup/icon)
while ON a Meet tab — that is what grants activeTab → tabCapture. Never inferred
from "a Meet exists somewhere".

## Popup affordances (Codex #7) — keep BOTH, distinct labels

- On a Meet tab, show TWO explicit buttons (do not delete the existing one):
  - **"Record full-screen meeting"** → `START_INSTRUCTION{sourceTabId, meeting:true}` (guaranteed path, entire screen + client audio).
  - **"Record Meet tab only"** → existing `START_MEET` (offscreen tabCapture, tab video). Untouched.
- Off a Meet tab: **"Record screen"** → `START_INSTRUCTION{}` (plain, no client-audio requirement, today's behavior).

## SW state (Codex #4) — persist through to `recording`

Add `sourceTabId?` + `meetingRequired?` to BOTH ArmingState AND RecordingState
(`state.ts`), and copy them in the `RECORDER_STARTED`→recording transition
(`sw.ts`) so mid-recording handlers/watchdogs have them.

## Start path — fail-closed (Codex #2, #5)

`recorder-page.ts`, meeting mode (`required===true`):
1. getDisplayMedia (screen) + mic as today.
2. `REQUEST_TAB_AUDIO`. **SW re-verifies** the sourceTab still exists AND its URL
   is still `meet.google.com/*` (Codex #2) before minting; returns
   `{streamId, required:true}` — and **`required:true` is preserved in EVERY
   failure branch** (streamId null still returns `required:true`) (Codex #5).
3. getUserMedia(tab audio). If streamId null OR getUserMedia throws OR 0 audio
   tracks → **fail-closed**: cleanup all streams, `INSTRUCTION_CANCEL`→SW→idle,
   NO upload, `view-error`: "Mijoz ovozini ulab bo'lmadi — Meet tabini yangilab,
   qaytadan boshlang."
4. **Liveness gate before `recorder.start()`** (Codex #2): `await audioCtx.resume()`;
   require `audioCtx.state==="running"`, tab track `readyState==="live"` &&
   `!muted`, and the `dest.stream` audio track live. Any fail (meeting mode) →
   fail-closed. **Note (Codex "dars"): a live track proves the browser hasn't
   closed the media object — NOT that audio is truly flowing.** So we ALSO keep
   the mid-recording watchdog as the ongoing guarantee, not just the start gate.
5. Plain mode: gate is advisory; recording proceeds (no regression, Codex #5).

## Mid-recording watchdog (Codex #3, #6) — the ongoing guarantee

Signals (belt-and-suspenders, all wired):
- **recorder-page.ts:** tab track `onended` (terminal → act immediately) and
  `onmute` (debounce 1.5s, re-check `.muted` — ignores transient Meet blips;
  a normal SILENT client does NOT mute a tabCapture track, so this won't
  false-trip); `audioCtx.onstatechange` (suspended/closed while running).
- **sw.ts:** `chrome.tabs.onRemoved`/`onUpdated` for `sourceTabId` (tab closed or
  navigated off the meet URL) and `chrome.tabCapture.onStatusChanged` if
  available.

On a confirmed loss (Codex #6 — exact ordering to not corrupt finalize):
- **idempotent** (a `tabAudioLost` flag; fire once).
- call `recorder.stop()` ONLY — do NOT `cleanup()` the streams first; let the
  EXISTING `pendingChunks`/`finishStop` flow finalize the already-recorded video
  (recorder-page.ts:266-309).
- send `TAB_AUDIO_LOST` to SW → SW does `chrome.notifications.create` + badge
  "!" ONLY. It **must NOT set state to `error`** — that would make
  `finalizeRecording()` bail (`state.kind!=="recording"`, sw.ts:330). Badge
  cleared on stop/idle.
- recorder tab shows the red banner (reuse `#rec-audio-warn`).

Result: the presenter (fullscreen) gets a system notification the instant the
client audio dies; the partial recording (with client audio up to that point) is
saved, not lost.

## Nudge "Record now" (Codex #8) — close the hole in THIS release

The in-Meet "Record now" (`meet-detect.ts:957`) currently does content-script
`getDisplayMedia({audio:true})` → display+mic only → uploads with NO client-audio
guarantee (`meet-detect.ts:1026,1102`). An in-page button canNOT get a tabCapture
grant (needs the extension ACTION invoked), so it cannot capture tab audio
directly. Fix in THIS release (no silent-loss path left):
- **"Record now" no longer captures directly.** It routes to the guaranteed
  flow: stash a pending-start in `chrome.storage` + `chrome.action.openPopup()`
  (Chrome 127+) so START runs in the popup context that HAS activeTab → the
  guaranteed recorder-tab meeting path. On older Chrome (no openPopup), show
  "Click the data365 icon to record (guaranteed audio)".
- Remove/disable the content-script `getDisplayMedia` capture in the nudge.
  (Auto-record countdown likewise ends by routing to the guaranteed flow, not a
  direct capture.)

## Verify

- esbuild build EXIT 0; bump manifest version; repackage zip (Compress-Archive);
  verify version/marker INSIDE the zip.
- No NEW real tsc errors (pre-existing non-module `RecordingState` noise ~52-54).
- **Codex (gpt-5.6-sol) approves THIS plan, then the implementation diff** —
  build only after plan APPROVE.
- Owner device test (only real oracle): (a) full-screen meeting, client talking +
  admin presenting → client voice in file; (b) kill Meet tab mid-recording →
  recording stops + notification + partial saved; (c) audio blocked at start →
  recording does NOT start, clear message; (d) plain screen record (non-Meet) →
  unchanged; (e) "Record now" nudge → routes to guaranteed flow, no silent-loss;
  (f) "Record Meet tab only" still works.
