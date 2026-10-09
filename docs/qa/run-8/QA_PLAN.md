# QA Plan — Ustoz Run 8 — 2026-07-18

## Goal

Independently verify the current dirty `qa-fixes` working tree and the live Ustoz deployment with fresh command and browser evidence. The production-readiness priority is that a meeting must never fail to record.

## Scope

- Source tree: `D:\vibecoding\ustoz-github`
- Branch and HEAD baseline: `qa-fixes` at `94af12d`; the tested tree also contains substantial pre-existing tracked and untracked changes
- Live target: `https://data365.duckdns.org`
- Platforms: Next.js web app and MV3 browser extension
- Primary user: an Uzbek-speaking IT-team member recording a meeting and later reviewing or sharing it

## Safety boundary

- Read-only production QA: no deletes, uploads, account changes, invitations, paid AI generation, messages, deploys, pushes, or secret reads.
- Do not install or load the extension into the owner's browser without approval.
- Authenticated, destructive, device-capture, and paid flows are `Unverified` unless a safe existing session and read-only path are available.
- No app-code fixes in this run. Reproduced failures are reported first.

## Stages and proof

| Stage | Work | Evidence | Status |
|---|---|---|---|
| 0 | Detect platform, state, commands, targets, and safety | This file; `docs/STATE.md`; Git HEAD/status | Complete |
| 1 | Map journeys and edge states | `QA_FLOWS.md` | Complete |
| 2 | Typecheck, unit tests, production build, startup/health smoke | `QA_SMOKE.md`; fresh command output | Complete with failures |
| 3 | Live desktop/mobile interaction, console/runtime checks | `QA_REPORT.md`; browser DOM/runtime state | Partial: desktop live; mobile/screenshot capture unavailable |
| 4 | Reproduce and rank failures; no fixes without a new owner request | `QA_REPORT.md` | Complete |
| 5 | Security, data loss, recovery, portability, accessibility, observability | `QA_HARDENING.md` | Complete |

## Commands

Run from the repository root:

```powershell
pnpm typecheck
pnpm --filter @cap/web run test
pnpm --filter @cap/browser-extension run test
pnpm --filter @cap/web build
```

Exact package availability is confirmed before execution. The build gate must use the production-equivalent webpack path, not a turbopack substitute.

## Existing-tree note

The worktree intentionally contains many pre-existing tracked modifications and untracked recovery/QA files. This run writes only under `docs/qa/run-8/` plus the final continuity update in `docs/STATE.md`; it does not stage, remove, or rewrite unrelated files.
