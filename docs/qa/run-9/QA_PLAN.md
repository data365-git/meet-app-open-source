# QA Plan — Ustoz Meeting Recording + UX/UI Deep Audit — 2026-07-18

## Verifiable goal

Try to refute both recording guarantees and judge whether a non-technical Uzbek IT-team member can confidently start, monitor, pause, stop, recover, and find a meeting recording without silent loss or misleading UI.

## Audit targets

- Recording reliability source of truth: read-only frozen worktree `D:\vibecoding\_audit-frozen-94af12d`, commit `94af12d`.
- Live UX/UI target: `https://data365.duckdns.org`, currently older production code per project state.
- In-flight comparison only: dirty `D:\vibecoding\ustoz-github`; findings against it are labelled as in-flight and cannot be release proof.
- No extension installation, permission grant, authenticated production write, upload, deploy, commit, or push.

## User and screen job

- Audience: an Uzbek-speaking, non-technical team member already inside a Google Meet.
- Single job: record the whole meeting with remote voices, understand the current state at a glance, stop safely, and know where the saved video is.
- Desired product character: calm recording cockpit; red only for live/danger, blue for the primary action/progress, green for saved, plain language for recovery.

## Evidence

- Fresh focused test output from the frozen code through the main checkout's installed dependencies.
- Exact file/line traces for state, concurrency, upload, audio, pause/stop, and recovery paths.
- Live browser DOM/runtime/playback checks on public production surfaces.
- Visual/accessibility inspection of extension popup and recorder-page implementation; real extension UI remains `Unverified` unless loaded in Chrome with owner permission.

## Stage status

| Stage | Status |
|---|---|
| 0 — Plan and freeze target | Complete |
| 1 — Map recording and UX states | Complete |
| 2 — Focused smoke and attack tests | Complete |
| 3 — Live desktop/mobile interaction review | Partial: desktop complete; mobile unverified |
| 4 — Reproduce and rank failures | Complete |
| 5 — Hardening and recovery audit | Complete |

## Focused commands

```powershell
pnpm --filter @cap/browser-extension test
pnpm --filter @cap/browser-extension build
pnpm --filter @cap/web test -- <recording-focused files>
pnpm typecheck
```

The production webpack build is not repeated in this audit because Run 8 already established a 15-minute timeout; this run concentrates on the recording heart and interaction quality.
