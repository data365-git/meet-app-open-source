# QA Smoke Evidence — Ustoz Meeting Recording + UX/UI

Date: 2026-07-18

## Frozen release-candidate evidence

Target: `D:\vibecoding\_audit-frozen-94af12d`, commit `94af12d`.

| Check | Result | Meaning |
|---|---|---|
| Extension Vitest against frozen source | Pass: 42/42, 2 files | Covered upload and service-worker behavior is green, but the proven UX/content gaps are not represented by these tests. |
| Exact code-path review | Fail | Tab-only audio can silently fall back to video-only; uploading cancel is not a true abort; pause/resume delivery failure is ignored. |

Command used for the frozen suite:

```powershell
pnpm --filter @cap/browser-extension exec vitest run --root 'D:\vibecoding\_audit-frozen-94af12d\apps\browser-extension' --config 'D:\vibecoding\ustoz-github\apps\browser-extension\vitest.config.ts' --reporter=basic
```

## Dirty comparison-tree evidence

The main checkout was not treated as a release candidate. It contains unrelated in-flight files and was inspected only to identify drift.

| Check | Result |
|---|---|
| Extension Vitest | Pass: 48/48, 3 files |
| Extension production build | Pass |
| Seven focused web recording/recovery files | Pass: 42/42 |
| Root typecheck | Fail: generated route type for `recover-stale-ai-jobs` rejects `hasPendingBatchJobs` |

The current tracked recorder source still matches the frozen fallback/cancel behavior. An untracked recorder test file is not release proof.

## Live production evidence

Target: `https://data365.duckdns.org` (known to be older than commit `94af12d`).

- Public 52:51 recording loaded with no media error.
- Playback advanced from 34.60 s to 41.63 s and paused successfully.
- Summary, tasks, transcript, and text tabs rendered populated content.
- Desktop layout at 1280 px had no horizontal overflow.
- The public watch page was visually coherent: clear video-first hierarchy, comments, reactions, tabs, and AI entry point.
- Mobile viewport emulation did not take effect in the browser session; mobile remains `Unverified`.
- Production playback does not prove the new extension's capture, pause, audio, finalize, or restart behavior.

## Built extension visual evidence

The exact built `recorder.html` idle surface was served locally for read-only visual inspection. It rendered a clean centered card with a clear primary action. Functional capture was not exercised because a normal local page has no Chrome-extension runtime or capture permissions.

## Human/device gate still required

No automated or local-page check can prove the actual Chrome picker, remote voice capture, tab-mute recovery, pause privacy, restart recovery, or playback-to-end. These remain `Unverified`, not passed.
