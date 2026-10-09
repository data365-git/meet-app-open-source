# QA Run 10 — Meeting Recorder Fix Verification

Date: 2026-07-18

## Goal

Independently verify whether the recorder defects documented in `docs/plans/2026-07-18-meeting-recorder-final-hardening.md` were fixed in the post-Claude candidate.

## Scope contract

Only verify meeting-recorder audio guarantees, truthful Pause/Resume, permanent discard and offline recovery, full-screen surface validation, and their visible controls. Do not change app behavior, production data, deployment, infrastructure, or unrelated code.

## Frozen candidate

- Branch: `qa-fixes`
- HEAD/origin: `81827a160033fe2e74614c797fb80c7f2165e520`
- Recorder implementation commit: `cdf521b`
- Recorder source files are clean relative to HEAD. Existing dirty/untracked infrastructure and scratch files are outside this audit.

## Platform and tools

- Chrome Manifest V3 browser extension
- Next.js web API and Effect-based backend service
- Vitest unit/integration tests
- Extension build script
- TypeScript/Next type gates
- In-app browser or Chrome for visible UI/runtime inspection

## Defects under verification

1. Permanent discard used a seven-day soft-delete route.
2. Offline discard did not retain a durable server-cleanup retry.
3. Tab-only capture could silently fall back to video-only or lose its client-audio guarantee.
4. Pause/Resume and discard UI could claim an unacknowledged state; the persistent recorder page lacked Pause/Resume.
5. Meeting full-screen mode only hinted `monitor` and did not validate the selected surface.
6. Restart/retry completion could stomp newer recorder state or leave cleanup incomplete.

## Evidence commands

```text
git show --stat cdf521b
rg-based source/test trace for each defect
pnpm --filter @cap/browser-extension test -- --reporter=basic
pnpm --filter @cap/browser-extension build
pnpm --filter @cap/web test -- video-permanent-delete
pnpm --filter @cap/web exec tsc --noEmit
git diff --check
git diff --stat
git diff --stat -w --ignore-cr-at-eol
```

The exact focused web-test command may be adapted to the repository's Vitest invocation.

## Evidence locations

- Flow map: `docs/qa/run-10/QA_FLOWS.md`
- Smoke gates: `docs/qa/run-10/QA_SMOKE.md`
- Execution/verdict: `docs/qa/run-10/QA_REPORT.md`
- Hardening review: `docs/qa/run-10/QA_HARDENING.md`

## Stage status

- Stage 0 Plan: complete
- Stage 1 Map: complete
- Stage 2 Smoke: complete — executable gates green; live Chrome startup unverified
- Stage 3 Execute: complete — source, built bundle, executable probes; live Chrome/device flows unverified
- Stage 4 Fix/re-verify: complete — verification only; no app fixes were authorized or made
- Stage 5 Harden: complete

## Verdict rule

A defect is `Verified fixed` only with fresh executable evidence and, for visible behavior, a live UI/runtime observation. Code inspection alone is `Implemented, not fully verified`. Chrome/Meet behaviors that require a real capture, remote participant, offline restart, or storage inspection remain `Unverified` until observed on the exact packaged candidate.
