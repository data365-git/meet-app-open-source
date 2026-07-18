# Ustoz Live QA — 2026-07-18

## Verdict

**NOT PRODUCTION-READY.** The live public playback path works, but the local release candidate is not frozen, the web test gate is nondeterministic, and the production webpack build was not proven within 15 minutes.

## Live proof

- Health endpoint: database and storage both `ok`.
- Login, signup, privacy, and terms routes: HTTP 200.
- Known public recording: 52:51 duration; summary, tasks, transcript, and AI assistant loaded.
- Exact play control advanced playback to 32.32 seconds with no media error; playback was paused afterward.
- Invalid share ID revealed no recording metadata.

## High findings

1. One admin password-reset path does not revoke existing sessions.
2. A reusable admin browser-state file exists locally and is not ignored.
3. Stripe credit idempotency is raceable if Stripe is enabled.
4. Meet-tab-only recording can silently fall back to video-only and lose meeting audio.

## Other blockers

- Repeated full web tests changed from green to 6 failures without a code change; the focused file then passed 7/7.
- Typecheck passed; extension tests passed 42/42; extension build and Turbopack build passed.
- The production `next build --webpack` timed out after 15 minutes.
- Live production is older than the tested tree and lacks the newer global security headers.
- Another writer changed the dirty tree during QA, so the evidence does not represent one frozen candidate.
- Mobile visual proof and the real three-minute Meet → dashboard → play-to-end device gate remain unverified.

## Changes made by the QA run

- No application-source code, account, production data, deployment, or external service was changed.
- QA files were added under `docs/qa/run-8/`.
- The Run 8 summary was added to `docs/STATE.md`.
- This user-facing report was added to the Codex task `outputs/` folder.
- Build checks regenerated local extension `dist/` and Next.js `.next/` artifacts.
- Nothing was staged, committed, pushed, or deployed.
