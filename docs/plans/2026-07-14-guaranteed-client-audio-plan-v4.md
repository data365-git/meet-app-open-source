# Guaranteed client audio — meeting recording (v4, final)

**Identical to v3** (`2026-07-14-guaranteed-client-audio-plan-v3.md`) — which Codex
confirmed 6/8 must-fixes — EXCEPT the two sections below, rewritten to close the
last two Codex blockers. Requirement unchanged: client audio never silently lost
in an entire-screen meeting recording; fail loudly rather than ship it client-less.
Guarantee = capture-path health, not audio-level analysis.

Unchanged from v3 (still in force): invocation-based meeting mode; keep BOTH popup
buttons; persist `sourceTabId`+`meetingRequired` into RecordingState; SW re-verify
the meet URL before minting; `required:true` preserved in every failure branch;
fail-closed start with the deep liveness gate (`audioCtx.resume()` →
`state==="running"`, tab track `readyState==="live"`&&`!muted`, dest track live).

---

## FIX A — Nudge / auto-record (closes Codex blocker 1)

Codex: `chrome.action.openPopup()` gives NO official guarantee of granting
`activeTab`/`tabCapture`; only a direct user invocation of the extension action
does. So the nudge must NOT try to auto-start a guaranteed capture.

- **"Record now" and the auto-record countdown STOP capturing directly.** Remove
  the content-script `getDisplayMedia` capture path in `meet-detect.ts`
  (`:957`, `:1026`, `:1102`) — that is the current silent-loss path.
- They become a **reminder that directs the user to CLICK THE data365 ICON** —
  the only invocation that grants activeTab → the guaranteed recorder-tab meeting
  flow (popup "Record full-screen meeting"). Nudge text: "Yozish uchun data365
  belgisini bosing (mijoz ovozi kafolatli)."
- `chrome.action.openPopup()` MAY be attempted as a convenience where available,
  but the GUARANTEE rests on the icon-click path, never on openPopup. No code
  path records without a real action invocation.
- Net: the in-Meet one-click becomes a two-step (see nudge → click icon), but
  ZERO silent-loss paths remain. (Owner accepts the extra click as the price of
  the guarantee — surface this trade-off explicitly.)

## FIX B — Watchdog intentional-stop guard (closes Codex blocker 2)

Codex: `chrome.tabCapture.onStatusChanged` fires `stopped` on a NORMAL user Stop
too, so a naive watchdog would raise a false "audio lost" alert during an
ordinary stop while the SW is still `recording`.

- Add an **`intentionalStop` flag** set the instant ANY deliberate stop/disarm
  begins — user "Stop & upload" (recorder tab + pill), `MEET_CALL_ENDED`, tab
  close initiated by us, SW STOP. Set it BEFORE any teardown.
- Every loss signal — recorder-page tab-track `onended`/`onmute`(1.5s debounced)
  /`audioCtx.onstatechange`, and SW `tabs.onRemoved`/`onUpdated`(off meet URL) —
  raises the "client audio lost" alert **only when `intentionalStop` is false**.
- **`chrome.tabCapture.onStatusChanged` is treated as ADVISORY only**, fully
  gated by `intentionalStop`; the primary, trustworthy signals are the
  recorder-page track events + `tabs.onRemoved`/`onUpdated`. (If it proves noisy,
  drop it — the track/tab signals already cover real loss.)
- Finalize ordering from v3 stands: on a real loss, set the idempotent
  `tabAudioLost` flag → `recorder.stop()` only (no early `cleanup()`) → existing
  `pendingChunks`/`finishStop` finalizes the partial video → `TAB_AUDIO_LOST`
  makes the SW notify + badge "!" WITHOUT changing state to `error`
  (else `finalizeRecording()` bails at `sw.ts:330`).

---

## Verify (unchanged from v3)

esbuild EXIT 0; bump manifest version; repackage zip (Compress-Archive) + verify
version INSIDE it; no NEW real tsc errors; Codex approves plan then diff; owner
device tests (a)-(f) from v3 PLUS: (e') "Record now" nudge → shows "click the
icon" and never records without the icon; (g) normal user Stop → NO false
"audio lost" notification.
