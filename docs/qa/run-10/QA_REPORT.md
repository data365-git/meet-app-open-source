# QA Run 10 — Meeting Recorder Verification Report

Date: 2026-07-18

Candidate: `81827a160033fe2e74614c797fb80c7f2165e520`  
Recorder implementation: `cdf521b`

## Verdict

**NOT all reported recorder defects are fixed. NOT production-ready.**

The candidate closes several important code-level defects, but two High failure boundaries and one Medium UX/control group remain open. The exact Chrome/Meet device gate is also unverified.

## Fresh executable evidence

- Extension: 61/61 tests pass across 3 files.
- Permanent delete: 7/7 focused web tests pass.
- Route-export guard: 56/56 tests pass.
- Extension build passes and the built background bundle contains `/api/video/delete-permanent`.
- Web TypeScript passes.
- Turbopack production build passes and lists `/api/video/delete-permanent` as a route.
- Open-gap contract probe fails 5/5 required contracts.
- Dynamic discard atomicity probe fails: a simulated abort 500 is followed by a successful permanent-delete call.

## Verified fixed at code/test level

### High — tab-only video fallback and missing-audio start

Status: **Verified fixed at unit/integration level; real Meet audio remains device-unverified.**

- Shared `client-audio.ts` rule checks missing, ended, and muted track state.
- Offscreen capture no longer retries video-only after the audio+video request fails.
- Focused tests cover missing, ended, muted, acquisition failure, no-audio stream, live start, mute while recording/paused, recovery, and intentional stop.

### High — soft delete behind “Permanently discard”

Status: **Verified fixed for the successful server path, not for failure/restart cleanup.**

- The extension bundle calls `/api/video/delete-permanent`, not `/api/video/delete`.
- The route calls `Videos.permanentlyDelete`.
- Storage objects are deleted before the database row.
- A storage-delete failure leaves the database row intact.
- Already-absent video is idempotent and non-owner mutation is rejected in tests.
- The production build exposes the new route.

### Medium — service-worker Pause/Resume persistence

Status: **Verified fixed in the core state machine, but the visible UI half remains open.**

- The service worker persists Pause/Resume only after an active recorder acknowledgement.
- Fresh tests cover failed Pause, failed Resume, and successful Pause.

### High — old discard completion stomping a newer recording

Status: **Verified fixed in a deterministic race test.**

- The post-discard idle write is guarded by the original video/upload identity.
- The extension suite reproduces the interleaving and preserves the newer recording.

## Open findings

### High — permanent discard is not durable or atomic across failure/restart

The retry schema still has only `part`, `complete`, and `recording-complete`; there is no durable `discard` item. `discardUpload` clears local bytes and retry/dead-letter evidence before the server result is known. On failure, state becomes idle and a notification tells the owner to delete from the dashboard. No startup/alarm cleanup survives.

There is a second failure inside the same invariant: abort and hard delete are separate calls. `discardUpload` catches an abort failure and still calls permanent delete. The fresh dynamic probe produced:

```text
result: { serverCleaned: false }
abortCalled: true
permanentDeleteCalled: true
FAIL: permanent delete still ran after multipart abort failed
```

Because the abort route authorizes through the video row, deleting the row after a transient abort failure can leave multipart parts without the ownership row needed for a later retry. The client then treats a later 404 as success. “Permanently discarded” is therefore not guaranteed under the exact offline/failure condition from the report.

### High — meeting mode still does not enforce the returned full-screen surface

`recorder-page.ts` requests `displaySurface: "monitor"`, but after `getDisplayMedia` it never reads the returned video track's `getSettings().displaySurface`. A known `window` or `browser` selection is not rejected before upload initialization. No focused surface test exists.

The built recorder bundle contains the hint and no returned-surface validation.

### Medium — visible Pause/Resume and discard feedback remain untruthful/incomplete

- Popup Pause/Resume still uses fire-and-forget `sendMsg`, waits 200 ms, then restores the old label without inspecting `{ ok }` or showing an inline error.
- Popup permanent discard also uses fire-and-forget `sendMsg`; it never renders `Deleted` versus `Delete queued`/failure.
- The persistent recorder page exposes only `Stop & upload`; no Pause/Resume button or binding exists.
- The exact built `recorder.html` confirms only `btn-stop` in the recording view.

## Live execution status

Chrome 150 is installed but was not running, and the ChatGPT Chrome control extension is absent from its selected profile. The in-app browser rejected the built `file://` extension page by security policy. Therefore the following are **Unverified**, not passed:

- real two-person Meet remote voice;
- Chrome mute/unmute warning mapping;
- real picker rejection of tab/window;
- visible Pause/Resume and timer behavior;
- offline Stop → Chrome restart → final playback;
- offline permanent discard → reconnect → DB/R2/multipart/retry absence;
- mobile viewport, keyboard flow, and extension console.

## Counts

- Critical: 0 open
- High: 2 open
- Medium: 1 open group
- Low: 0 open
- Device-only release gates: 7 unverified groups

## Release decision

Block release. The next implementation pass must first add a durable/atomic discard operation, returned-surface validation, and acknowledged visible controls. Then rerun these gates and the exact packaged Chrome/Meet device checklist.
