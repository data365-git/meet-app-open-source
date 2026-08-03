# QA Hardening Plan — Recording + UX/UI

## P0 — Block release

1. Make tab-only meeting capture fail closed when a remote-audio track is absent or degrades; alternatively remove the mode.
2. Replace ambiguous upload cancel with two explicit operations: safe background retry/close and confirmed permanent discard.
3. Permanent discard must clean local buffers, live state, retry and dead-letter records, server multipart state, and any completed object. Partial cleanup must be shown as failure, never success.
4. Freeze one clean candidate. Do not use the moving dirty checkout as release evidence.

## P1 — State truth and recovery

1. Require Pause/Resume delivery acknowledgement before changing persisted state.
2. Add Pause/Resume to the persistent recorder tab.
3. Show one canonical state on both surfaces: Recording, Paused, Saving offline, Finalizing, Saved, or Needs attention.
4. Define restart behavior for every state and test it from durable storage.
5. Show whether bytes are safe, what will retry automatically, and exactly what a destructive action deletes.

## P1 — UX and accessibility

1. Make the guaranteed meeting journey meeting-specific from popup through picker guidance and completion.
2. Use consistent Uzbek or a deliberate, complete localization policy; do not mix languages inside one safety decision.
3. Preserve native keyboard controls, add visible focus, semantic dialog/alert behavior, live announcements, and reduced motion.
4. Use a shared visual token set so recording, danger, progress, and saved states mean the same thing across extension and web.

## Required automated checks

- Tab-only start rejects zero audio tracks and mid-recording audio loss.
- Pause/Resume delivery failure does not change persisted state.
- Uploading close preserves retries; permanent discard removes all local/server artifacts.
- Browser restart resumes each durable recording/finalizing state without duplicate completion.
- UI state tests cover idle, arming, recording, paused, offline upload, finalizing, complete, and error.
- Keyboard/a11y checks cover focus order, accessible names, live regions, and reduced motion.
- Root typecheck and the exact production build pass on the frozen candidate.

## Real-device release gate

On the exact packaged extension candidate:

1. Start a real Google Meet and choose the guaranteed whole-screen path.
2. Confirm both local and remote voices in the saved file.
3. Pause for at least ten seconds and verify that interval contains no captured audio/video.
4. Mute or disrupt the Meet tab and verify the warning/recovery behavior.
5. Stop while briefly offline, restart Chrome, reconnect, and verify finalization.
6. Open the dashboard and play the recording to the final frame.
7. Repeat the watch-page core path on a real 390 px-class phone.

Any missing remote voice, dishonest state, unexplained deletion, truncated ending, stuck finalize, or playback failure is a release blocker.
