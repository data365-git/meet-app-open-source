# SPEC — two-step in-page recording ("Record now" → screen picker)

> Written 2026-07-19 ~17:30, at the end of session n, BEFORE a /clear. Nothing
> here is built yet. This is the next session's first task.

## Why this exists
The owner's target: **click "Record now" in the Meet page → the screen picker
opens → done.** Two actions. Today it is three (`Ctrl+Shift+9` → "Boshlash" →
picker), because the recorder page's "Boshlash" click exists purely to supply
the user activation that `getDisplayMedia` requires.

An in-page click IS a real user gesture, so `getDisplayMedia` can be called
straight from the content script. The blocker was always the AUDIO: an in-page
gesture cannot grant `activeTab`, so `chrome.tabCapture` — today's source of the
remote participants' voices — is unavailable on that path.

## THE MEASUREMENT THAT UNBLOCKS IT (do not redo)
Probe `probeMeetAudio()` in `src/content/meet-detect.ts`, run by the owner on a
REAL Google Meet call while screen-sharing, 2026-07-19:

| run | window | result |
|---|---|---|
| 1 | flag-based (`track.muted`) | 4 elements, 3 with audio, "live" 0 — **inconclusive**, the call was silent |
| 2 | 6 s energy | 3 audio streams, peak **0.0%** — looked like a dead end |
| 3 | **60 s energy, someone actually speaking** | peak **≈20%** → **AUDIO IS REACHABLE** ✅ |

**Conclusion: `HTMLMediaElement.captureStream()` on Meet's own media elements
DOES deliver the remote participants' audio, with no permission and no
`activeTab` grant.** Run 2's 0.0% was simply "nobody spoke in a 6-second
window" — a false negative I nearly shipped as a decision. (Lesson: a
measurement window shorter than the human behaviour it measures produces a
confident wrong answer. The owner caught it: "6 second is less do it 60".)

## Design to build
1. **Trigger** — the in-page nudge's "Record now" button (a real gesture).
2. **Video** — call `navigator.mediaDevices.getDisplayMedia({video:{displaySurface:"monitor", width:{max:1920}, height:{max:1080}, frameRate:{max:24}}, audio:true})` directly in the content script. The picker opens immediately → step 2, done.
3. **Client audio** — `captureStream()` over every `audio`/`video` element in the Meet page; keep the streams whose audio tracks carry energy; mix them + the mic through an `AudioContext` (`TAB_AUDIO_GAIN` applies here too). **Meet creates and destroys these elements as people join/leave — re-scan on a `MutationObserver` and attach late arrivals mid-recording, or a participant who joins after the start is silent in the file.**
4. **Recording** — `MediaRecorder` in the content script (constants from `shared/recording-quality.ts`), chunks streamed to the SW over the existing `RECORDER_*` protocol, exactly as the recorder page does. Reuse, do not fork.
5. **Guarantees that MUST survive** (they are the whole product): the pre-start audio check, the "Mijoz ovozi olinmadi. Baribir boshlaymizmi?" confirm modal, the mid-recording watchdog, and the `speechEnd`/liveness warnings. The energy probe replaces `tabCapture`'s track check as the audio-present test: **require measurable energy before declaring client audio live** — a captured-but-silent element must NOT count as success.
6. **Keep the existing shortcut path** as-is and working. Ship the in-page path additively; if it fails on his machine, `Ctrl+Shift+9` still records correctly.

## Verify before claiming anything
- `e2e-audio-proof/run-proof.mjs` extended with an in-page-button variant (the fake Meet page plays the 440 Hz tone through an `<audio>` element so `captureStream` has something real to tap).
- Owner test on a real 2-person call: remote voice audible in the saved file, and the recording appears under **Meetings**.
- Only then remove `probeMeetAudio()` and its "Record now" hook.

## If it fails
Fall back in this order: **(B)** `chrome.desktopCapture.chooseDesktopMedia(['screen'], targetTab)` fired from the shortcut → picker appears immediately, two steps, audio still from `tabCapture` (the shortcut grants `activeTab`). ⚠️ A desktopCapture streamId can NOT be consumed in an offscreen document — consume it in a real tab. **(C)** Electron desktop app: `setDisplayMediaRequestHandler` + `audio:"loopback"` = Windows system audio with no checkbox, no tab dependency, no `activeTab` rule; one step; ~1-2 days for a working recorder.
