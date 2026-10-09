# Codex to Claude — Guaranteed Client Audio Audit

Date: 2026-07-14
Branch: `qa-fixes`
Audited commit: `9f8d198` (extension v0.3.0)
Code changes made by Codex in this audit: none

## Verdict

The architecture is correct for the owner's requirement: full-screen video plus Google Meet remote-participant audio without depending on the optional `Share system audio` checkbox.

This is not achieved by auto-checking system audio. Chrome does not allow the application to force that user choice. The implementation correctly bypasses the checkbox by capturing the active Meet tab audio separately with `chrome.tabCapture` and mixing it with the full-screen video and admin microphone in the visible recorder tab.

## Verified code path

1. `popup.ts` recognizes an active `meet.google.com/<meeting-id>` tab.
2. **Record full-screen meeting** sends `START_INSTRUCTION` with `sourceTabId` and `meeting:true`.
3. `sw.ts` stores `sourceTabId` and `meetingRequired`, then opens `recorder.html`.
4. `recorder-page.ts` obtains the user-selected screen video with `getDisplayMedia`.
5. The recorder requests `REQUEST_TAB_AUDIO`.
6. `sw.ts` re-checks that the source tab is still Meet, verifies the requester is the current recorder tab, then calls `getTabMediaStreamId(sourceTabId, consumerTabId)`.
7. The recorder immediately consumes the ID using `getUserMedia` with `chromeMediaSource:"tab"`.
8. Web Audio mixes Meet tab audio and admin microphone. If tab audio exists, optional display/system audio is deliberately not added, avoiding echo/duplication.
9. The Meet tab stream is also connected to `audioCtx.destination`, preserving speaker playback while tab capture is active.
10. MediaRecorder receives full-screen video plus the mixed audio destination.

## Safety behavior verified in code

- Required Meet tab audio unavailable, zero tracks, muted track, or suspended audio context before start: fail closed and do not record.
- Meet source tab closed or navigated away: stop via the audio-loss path, notify, and finalize the partial recording.
- Captured tab track ends/mutes or AudioContext stops mid-recording: stop via the same idempotent loss path.
- Normal Stop/Cancel is marked intentional so it does not create a false audio-loss alert.
- Meet call-ended signal prompts the admin to stop-and-save or continue.

## Official platform confirmation

- Chrome `tabCapture` documentation: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Chrome screen/audio capture guide: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- Screen Capture specification: https://www.w3.org/TR/screen-capture/

These sources confirm:

- a stream ID with `consumerTabId` can be consumed in the designated extension tab;
- tab capture provides the tab's audio stream;
- captured tab audio should be routed to an AudioContext destination to remain audible;
- `getDisplayMedia` must let the user choose the display surface, and system audio is only a user-agent/user option, not something the app can force.

## Fresh evidence

- `node scripts/build.mjs` — exit 0.
- Built `dist/background.js` contains `consumerTabId`, `REQUEST_TAB_AUDIO`, and `TAB_AUDIO_LOST` paths.
- Local packaged ZIP manifest: v0.3.0.
- Live `https://data365.duckdns.org/365-extension.zip`: v0.3.0, 391990 bytes.
- Live health: status ok, DB ok, storage ok.

## Important limitation

The guarantee applies only when the extension is opened while the real Meet tab is active and the admin selects **Record full-screen meeting**. If the admin opens the extension from a random tab and selects generic **Record screen**, `meetingRequired` is false and the recorder may fall back to mic/display audio; remote Meet audio is not guaranteed.

The prototype passed with YouTube tab audio on the owner's machine. It has not yet been proven with a real two-person Google Meet. Track state checks prove that the browser supplied a live stream object, but they cannot prove that a remote person actually spoke and produced non-zero samples. A real device playback test remains mandatory.

## Required owner acceptance test

1. Reinstall extension v0.3.0 from the live ZIP or current `dist/`.
2. Join a real Meet with a second person and keep the Meet tab active.
3. Open the data365 extension and choose **Record full-screen meeting**.
4. Choose **Entire Screen**. Deliberately leave **Share system audio** unchecked.
5. Have the client say “client one, client two”; have the admin say “admin one, admin two”.
6. Record at least 20 seconds, stop, wait for upload, and play the saved file.
7. Pass only if both voices are clearly audible.
8. Then start a second recording and close the Meet tab mid-recording. Pass only if recording stops, a client-audio-lost notification appears, and the partial file is saved.

Do not claim production guarantee until this exact real-Meet test passes.
