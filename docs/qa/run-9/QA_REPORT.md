# QA Report — Meeting Recording + UX/UI Deep Audit

Date: 2026-07-18  
Frozen target: commit `94af12d`  
Verdict: **NOT PRODUCTION-READY**

## Executive result

No new Critical defect was proven in this pass, but two High defects break the product's core promise and user trust. The strongest part of the product is the public watch experience; the weakest part is the recording entry/exit seam, where labels and stored state can disagree with what actually happened.

## Findings

### High — Tab-only meeting mode can silently save video without remote audio

The popup offers `Record Meet tab only` (`popup.ts:261-270`). If tab capture with audio and video fails, the recorder retries video-only (`offscreen/recorder.ts:117-128`) and proceeds without a blocking warning. A successful upload can therefore look healthy while the meeting's remote voices are absent.

Impact: a meeting can be technically saved but unusable. This violates the content guarantee.

Required fix: either remove this mode for meetings or apply the same fail-closed audio-track and degradation checks as the guaranteed full-screen path.

### High — “Cancel upload” is not a true cancel or permanent discard

The uploading UI offers `Cancel upload` (`popup.ts:700-719`). `CANCEL` only calls `abortUpload` while state is `recording`, not while it is `uploading` (`sw.ts:747-793`). Even that helper only clears the pending buffer (`upload.ts:573-576`); it does not abort the server multipart upload, remove queued retries, or delete an uploaded object.

Impact: the UI can return to idle while remote parts and retry work remain. The user cannot know whether private data was deleted, may later receive misleading recovery/loss behavior, and storage can accumulate orphaned parts.

Required fix: split this into `Hide/close while retrying` and an explicitly confirmed `Permanently discard`, with one transactional cleanup path for local state, retry/dead-letter items, multipart abort, completed object deletion, and truthful failure reporting.

### Medium — Pause/resume can display a state that the recorder never received

`PAUSE` and `RESUME` await `sendControlWithRetry` but ignore its boolean delivery result, then persist `paused: true/false` (`sw.ts:634-720`). `STOP` already handles delivery failure, so the safer pattern exists nearby.

Impact: the popup timer may say paused while recording continues, or say recording while capture remains paused. This is a privacy and completeness risk.

Required fix: change state only after acknowledged delivery; otherwise keep the previous state and show a blocking recovery message. Add delivery-failure tests.

### Medium — The visible recorder page hides pause/resume

The popup has Pause/Resume and Stop (`popup.ts:637-682`), but the recorder tab shown after starting has only `Stop & upload` (`recorder.html:161-173`). Because the popup closes after start, pausing requires rediscovering and reopening the toolbar popup.

Impact: a central control is hidden at the moment it is needed.

Required fix: put Pause/Resume beside Stop on the persistent recorder page and keep both surfaces synchronized.

### Medium — The meeting promise and capture choice disagree

The popup promises `Record full-screen meeting` (`popup.ts:275-286`), but the next page says `Record Instruction` and asks the user to choose a screen, window, or tab (`recorder.html:143-149`). There is no visible validation that the selected surface was actually the full screen.

Impact: users can choose the wrong surface while believing the guaranteed meeting path is active.

Required fix: use meeting-specific copy, explain the picker choice in one sentence, validate the selected display surface where the browser exposes it, and fail clearly when the guarantee cannot be met.

### Medium — Release gate is red in the comparison tree

Fresh root typecheck failed in generated route types for `recover-stale-ai-jobs`, where `hasPendingBatchJobs` is incompatible with the route export contract.

Impact: the current dirty tree cannot be treated as a releasable candidate even though focused recording tests pass.

Required fix: resolve on a frozen branch and rerun the exact production gates.

### Medium — Critical states are weak for keyboard and assistive technology

The mic toggle input is `display: none` (`popup.css:387-388`), removing it from keyboard focus. No `:focus-visible` treatment was found. Timer, warnings, upload progress, completion, and errors have no live-region announcement in `recorder.html`. The confirmation view is not a semantic dialog and has no focus management. Motion has no reduced-motion override.

Impact: keyboard and screen-reader users can miss or be unable to operate safety-critical controls.

Required fix: visually hide rather than remove native inputs, add visible focus, live regions, dialog semantics/focus management, and reduced-motion handling.

### Low — Language and visual-system drift reduce confidence

The live product is Uzbek, the popup is English, and the recorder page mixes English and Uzbek in one flow. The recorder card uses a purple primary action while the current web product is blue-led.

Impact: the experience feels assembled from separate products and makes warnings harder to scan.

Required fix: choose one language policy per audience and one shared token set for primary, danger, success, spacing, and typography.

### Low — Mobile watch-page usability remains unverified

Desktop watch playback and tabs were checked successfully. The viewport override did not produce a true 390 px session, so touch target size, overflow, comments, tabs, and player controls on mobile are not proven.

## What is good

- Desktop public playback was healthy and easy to understand.
- Watch-page hierarchy is strong: video first, supporting content and comments nearby.
- The recorder idle card is visually clean and the primary action is obvious.
- Frozen extension tests pass 42/42; the core multipart engine has meaningful regression coverage.
- Stop already has a delivery-failure fallback that can guide the Pause/Resume repair.

## Evidence limits

- No extension was installed and no Chrome permissions were granted.
- No authenticated production recording or destructive action was performed.
- Real Meet remote audio, tab mute, pause privacy, browser restart, offline finalize, mobile layout, and playback-to-end remain `Unverified`.
- Live production is older than the frozen audit target and cannot certify it.

## Release decision

Do not deploy the frozen candidate to the team. Fix the two High findings first, align Pause/Resume truth with recorder truth, freeze a clean candidate, rerun automated gates, then execute the real-device Meet-to-playback gate.
