# QA Report — Ustoz Run 8 — 2026-07-18

## Verdict

**NOT PRODUCTION-READY.** The public deployed watch path works, but the tested local tree is dirty, changed while QA was running, is not the deployed version, has a nondeterministic web-test gate, and did not complete the production webpack build within 15 minutes. Four High risks remain in security, secret hygiene, payment idempotency, and silent meeting-audio loss.

No application code, production data, accounts, deployment, or external service was changed during this QA run.

### Changes made by this QA run

- Added the QA evidence files under `docs/qa/run-8/`.
- Added the Run 8 continuity summary to `docs/STATE.md`.
- Added the user-facing report under the Codex task `outputs/` folder.
- Verification commands regenerated local build artifacts, including the extension `dist/` output and Next.js `.next/` output. These are build products, not application-source edits.
- Nothing was staged, committed, pushed, or deployed.

The source snapshot was not stable: later status output showed additional modifications to CI and account-deletion files that were absent from the initial status. Results below apply to the code observed at each check; a final release candidate must be frozen and rerun through the gates.

## Findings

### High — Admin password reset does not revoke existing sessions

- `apps/web/actions/admin/reset-user-password.ts:46-51` updates only `passwordHash`.
- The parallel reset implementation in `apps/web/actions/admin/access.ts:306-314` also increments `authSessionVersion`.
- Session enforcement in `packages/database/auth/auth-options.ts:27-49` rejects a session only when this version changes.
- Impact: after an emergency password reset, a stolen or already-open session can remain usable.

### High — Reusable admin browser state is present and not ignored

- Untracked `apps/web/.auth/admin-storage-state.json` exists and is used by `apps/web/_probe-dashboard.mjs:15`.
- The file is not covered by the repository ignore rules.
- Its contents were deliberately not inspected.
- Impact: an accidental commit or upload could expose a reusable admin session cookie. This is a risk finding, not evidence that it has already leaked.

### High (conditional: Stripe disabled now) — Concurrent webhook delivery can double-credit an account

- `apps/web/app/api/webhooks/stripe/route.ts:169-201` performs duplicate lookup and balance increment as separate operations.
- `packages/database/schema.ts:1389-1404` has an index on the reference but no unique constraint.
- Impact: two concurrent deliveries can both pass the read check and both add credit.

### High — “Meet tab only” can silently produce video without meeting audio

- `apps/browser-extension/src/popup/popup.ts:253-268` offers the path.
- `apps/browser-extension/src/offscreen/recorder.ts:103-128` falls back to video-only when combined capture fails.
- There is no equally strong liveness/watchdog warning on this path.
- Impact: the app can report recording success while the meeting conversation is absent, violating the primary product goal.

### Medium — Web unit suite is nondeterministic

- Fresh full run 1 exited 0.
- Immediate full run 2 failed: 6 failures in `health-readiness.test.ts`, 985 passed, 26 skipped.
- The focused file then passed 7/7 using the package test command.
- Impact: the release gate can be green or red without a code change, so it cannot reliably protect production.

### Medium — Production-equivalent webpack build was not proven

- The normal Turbopack build passed in 125.4 seconds.
- The real Docker-path `next build --webpack` stayed CPU-active but returned no result before the 15-minute limit.
- Impact: the build actually used for production remains unverified on this tree.

### Medium — Live deployment is older and lacks the new global security headers

- Project state says production remains on `f2e64a6`, while local HEAD is `94af12d` plus uncommitted changes.
- Live `/login` returned CSP `frame-ancestors` and `X-Frame-Options`, but no HSTS, `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy`.
- Impact: live checks cannot validate current fixes, and browser hardening committed later is not deployed.

### Medium (conditional: Stripe disabled now) — Retry response can suppress provider retries

- Stripe error branches return HTTP `202` at `route.ts:267-273` and `359-365` while comments expect the provider to retry.
- A success-class response normally acknowledges the webhook.
- Impact: a temporary internal failure can become a permanently missed update.

### Medium (conditional: Stripe disabled now) — Webhook logs include customer data

- The route logs emails, user/account identifiers, session fields, and metadata at multiple success/error branches.
- Impact: production logs can retain more personal and billing context than operations need.

### Medium — Account deletion does not yet meet the owner-approved erasure contract

- The current flow does not prove a full inventory purge and does not require the exact typed confirmation phrase.
- Impact: privacy expectations and misclick protection remain incomplete.

### Low — Invalid/private share page is not localized

- On the Uzbek live site, an invalid share ID shows “This video is private” and “sign in” in English.
- The HTTP response is `200`; no video metadata was exposed.

## Live evidence

- `/api/health` reported DB and storage healthy.
- Login, signup, privacy, and terms routes returned `200`.
- Login DOM contained Uzbek email/password fields, show-password control, legal links, and a submit button.
- Public share `fm3pz7yref328m7` loaded the correct 52:51 recording, summary, tasks, transcript, comments, and AI assistant.
- Clicking the exact play control advanced the video to 32.32 seconds with `readyState: 4` and no media error; it was paused afterward.

## Unverified

- Screenshot capture repeatedly timed out in the in-app browser.
- The viewport override remained 1280 px after requesting 390 px, so mobile layout is not claimed as verified.
- Authenticated dashboard, signup submit, uploads/import, AI writes, account changes, real extension permissions, and destructive flows were not exercised on production.
- The owner-physical three-minute Google Meet → stop → dashboard → play-to-end gate remains required.
