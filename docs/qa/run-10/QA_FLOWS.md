# QA Run 10 — Recorder Flow Map

Candidate: `81827a1` (`cdf521b` recorder implementation)

## Flow matrix

| Flow | Expected invariant | Code/test trace | Preliminary classification |
| --- | --- | --- | --- |
| Tab-only happy path | Start only with a live tab-audio track; never fall back to video-only | `shared/client-audio.ts`, `offscreen/recorder.ts`, focused offscreen tests | Implemented; executable and device proof pending |
| Tab-only missing/muted/ended audio | Block start with a visible error | Four focused offscreen tests | Implemented; executable proof pending |
| Tab-only audio degrades/recoveries | Warn once, recover without false warning on stop | track handlers and focused tests | Implemented; real Chrome mute mapping remains device-only |
| Full-screen meeting, valid audio | Capture screen plus Meet-tab audio | `recorder-page.ts` liveness gate | Implemented; real two-person Meet proof pending |
| Full-screen no-audio waiver | One explicit confirmation and persistent warning | existing confirm/warning state machine | Binding behavior preserved; live proof pending |
| Wrong capture surface | Reject known `window`/`browser` selection before upload initialization | only `displaySurface: "monitor"` request hint exists; no returned-track validation or test | **Missing product logic** |
| Pause succeeds | Recorder acknowledges, canonical state becomes paused, timer freezes | conditional capture-context ACK and service-worker tests | Core state implemented; visible UI proof pending |
| Pause/Resume delivery fails | Canonical state and visible control stay truthful; inline error | service worker preserves state, but popup uses fire-and-forget `sendMsg` and a 200 ms reset | **Partial: missing UI truth/error handling** |
| Persistent recorder controls | User can Pause/Resume without reopening popup | `recorder.html` exposes only `Stop & upload`; no button binding | **Missing product logic** |
| Permanent discard online | Abort multipart, hard-delete objects first, DB row last, preserve other uploads | permanent route/service and web/SW tests | Implemented; executable proof pending |
| Permanent discard repeated | Already-absent video succeeds; non-owner cannot mutate | service tests | Implemented; executable proof pending |
| Permanent discard offline | Persist exactly one cleanup job; restart/alarm retries automatically; UI says queued | retry item union has only `part`, `complete`, `recording-complete`; failure clears local evidence and tells user to delete in dashboard | **Missing product logic** |
| Discard response/UI truth | Await response and show Deleted vs queued/failure | popup uses fire-and-forget `sendMsg({ type: "DISCARD_UPLOAD" })` | **Missing product logic** |
| Old discard vs new recording | Old completion cannot reset a newer active recording | service-worker identity guard and deterministic race test | Implemented; executable proof pending |
| Picker cancellation | Return to usable idle and release arming state | `INSTRUCTION_CANCEL` path | Implemented; live proof pending |
| Stop offline/restart/finalize | Durable bytes retry and final playback reaches final frame | existing retry/finalize tests from earlier commits | Unit-covered; exact packaged Chrome proof pending |

## State coverage

- First run/auth: outside the narrow blocker check except where API auth gates permanent delete.
- Permission denied/picker cancel: mapped and code-covered; live observation required.
- Offline/network failure: finalize has an existing retry path; discard does not.
- Destructive confirmation: two-click discard exists; result handling is not awaited.
- Restart/recovery: upload/finalize paths exist; discard cleanup is absent from the retry schema.
- Accessibility: recorder error text is visible, but Pause/Resume inline error/live-region behavior cannot exist while the controls are absent/fire-and-forget.

## Stage 1 result

Three previously reported areas remain open in source before running gates:

1. Durable offline discard/restart cleanup.
2. Truthful visible Pause/Resume/discard feedback plus recorder-page Pause/Resume.
3. Returned `displaySurface` validation for meeting full-screen mode.

Permanent server erasure, tab-only fail-closed audio, capture-context acknowledgements, and the old-discard/new-recording race guard have concrete implementations and tests that now require fresh execution.
