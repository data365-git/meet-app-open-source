# QA Flows — Ustoz Meeting Recording + UX/UI Deep Audit

## Core recording journey

| Phase | Happy path | Required failure/recovery states |
|---|---|---|
| Entry | Open extension while inside Meet | wrong tab, signed out, mic blocked, extension update, another recording active |
| Mode choice | Choose guaranteed full-screen meeting | tab-only alternative, wrong surface, picker cancel, remote-audio unavailable |
| Arming | Capture picker → audio guarantee → upload session ready | service worker asleep, tab-audio stream ID failure, zero audio tracks, upload-init failure |
| Recording | Visible timer, remote audio + mic, pause/resume, stop | tab muted, source tab closed/navigated, AudioContext suspended, recorder page closed, browser restart |
| Finalizing | Tail becomes durable, queued parts drain, multipart completes | offline stop, retry/dead-letter, duplicate completion, crash during tail PUT or completeMultipart |
| Success | Saved confirmation, open/copy link, dashboard visibility | processing delay, playback failure, recording-complete retry |
| Recovery | Honest state and safe next action | no destructive escape disguised as cancel/dismiss, no stale state blocking a new recording |

## UX/UI state checklist

- Idle: one obvious primary meeting action; alternative explained, not equal-weight ambiguity.
- Permission denied/picker cancelled: specific message and a safe retry.
- Remote audio missing: consequence stated in plain Uzbek before recording begins.
- Recording: persistent live status, timer, pause/resume, stop/save, audio-degradation warning.
- Paused: unmistakable visual state; timer frozen; privacy promise matches actual recorder state.
- Uploading/offline: says bytes are safe, retries automatically, and distinguishes close from permanent discard.
- Error: says whether bytes are safe, what retry does, and whether dismiss deletes anything.
- Complete: saved location and next action are obvious.
- Accessibility: keyboard focus, visible focus, semantic labels, live-region announcements, contrast, reduced motion.
- Language: consistent terminology across Uzbek web UI, English extension popup, and mixed-language recorder page.

## Product gaps versus test gaps

### Product gaps to verify

- Pause/resume delivery failure can diverge UI state from actual capture state.
- Uploading-state discard may not match its permanent-delete wording or clean server/retry artifacts.
- Visible recorder page may omit pause/resume even though the extension popup supports it.
- Mixed-language and weak accessibility semantics may make critical warnings easy to miss.

### Test gaps

- No real-device test proves captured remote speech, tab-mute behavior, pause privacy, browser-restart recovery, and playback-to-end.
- No extension UI state screenshot/a11y suite covers idle, recording, paused, offline upload, error, and complete.
- No mobile live proof is available for the public watch page in the current in-app browser session.
