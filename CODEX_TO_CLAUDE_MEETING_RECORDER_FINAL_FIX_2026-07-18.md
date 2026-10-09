# Claude Code Task — Finish Meeting Recorder Hardening

You are implementing the final meeting-recorder hardening pass in `D:\vibecoding\ustoz-github`.

Read these first, in order:

1. `AGENTS.md`
2. `docs/STATE.md`
3. `docs/plans/2026-07-18-meeting-recorder-final-hardening.md`
4. `docs/plans/2026-07-15-recorder-resilience-and-one-click.md`
5. the current semantic diff: `git diff --ignore-space-at-eol`

Scope contract: Only change meeting-recorder audio guarantees, truthful pause/resume, durable permanent discard, restart recovery, and the recorder controls/copy needed to expose those guarantees. Do not change unrelated extension UI, dashboard behavior, authentication, infrastructure, deployment, or production data.

The working tree is dirty and another writer has active recorder changes. Preserve all current semantic work and unrelated user changes. Never run reset, checkout, clean, stash, broad formatting, or whole-file replacement. Do not commit, push, deploy, or touch production.

Current research baseline:

- Branch `qa-fixes`, HEAD/origin `cabe1b6ff65cfa4b6eb02ffdff56c6e16795edd3` at research time.
- Current in-flight extension tests pass 59/59 and the extension build passes.
- Current ordinary and EOL-ignored tracked diff stats agree; preserve that parity.
- Those results are not release proof.
- Existing in-flight work already removes tab-only video fallback, adds shared audio health checks, makes capture-context Pause/Resume acknowledgements conditional, splits background-close from discard, and improves meeting copy. Keep these changes unless a RED test proves a correction.

Four blockers are already proved:

1. “Permanently discard” calls `/api/video/delete`, which uses `Videos.delete` and only soft-deletes for the seven-day trash window.
2. Offline discard removes local evidence but does not retain a durable server-cleanup retry.
3. `displaySurface: "monitor"` is a picker hint, not enforcement; the returned surface is not validated.
4. Popup Pause/Resume and discard remain fire-and-forget, and the persistent recorder page has no Pause/Resume controls.

Implement the linked plan in strict waves. For each wave:

1. Write one or more focused RED tests that fail for the named defect.
2. Capture the failure reason.
3. Make the smallest change that establishes the invariant.
4. Run the focused test, then the affected suite.
5. Inspect the semantic diff before continuing.

Non-negotiable implementation boundaries:

- Do not silently reverse the owner's full-screen audio waiver. Missing client audio may proceed only after the existing explicit confirmation and with a persistent warning. Tab-only must fail closed.
- Do not remove either recording entry mode.
- Do not replace `getDisplayMedia` with `desktopCapture`.
- Do not add audio-energy or speech detection.
- Do not claim Chrome's tab-strip speaker mute maps to `MediaStreamTrack.muted` until the real-device gate proves it.
- Do not use `/api/video/delete` for permanent discard.
- Server discard must authorize first, abort/delete storage first, and delete database evidence last. It must be idempotent.
- Offline discard must leave exactly one durable retry item and truthful UI until server cleanup succeeds.
- Pause/Resume UI may change only after an active recorder acknowledges the command.
- Meeting full-screen mode must validate returned `displaySurface` when Chrome exposes it and reject known non-monitor surfaces before upload initialization.
- Do not introduce EOL-only churn; ordinary and `--ignore-space-at-eol` diff stats must agree for touched files.

Before reporting completion, run the focused web tests, the full extension suite, extension build, root typecheck, `.claude/gate.cmd`, `git diff --check`, and both diff stats. Update `docs/STATE.md` with facts only.

Return a concise report containing:

- RED tests and their observed pre-fix failures;
- files changed per wave;
- GREEN command results;
- unresolved device-only claims;
- an exact real-device checklist.

Do not say “fixed,” “done,” or production-ready until the real two-person Meet, pause interval, offline restart/finalize, offline permanent-discard cleanup, tab-only remote voice, and wrong-surface rejection tests all pass on the exact packaged candidate.
