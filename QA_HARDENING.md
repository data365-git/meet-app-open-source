# QA Hardening — Ustoz/data365 — RUN 7 — 2026-07-14

This is an evidence-backed static/runtime audit. Secret values are intentionally
omitted. Production mutations were not used to prove findings.

## Critical

### 1. Admin credential is tracked in Git history and current documentation

`docs/STATE.md` at HEAD contains six matches for the known admin password, and
`git log -S` traces the introduction to historical commit `436ac3c`. Validity
was not tested. Treat the credential as compromised: rotate it first, remove it
from current docs, then plan any history rewrite separately with explicit owner
coordination because rewriting shared history is disruptive.

## High

### 2. Secret-rich environment backup was not ignored

`.env.bak-stale-20260112` contains database, auth, encryption, workflow, R2 and
AI secret keys. It was untracked but not ignored at audit start. RUN 7 added
`.env.bak*` and `.env.backup*` to `.gitignore` and verified the exact file is
now ignored. The residual risk is that the backup still exists inside the repo
directory; move secrets to an approved secret store after owner review.

### 3. Public signup marks arbitrary email as verified

`apps/web/actions/auth/signup.ts:162-191` creates the user with
`emailVerified: new Date()` and joins the default organization. The action has
no mailbox proof and no durable abuse limiter. A configured domain allowlist
reduces scope but does not prove identity. Add OTP/email verification and a
shared rate limit before treating open signup as production-safe.

### 4. Account deletion can orphan videos and stored objects

`apps/web/actions/account/delete-account.ts:20-39` deletes membership, session,
account and user rows but does not transfer or delete videos/storage.
`packages/database/schema.ts:357-362` has no owner FK/cascade protecting the
video lifecycle. Define transfer/delete policy and perform it transactionally.

### 5. Application startup can mutate the database and serve after failure

`apps/web/instrumentation.node.ts:14-45,111-124` schedules migrations on every
self-hosted/Docker start and retries three times. RUN 7 reproduced attempts
against the configured remote database; they failed because the migration
journal was absent, then the server continued. Separate deploy migration from
web startup, require an explicit server-only flag, and fail health/readiness if
the required schema migration fails.

## Medium

### 6. Space deletion is not transactional

`apps/web/actions/organization/delete-space.ts:62-92` deletes related rows in
separate operations, performs best-effort object deletion, and deletes the space
last. A mid-sequence failure leaves partial state. Use a DB transaction and a
retryable/outbox-backed object cleanup policy.

### 7. Audit logging failures are silent

`apps/web/lib/audit.ts:12-14` swallows every insert error, while destructive
callers fire-and-forget. Important actions may become untraceable. At minimum,
emit structured errors/metrics; decide which operations require durable audit
success before commit.

### 8. AI metadata update can lose concurrent changes

`apps/web/app/api/videos/[videoId]/generate/route.ts:118-135` writes a metadata
object derived from an earlier unlocked read. The repository already has
`withLockedVideoMetadata` in `apps/web/lib/video-metadata.ts:16-33`. Use that
row-lock helper for this branch.

### 9. Login and paid reprocess limits are process-local

`packages/database/auth/login-throttle.ts:12-47` and
`apps/web/lib/reprocess-rate-limit.ts:27-45` store attempts in module `Map`s.
Restarts and multiple replicas reset/multiply quotas. Use shared durable storage
and include source/IP policy carefully to avoid account-lockout abuse.

### 10. Recovery crons scan unbounded candidate sets

`recover-stale-ai-jobs/route.ts:112-256` and
`poll-batch-jobs/route.ts:68-112` select all candidates and process serially
without a limit. Large backlogs can time out before later items recover. Add
bounded batches, ordering, continuation and per-run metrics.

## Release-process findings

- Biome CI is red: 1,240 errors and 226 warnings. Fix in a dedicated formatting
  campaign; do not mix it with product changes.
- Cloudflare worker typecheck is currently un-runnable because its types are not
  installed through the active workspace setup.
- Turbopack warns that `audio-extract.ts` can trigger an unexpectedly broad file
  trace. Measure image size and scope filesystem paths before dismissing it.
- Node v24 was used locally while CI targets Node 20; exact runtime parity is not
  proven.

## Positive controls verified statically

Cron bearer comparison uses timing-safe equality; primary video AI routes have
owner/admin checks; the metadata helper supports transaction + `FOR UPDATE`;
user Gemini keys are encrypted at rest.

## Required owner decisions

1. Rotate the exposed admin credential now; history cleanup comes only after a
   scoped coordination plan.
2. Choose account-deletion behavior: transfer owned videos, soft-delete them,
   or delete DB + storage with a recovery window.
3. Approve moving migrations out of web startup into an explicit deploy step.

