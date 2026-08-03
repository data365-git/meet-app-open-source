# Camera overlay (PiP) for screen/instruction recordings — implementation plan

> Status: PLANNED, not built. This touches the recording pipeline (the most
> fragile part of the app) and CANNOT be verified headlessly — it needs a real
> browser with a camera + screen. Build it device-in-the-loop: implement →
> owner records a test clip → fix → repeat. Ship OPT-IN / default-off so a bug
> can never affect existing screen-only recordings.

## Why the camera button was "disabled" (owner's report)
`useWebRecorder.ts` only acquires a camera stream when `recordingMode === "camera"`.
For an instruction/screen recording (`getDisplayMedia`), `cameraStreamRef` is null,
so `canToggleCamera` is false and the in-recording camera button is disabled.
There is no camera at all in a screen recording today — so it's nothing to toggle.

## Goal
Optionally burn a small round camera overlay into a SCREEN recording (Loom-style),
producing a single MP4 with the camera composited in a corner.

## Approach (canvas compositing — the only way to get one MP4)
In `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts`,
in the screen branch (around lines 855–977, where `mixedStream` is built):

1. **New opt-in state** `cameraOverlayEnabled` (default FALSE) + a checkbox in the
   pre-start dialog (`web-recorder-dialog.tsx`), plus reuse the existing
   `selectedCameraId` picker. When false → NOTHING below runs; the current
   screen-only path is byte-for-byte unchanged (zero risk to existing recordings).
2. When true + screen mode: `getUserMedia({video:{deviceId:selectedCameraId, width:320,height:320,frameRate:30}})`
   → store in `cameraStreamRef.current`. On denial → toast + fall back to
   screen-only (don't abort the recording).
3. **Composite loop:** create a `<canvas>` sized to the screen track's
   `settings.width×height`. In a `requestAnimationFrame`/`setInterval(~30fps)` loop:
   draw the screen `<video>` full-frame, then draw the camera `<video>` clipped to
   a circle in a corner (e.g. bottom-left, ~180px, with a subtle ring). Keep hidden
   `<video>` elements bound to the screen + camera streams as draw sources.
4. **Record the canvas:** replace `videoStream.getVideoTracks()` in the `mixedStream`
   with `canvas.captureStream(30).getVideoTracks()`. Audio mixing stays as-is.
5. **Camera toggle during recording:** the existing `toggleCameraMute`
   (track.enabled flip on `cameraStreamRef` video tracks) now has a real stream →
   the InProgressRecordingBar button works. When off, skip drawing the camera
   circle (show screen only) so "camera off" is visually honest.
6. **Cleanup:** stop the rAF loop, stop camera tracks, drop the canvas on
   stop/reset/error (extend the existing cleanup in `useStreamManagement`).

## Risks / must-verify on device
- Performance: compositing a 1080p canvas at 30fps is CPU-heavy on weak machines —
  measure; consider capping canvas to the screen's native fps and 720p camera.
- The recorded MP4 must actually play (duration + A/V sync) — verify a real clip.
- Pause/resume + the existing crash-recovery spool must still work with a canvas stream.
- Do NOT change the extension recorder or meet-detect paths — screen-web only.

## Gate
tsc 0 · a real recorded test clip plays with the camera circle visible + the
in-recording camera toggle hides/shows it · existing screen-only recording
(overlay off) is unchanged.
