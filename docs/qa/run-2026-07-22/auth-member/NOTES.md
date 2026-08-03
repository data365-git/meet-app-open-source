# Flow B (Auth) + Flow M (Member) — run notes, 2026-07-22

Executor: auth-member sub-agent. Prod: https://data365.duckdns.org. App container
`pokroz1qrj8wfc82bl63ns2c-090927310642`, image tag `201165f4f04b5b8ec18421c3f2600102145d17a2`
(matches build 201165f) — confirmed via `docker ps` before any test.

## Users on prod right now (read-only, via §1.3 SSH+mysql recipe)
```
id               email                              name                  isAdmin  authSessionVersion
25s3fqp7e7vc5p0  admin@ustoz.uz                      Admin                 1        1
8p1ka4dp1q2c7gx  mirkomilovabrorwork@gmail.com       abror                 1        0
khc8kfjxtw7s7fk  mirkomilovabror7@gmail.com          Abrorbek Mirkomilov   1        0
qa0pool0loop000  qa.pool.loop@data365-test.uz        QA Pool               0        0
```
`organization_members` (note: real table name is snake_case `organization_members`,
NOT `organizationMembers` — the plan's SQL needs that adjustment):
```
id               userId            organizationId   role
6csdcm791ndh902  25s3fqp7e7vc5p0   fjgf6h4p46ym40s  owner
enrqwcb2s7ffhwe  8p1ka4dp1q2c7gx   fjgf6h4p46ym40s  admin
ne711hpsw3mg0rv  khc8kfjxtw7s7fk   fjgf6h4p46ym40s  member
```
`qa0pool0loop000` has **zero** rows in `organization_members` and
`users.activeOrganizationId = NULL`.

## IMPORTANT — fixture-vs-reality mismatch discovered
The `memberSession` fixture handed to this run (`qa0pool0loop000`) is documented
in `docs/qa/SESSION_INJECTION_NOTES.md` as a "non-admin member," but the live DB
shows it is actually a **Requester with zero org membership**, not a Member.
Every `/dashboard/*` route for this session renders the `<PendingAccess/>` screen
(confirmed by body content, see M1/M4 evidence below) — never real dashboard
content. This is exactly the profile Flow B's A3/A4 need (so it was reused for
those), but it is NOT usable for Flow M's "real member sees the dashboard" checks
(M1 content parts, M2, M6) or M4 (which needs a genuine non-admin **org role**).

To close that gap for M4/M6, one additional session was minted (sanctioned §1.2
recipe, no DB write) for the existing real user `khc8kfjxtw7s7fk`
(mirkomilovabror7@gmail.com), whose real `organization_members.role` is `member`
(not owner/admin) — confirmed live to be a real, working member session
(`/dashboard/caps` → 200 with real content). Mint script deleted from both
container `/tmp` and host `/root` immediately after (verified gone by `ls`).
No DB rows were created, changed, or deleted at any point in this run.

## A2 — signup creates no org membership (code-read + DB, no live signup — sanctioned)
`apps/web/actions/auth/signup.ts`:
- Transaction inserts only into `users` (line 112-125); `activeOrganizationId` is
  explicitly `null`; comment states no `organizationMembers` row is ever created.
- Grepped the whole `apps/web` tree for every `.insert(organizationMembers)` /
  `organizationMembers).values(` call site — the only 6 hits are all in
  admin-approval/invite flows (`actions/admin/access.ts`, `actions/auth/invite.ts`,
  `actions/organization/invite-member.ts`, `actions/organization/invite-by-email.ts`,
  `app/api/invite/accept/route.ts`, `components/forms/server.ts`). `signup.ts`
  itself never touches that table.
- Live DB corroboration (not a fresh signup created this run — no write was made):
  `qa0pool0loop000` (isAdmin 0, the only non-admin real user in prod) has **0**
  `organization_members` rows, consistent with the code guarantee.
- What a live disposable-signup would add beyond this: proof that the *actual*
  running `signUp()` server action (not just the source) produces this same
  state end-to-end today, including the email-domain-allowlist and duplicate-email
  branches. Not done — would require a real write, out of scope per the hard rules.

## A5 — empty-name onboarding gate (code-read only, no live subject exists)
`app/(org)/dashboard/layout.tsx:30-35`:
```
const user = await getCurrentUser();   // real DB row, not the JWT claim
if (!user) redirect("/login");
if (!user.name || user.name.length === 0) redirect("/onboarding/welcome");
```
`getCurrentUser()` (`packages/database/auth/session.ts:15-27`) always re-queries
the DB by `session.user.id` — so a minted token's `name` claim is NOT what this
gate checks; it checks the real `users.name` column. All 4 real users in prod
have a non-empty name, and creating a user with an empty name is not a sanctioned
QA write, so this could not be exercised live. `/onboarding/welcome` confirmed to
exist (307 redirect-to-login when hit logged-out, i.e. it IS a real protected
route, not a 404). What a live test would add: an actual empty-name DB row to
confirm the redirect fires in practice, not just in source.

## M-DEL — deletion cascade (code-read only, no live delete performed)
`apps/web/actions/account/delete-account.ts`:
- Phrase gate at :29/:37 — exact literal `"delete my all data"`, checked server-side
  before anything else runs.
- Final cascade (:104-153) IS wrapped in try/catch; on failure it returns an error
  and does **not** partially commit (it's one `db().transaction()`), matching the
  C1 fix intent — a failed run does not leave the account in a half-deleted state.
- Ownership rule (:50-69): only a SOLE-member org is deleted with the account;
  an org with other members blocks deletion with a clear error (their data is
  never touched).
- `aiUsageEvents` deleted by `userId` (:112-113) — checked schema.ts: this is the
  **only** FK in the entire schema that points at `users.id`
  (`ai_usage_events_user_fk`, no `onDelete`, i.e. RESTRICT) — grepped every
  `foreignColumns: [users.id]` occurrence, exactly one hit. So this is also the
  ONLY row that could hard-block the final `users` delete, and it is correctly
  cleared before the `users` delete (and before the sole-member org delete too,
  via the org-scoped `aiUsageEvents` clear at :138-140, since a leftover
  ex-member's rows could otherwise block the org delete).
- Erasure inventory checked against the plan's list: recordings/storage/transcripts
  → `Videos.permanentlyDelete` per owned video, storage objects first (:76-96);
  AI → `aiUsageEvents`; comments → `comments`; API keys → `authApiKeys`;
  analytics → no dedicated table exists (grepped schema.ts for "analytics" —
  zero matches; the analytics dashboard is computed from videos/ai_usage_events,
  which are already purged).
- Not touched by design (checked, not a bug): `audit_log.actorUserId` and
  `invites.createdByUserId/usedByUserId` have no FK to `users.id` and are
  historical/audit records — intentionally outliving the account, same posture
  most audit trails take. `ai_chat_usage.clientId` (a bare varchar, no FK either)
  can leave a soft-orphan rate-limit-counter row if the deleted user ever chatted
  as a member; harmless (never looked up again once the user is gone), not
  purged today — worth a nit for the team's backlog, not a blocker.
- What a live disposable-user+recording test would add beyond this: proof the
  `Videos.permanentlyDelete` Effect pipeline actually succeeds against real R2/S3
  storage and a real transcript, and that a forced FK-failure mid-transaction
  truly leaves the account retry-able (the try/catch's *intent* is confirmed by
  reading it; a real forced failure was not staged, per the no-DB-write rule).

## M3 — extension zip version (full live proof)
- `/dashboard/extension` page's download link → `/365-extension.zip` (confirmed
  via admin-session HTML).
- `curl` on the zip: `200 OK`, `Content-Type: application/zip`,
  `Content-Length: 472188` (~472 KB, matches expected).
- Unzipped, `manifest.json` → `"version": "0.5.3"` — matches the deployed build
  under test. Zip binary itself deleted after checking (kept only
  `M3_extension_manifest.json` as evidence, to avoid parking a 472 KB binary in
  the repo).

## M5 — ai-spend numbers cross-checked against DB (exact match)
The admin-session HTML embeds `getOrgAiSpend`'s server-computed aggregates
verbatim: `\"totalUsdCents\":570` (this month) and `\"totalUsdCents\":43` (last
month). Independent DB query (`SELECT billingMonth, SUM(costUsdMicros)/1e6 ...
GROUP BY billingMonth`) for this org returned `2026-07 -> 5.700007`,
`2026-06 -> 0.431267`. 570¢ = $5.70 and 43¢ = $0.43 — **exact match** (rounding
aside) to July/June respectively. Numbers are correct, not fabricated.

## A4 — upload-init route detail
The video id used (`15xgcytw49pmrj8`, from fixtures) is owned by `admin@ustoz.uz`
(`25s3fqp7e7vc5p0`), confirmed via DB — NOT owned by the no-org test user, so this
exercises the ownership/ai-access gates as intended:
- `POST /api/videos/<id>/generate` as the no-org user → **403** `{"error":"ai_access_required"}`
  — clean match to the code's `canUseAI(user)` gate (`generate/route.ts:51-53`),
  checked before ownership is even looked at.
- `POST /api/upload/multipart/initiate` as the no-org user → **500**
  `{"error":"Error initiating multipart upload"}`, NOT 403/401/404 as the plan
  expected. Traced in code (`app/api/upload/[...route]/multipart.ts:107-156`):
  the ownership `Policy.withPolicy(policy.isOwner(videoId))` denial is caught by
  a generic `Effect.catchAll` that only special-cases `VideoNotFoundError` (→404);
  any other error (including a policy denial) falls through to the generic 500
  branch. **No write happened** (the S3 multipart-create call is in a later block
  that is never reached), so this is not a security hole — but it is a
  should-severity API-hygiene bug: a legitimate ownership/auth denial is reported
  to the caller (and to any log/monitoring) as a 500 Internal Server Error instead
  of 401/403/404.
