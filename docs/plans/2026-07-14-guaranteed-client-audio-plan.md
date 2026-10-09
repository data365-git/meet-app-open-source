# Guaranteed client audio in entire-screen meeting recordings

**Owner requirement (2026-07-14):** during a meeting the admin shares his ENTIRE
SCREEN and presents; the client keeps talking. The client's voice MUST be in the
recording — silent loss is unacceptable. Today the tab-audio capture is
fail-open: any failure → mic-only recording + a warning the presenter (who is
fullscreen-presenting) will likely never see.

## Current state (after 1527eda + 533a667)

- Popup on a Meet tab → `START_INSTRUCTION{sourceTabId}` → SW stores it in
  arming state → recorder page `REQUEST_TAB_AUDIO` → SW mints a
  consumerTab-scoped tabCapture streamId → recorder mixes tab audio (client)
  with screen video + mic. Echo/race/privacy fixed after Codex review #1.
- Failure at ANY of these steps → recording continues mic-only (fail-open),
  warning only inside the recorder tab.

## Failure modes to close

| # | Failure | Today | Must become |
|---|---------|-------|-------------|
| F1 | Tab-audio capture fails AT START (streamId error, getUserMedia error, no audio track) | records mic-only + quiet warning | **BLOCK start** (fail-closed): clear message + don't begin a client-less meeting recording |
| F2 | User starts entire-screen recording from a NON-Meet tab while a Meet call is open in another tab | no tab audio at all (privacy fix scoped it to Meet-active-tab) | **capture the Meet tab's audio anyway** (find it), or if ambiguous → block with "start from the Meet tab" |
| F3 | Tab-audio track DIES MID-RECORDING (Meet tab closed / navigated / crashed) | recording silently degrades to mic-only | **loud alert**: chrome notification + recorder-tab banner + badge; keep recording (video still valuable) but the presenter is told NOW, not after |
| F4 | Meet tab present but sourceTabId lost due to arming overwrite race | guarded (Codex fix: recorderTab check) — sourceTab still from state | covered by F1 block if minting fails |

## Design decisions

- **Fail-closed only when we KNOW it's a meeting** (sourceTabId present or a
  Meet tab exists). A plain instruction recording with no Meet tab anywhere
  keeps today's behavior (screen+mic, optional system audio) — no regression.
- **F2 via tab query, not activeTab:** manifest has `host_permissions:
  https://*/*` + `tabs`, so the SW can `chrome.tabs.query` for
  `https://meet.google.com/*` and mint a streamId for that tab even when the
  popup wasn't opened on it. If MULTIPLE Meet tabs → don't guess: block with
  "open your meeting tab and start from there".
- **F3 keeps recording** (auto-stop would kill the video of the presentation
  too — worse). Loud = `chrome.notifications.create` (permission already in
  manifest) + red banner in recorder tab + `chrome.action.setBadgeText("!")`.
- **No audio-level analysis** (AnalyserNode silence detection): a quiet client
  is normal; only track `ended`/`mute` events are trustworthy signals.

## Changes (surgical)

1. **sw.ts — START_INSTRUCTION:** if no `sourceTabId` from popup, query for
   `meet.google.com` tabs: exactly one → use its id as `sourceTabId`;
   more than one → return `{ok:false, error:"multiple meetings — start from the
   meeting tab"}` (popup shows it); zero → proceed (plain recording).
2. **recorder-page.ts — start gate:** if the SW says this is a meeting
   (`REQUEST_TAB_AUDIO` returns `{streamId}` expected), and tab-audio
   acquisition FAILS or yields 0 audio tracks → `stop everything`, show a
   blocking error view: "Mijoz ovozini ulab bo'lmadi — Meet tabini yangilab,
   qaytadan boshlang." Do NOT fall through to mic-only. (Response shape gains
   `{streamId, required:true|false}` so the recorder knows blocking vs plain.)
3. **recorder-page.ts — mid-recording watchdog:** on the tab-audio track,
   listen for `ended` + `onmute`: show the red banner AND send
   `TAB_AUDIO_LOST` to SW.
4. **sw.ts — TAB_AUDIO_LOST handler:** `chrome.notifications.create` ("Mijoz
   ovozi uzildi — yozuv davom etmoqda, lekin ovozsiz!") + badge "!". Clear
   badge on stop.
5. **recorder.html:** the existing `#rec-audio-warn` strip reused for the
   mid-recording banner; new blocking error path reuses `view-error`.

## Verify

- esbuild build EXIT 0; no new REAL tsc errors (pre-existing non-module noise
  stays 52-54).
- Logic review by Codex (gpt-5.6-sol) — this plan, then the diff.
- Owner device test (only real oracle): (a) start from Meet tab with client
  talking + admin presenting fullscreen → voice recorded; (b) close the Meet
  tab mid-recording → notification appears; (c) start with Meet tab open but
  from another tab → still captures client audio (F2); (d) no Meet anywhere →
  plain recording works as before.
