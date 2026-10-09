# Meeting Recorder Final Hardening Plan

Date: 2026-07-18

Owner goal: a meeting must never be silently lost or silently saved without the expected client audio.

Implementation owner: Claude Code

Review owner: Codex

## Scope contract

Only change meeting-recorder audio guarantees, truthful pause/resume, durable permanent discard, restart recovery, and the recorder controls/copy needed to expose those guarantees. Do not change unrelated extension UI, dashboard behavior, authentication, infrastructure, deployment, or production data.

## Frozen research snapshot

- Branch: `qa-fixes`
- HEAD and origin at research time: `cabe1b6ff65cfa4b6eb02ffdff56c6e16795edd3`
- The checkout is dirty and another writer is actively changing recorder files. Preserve that work. Do not reset, checkout, stash, reformat, or replace whole files.
- Current in-flight extension tests: 59/59 pass across three files.
- Current in-flight extension build: passes.
- Current ordinary and `--ignore-space-at-eol` tracked diff stats agree. The exact dirty-tree count is volatile because another writer is active.
- The green tests prove the cases they contain; they do not prove the cross-layer invariants below.

The current uncommitted work already contains useful partial fixes:

- Tab-only capture no longer deliberately falls back to video-only.
- Tab-audio track state is shared and mute/unmute warnings have begun.
- Pause/Resume state changes in the service worker now depend on a recorder acknowledgement.
- Upload UI separates background continuation from a two-click discard.
- Recorder-page copy is meeting-aware.

Keep those semantic changes unless a RED test proves a smaller correction is needed.

## Why the problem survived previous fixes

The recorder has two capture engines and four persistence layers: the visible full-screen recorder page, the offscreen tab-only recorder, the Manifest V3 service worker, and server/R2 state. Previous changes repaired individual functions while tests mocked the layer immediately behind them. The remaining failures are at the boundaries:

1. The extension calls `DELETE /api/video/delete` for “permanent” discard, but that route calls `Videos.delete`, which only soft-deletes the row and retains media/upload state for the seven-day trash window.
2. The extension destroys its local retry evidence before server cleanup succeeds. When offline, it reports failure but leaves no durable cleanup job, so multipart data or a completed recording can survive indefinitely.
3. `getDisplayMedia({ displaySurface: "monitor" })` is only a picker hint. The browser must still let the user choose other surfaces, and the app does not validate the returned track.
4. The recorder acknowledges Pause/Resume more honestly, but the popup still sends the command fire-and-forget. A failed command is invisible to the user. The persistent recorder page has no Pause/Resume controls.
5. Browser track `muted`/`unmute` events are useful capture-path signals, but the standards do not guarantee that Chrome's tab-strip speaker mute will map to those events. That claim requires a real Chrome/Meet device test.

## Binding product decisions

These decisions already exist in `docs/plans/2026-07-15-recorder-resilience-and-one-click.md` and must not be reversed silently.

- Keep both entry modes: full-screen meeting capture and `Record Meet tab only`.
- In the full-screen meeting flow, missing client audio may be overridden only by the existing one-time explicit confirmation. If the owner proceeds, retain a persistent warning for the entire recording. The guarantee is “never silent,” not “never user-waived.”
- In tab-only mode there is no safe confirmation surface, so missing or unusable client audio must fail closed.
- Mid-recording audio loss must warn and recover when possible; it must not automatically stop and destroy an otherwise useful meeting.
- Do not replace `getDisplayMedia` with `desktopCapture`. The visible page is the correct capture context and the current system-audio fallback must remain.
- Do not add an audio-energy/speech detector. The accepted guarantee is capture-path health, not inferred loudness.

## Release invariants

Every change and test must map to at least one invariant.

1. **CONTENT:** meeting recording starts with screen video and a live client-audio capture path, or with the owner's explicit full-screen waiver plus a persistent warning.
2. **SAVE:** every accepted byte is in the in-memory serialized operation, durable extension storage, or R2. It is never silently dropped.
3. **CONTROL:** Pause/Resume UI changes only after the active recorder acknowledges the command.
4. **DELETE:** “permanently discarded” means server objects, multipart state, upload rows, and the video row are gone. Offline cleanup remains durably queued until that is true.
5. **SURFACE:** meeting-required full-screen capture validates the surface actually returned by Chrome, not the constraint requested by the app.
6. **RECOVERY:** every nonterminal state has a restart path, does not duplicate work, and does not block a new recording forever.

## Blast-radius map

| Invariant | Writers | Readers/consumers | Required proof |
| --- | --- | --- | --- |
| CONTENT | `offscreen/recorder.ts`, `recorder/recorder-page.ts`, `shared/client-audio.ts` | `sw.ts`, popup/recorder warnings | unit tests plus real Meet remote-voice playback |
| CONTROL | `sw.ts`, both recorder contexts | popup, recorder page, persisted state/timer | failure-path unit tests plus live pause interval playback |
| DELETE | extension `api.ts`/`upload.ts`/`sw.ts`; web multipart route; `Videos` service/repo | retry queue, alarms, dashboard, R2 | server idempotency tests, client restart tests, DB/storage inspection |
| SURFACE | `recorder-page.ts` | SW start state and upload initialization | simulated track-settings tests plus Chrome picker test |
| RECOVERY | `upload.ts`, `sw.ts`, retry storage/alarm | startup/alarm handlers and UI | restart/offline tests plus Chrome restart test |

## Ordered implementation

Do not combine the waves. Start each wave with a focused failing test, make the smallest code change, then rerun the focused tests. If a wave reveals a broader change, stop and update this plan before expanding scope.

### Wave 0 — preserve and normalize the active work

1. Read `docs/STATE.md`, this plan, and the current semantic diff with `git diff --ignore-space-at-eol`.
2. Record the current test count and build result.
3. Keep unrelated dirty files untouched.
4. Preserve the current EOL-clean diff. Ordinary and `--ignore-space-at-eol` diff stats must continue to agree for touched files.
5. Run the existing 59 extension tests before adding behavior.

### Wave 1 — RED-first, idempotent server permanent discard

Create one authenticated server operation, preferably `POST /api/upload/multipart/discard`, receiving `{ videoId, uploadId, subpath: "result.mp4" }`.

Required operation order:

1. Authenticate and prove ownership before any mutation.
2. Abort the multipart upload first. Treat `NoSuchUpload` as an idempotent success, using the existing cause-chain helper already used by multipart completion.
3. Delete all objects belonging to the owner's video prefix.
4. Delete `videoUploads` and the video database row last.
5. If storage cleanup fails, leave the database ownership row available so the same request can be authorized and retried.
6. A repeated request after a lost response must resolve to the requested final state, not create a false fatal error.

Do not use the soft-delete route for this operation. `Videos.permanentlyDelete` may be reused only after correcting its current DB-first ordering; otherwise implement a narrowly scoped storage-first service method.

RED tests, adapted from the existing multipart idempotency suite:

- abort is attempted before storage/database deletion;
- `NoSuchUpload` is accepted;
- storage failure does not delete the ownership row;
- non-owner/unauthenticated requests cause zero mutation;
- the same request can be repeated after a simulated lost response;
- no call reaches `Videos.delete` or `/api/video/delete`.

Suggested file: `apps/web/__tests__/unit/multipart-discard-idempotency.test.ts`.

### Wave 2 — durable client-side discard and restart recovery

Add a durable retry item such as `kind: "discard"` with `{ videoId, uploadId }` and a long retry horizon.

Within the existing serialized recorder mutation queue:

1. Freeze the target recording identity.
2. Clear its pending local recording bytes and remove only its part/complete/recording-complete retry items.
3. Insert exactly one durable discard item before the first network attempt.
4. Retry the new server discard operation from the existing alarm/startup drain.
5. On success, remove the item and clear its notification. Do not overwrite a newer recording's state.
6. On failure, retain the item and alarm. Say “Delete queued; will retry automatically,” never “Deleted.”
7. A pending discard must not count as an active recording and must not block a new start.

Prefer a truthful `discarding` presentation state if it can be added surgically. Otherwise the durable queue and persistent notification remain authoritative.

The popup must use `sendMsgAwait` for the second discard click and display one of: `Deleted`, `Delete queued`, or a real error. Do not close or silently reset before receiving the response.

RED tests:

- offline discard leaves exactly one durable discard item;
- restart/alarm drains it after connectivity returns;
- duplicate clicks and repeated restarts deduplicate it;
- unrelated recording queue items are untouched;
- old discard completion cannot overwrite a newer recording;
- discarded local bytes never resume part/finalize upload;
- no client path calls the soft-delete endpoint.

### Wave 3 — complete the client-audio invariant

Keep the shared `client-audio` rule and the removal of the tab-only video fallback.

Required behavior:

- tab-only audio+video acquisition failure never retries video-only;
- zero audio tracks, `readyState === "ended"`, or initially unusable track state blocks tab-only start;
- a degraded live track warns once, recovery clears the warning, and ordinary intentional stop does not create a false warning;
- full-screen flow keeps the one-time explicit waiver and persistent warning;
- source-tab closure/navigation and track events remain explicit signals;
- comments must describe only behavior proved by code or real-device evidence. Do not claim that Chrome's speaker-mute UI is guaranteed to emit a media-track mute event.

RED tests:

- failed AV request never invokes a video-only retry;
- missing, ended, and initially muted tracks block tab-only start;
- mute warning is deduplicated, unmute recovers, normal stop is quiet;
- both capture paths use the same health definition where their product policies overlap.

### Wave 4 — truthful Pause/Resume and persistent controls

Keep the current conditional acknowledgements in the service worker and capture contexts.

1. Change the popup Pause/Resume action to await the runtime response.
2. On `ok !== true`, preserve the prior label/state and display an inline `aria-live` error.
3. Add Pause/Resume beside Stop in `recorder.html` and `recorder-page.ts`.
4. Route recorder-page buttons through the service worker's existing `PAUSE`/`RESUME` commands so persisted state remains canonical.
5. Change both UI surfaces only after `STATE_CHANGED` confirms the acknowledged state.
6. Preserve keyboard focus visibility and accessible control names.

RED tests:

- delivery failure leaves the canonical state unchanged;
- popup and persistent page both show the failure;
- both surfaces render the same acknowledged pause state;
- paused time is excluded from the elapsed timer;
- resume continues the same recording/upload identity.

### Wave 5 — validate the selected capture surface

The Screen Capture specification requires the picker to offer user choices; `displaySurface: "monitor"` cannot enforce full-screen capture.

For meeting-required full-screen capture only:

1. After `getDisplayMedia`, inspect `displayStream.getVideoTracks()[0].getSettings().displaySurface`.
2. If the value is present and is not `monitor`, stop every acquired track immediately.
3. Do not initialize an upload or send `RECORDER_STARTED`.
4. Show a precise retry message: choose `Entire Screen` to record the meeting.
5. Leave ordinary instruction capture able to use a window or tab.
6. If the target Chrome version does not expose the setting, mark the branch unverified and settle it with the device gate; do not invent a false guarantee.

RED tests:

- `monitor` is accepted;
- `browser` and `window` are rejected before upload initialization;
- picker cancellation returns to a usable idle state;
- non-meeting instruction capture remains unchanged.

### Wave 6 — engineering gates

Run and record:

```text
pnpm --filter @cap/browser-extension test -- --reporter=basic
pnpm --filter @cap/browser-extension build
pnpm --filter @cap/web test -- multipart-discard-idempotency
pnpm typecheck
.claude/gate.cmd
git diff --check
git diff --stat
git diff --ignore-space-at-eol --stat
```

Adapt the focused web-test command to the repo's actual script, but do not weaken the assertion set. Ordinary and EOL-ignored diff stats must agree for touched files. Review every changed file against the scope contract.

Do not commit, push, deploy, or touch production without separate owner approval.

## Mandatory real-device release gate

Use the exact unpacked package built from the reviewed candidate. Unit tests and build output are necessary but cannot prove Chrome/Meet media behavior.

1. Start a real two-person Google Meet and choose `Entire Screen`.
2. Have the remote participant speak unique phrases; stop and verify those exact phrases are audible in dashboard playback through the final frame.
3. Pause for ten seconds while the remote participant speaks; verify the saved interval is absent and the timer froze, then resume.
4. Trigger Chrome tab mute/unmute. Record whether the warning and recovery actually occur. Do not claim this behavior before observing it.
5. Stop while offline, restart Chrome, reconnect, and verify finalization completes and playback reaches the last frame.
6. Repeat a remote-voice check with `Record Meet tab only`.
7. Permanently discard while offline, reconnect, and verify the dashboard/trash, database row, upload row, R2 objects, multipart state, and extension retry item are all absent.
8. In meeting mode deliberately select a tab or window; the app must reject it before upload initialization and ask for `Entire Screen`.

Release is blocked by any missing remote audio without the explicit waiver, false pause state, stuck finalization, truncated ending, surviving “permanently discarded” data, or accepted non-monitor meeting surface.

## Evidence sources

- Chrome tab capture behavior: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- MediaStreamTrack `muted` semantics: https://www.w3.org/TR/mediacapture-streams/
- Screen Capture picker and `displaySurface`: https://www.w3.org/TR/screen-capture/

## Completion handoff

Claude must return:

- the exact RED tests added and their pre-fix failures;
- the smallest implementation diff by wave;
- GREEN command output;
- normal versus EOL-ignored diff stats;
- remaining unverified device-only claims;
- updated `docs/STATE.md` with next step as the real-device gate.

Claude must not say the recorder is fixed until the mandatory real-device gate has been observed.
