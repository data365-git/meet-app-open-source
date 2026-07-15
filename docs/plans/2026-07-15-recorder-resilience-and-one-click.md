# Plan — recorder resilience + one-click screen (extension v0.3.2)

Owner-decided direction (2026-07-15). Reverses part of the earlier fail-closed
"guaranteed client audio" behavior in favor of never-stop + warn + auto-recover.
All three items are device-test-gated (owner is the oracle on a real Meet).

## Owner decisions
1. Start with no client audio → **confirm once, then start** (not silent abort).
2. Mid-recording client-audio loss → **do NOT stop**; warn + auto-recover when possible.
3. Convenience → **one-click whole-screen picker** (only-screen, no window/tab tabs).

## Current behavior (to change) — `apps/browser-extension/src/recorder/recorder-page.ts`
- `failClosedStart()` (~L223) aborts the start when `meetingRequired && !haveTabAudio`.
- `handleTabAudioLoss()` (~L59) STOPS the MediaRecorder + saves partial on tab-audio
  loss. Triggered by: `tabTrack.onended`, a muted poll (`tabTrack.muted`),
  and `audioCtx.state !== "running"` (~L480-491).
- `intentionalStop` guards deliberate stops; `tabAudioLost` makes loss idempotent.

## Changes

### Item 1 — Start: confirm instead of abort
File: `recorder-page.ts`.
- On the `meetingRequired && !haveTabAudio` branch (~L347), instead of `failClosedStart`,
  show an in-page confirm modal on recorder.html: "Mijoz ovozi olinmadi. Baribir
  boshlaymizmi?" → [Boshla] / [Bekor].
  - Boshla → proceed to record screen+mic (no tab audio), show a persistent
    "mijoz ovozi olinmayapti" warning banner for the whole recording.
  - Bekor → current cleanup + close.
- Also handle the second fail-closed point (~L383-396, tab track dead at start) the
  same confirm way.
- Verify: open on a non-Meet tab → confirm appears; Boshla records screen+mic +
  banner; Bekor aborts cleanly.

### Item 2 — Mid loss: keep recording + warn + auto-recover
File: `recorder-page.ts` (+ maybe `sw.ts` for re-capture).
- Rework `handleTabAudioLoss` → `handleTabAudioDegraded(cause)`; do NOT stop the recorder.
- Classify cause and act:
  - muted → keep recording, banner "mijoz ovozi o'chirilgan — Meet tab ovozini yoqing";
    listen for unmute → clear banner (same track resumes).
  - audioCtx suspended → `audioCtx.resume()`; clear banner on success.
  - ended (tab closed/navigated) → attempt ONE re-capture via SW `REQUEST_TAB_AUDIO`;
    success → splice new stream into the audioCtx mix + clear banner; fail → persistent
    banner "Meet tab yopildi — qayta oching yoki yozuvni to'xtating", keep recording (screen+mic).
- Keep `intentionalStop` semantics: deliberate stops (Stop button, SW STOP_CAPTURE,
  tab close of the recorder tab) still stop. Only tab-AUDIO loss changes to non-fatal.
- Verify: mute Meet tab mid-record → banner + recording continues → unmute → banner clears.
  Close Meet tab → banner "reopen", recording continues.

### Item 3 — One-click whole-screen picker
File: `sw.ts` (capture path) + wiring.
- Replace the screen `getDisplayMedia` step with
  `chrome.desktopCapture.chooseDesktopMedia(['screen'], sourceTab, cb)` → streamId →
  `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId } } })`.
  Picker then offers only whole screens = one click.
- PRESERVE the separate Meet tab-audio capture (unchanged) and the mic mix.
- Verify: click record → picker shows only screens → one click → recording starts;
  meeting audio still captured.

## Blast-radius / risks
- Touches the core capture path + the guarantee logic Codex+Sonnet built over 4 review rounds.
- Item 3 changes screen capture from `getDisplayMedia` to `desktopCapture`; must not break
  the tab-audio capture or the "Record full-screen meeting" flow.
- `chooseDesktopMedia` needs the `desktopCapture` permission in manifest (verify/add).
- Everything is device-test-gated on a real Meet — owner verifies after the zip ships.

## Ship sequence
manifest 0.3.1 → 0.3.2 · `node scripts/build.mjs` EXIT 0 · rebuild+verify zip ·
commit · deploy (push qa-fixes + Contabo trigger) · owner reinstalls + device-tests.
