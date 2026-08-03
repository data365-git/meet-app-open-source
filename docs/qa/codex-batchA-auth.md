# Codex Batch A — Surgical auth fixes (parallel-safe; own ONLY the files listed)

Fixing confirmed auth bugs in Ustoz (Next.js 16, next-auth). Repo root = current dir.

RULES: make ONLY these changes; no unrelated refactor/reformat; do NOT run git; do NOT run typecheck or build (another process owns the shared type output). Match existing patterns; minimal + type-safe.

ONLY edit these files (do NOT touch any other file):
`apps/web/actions/auth/request-otp.ts`, `apps/web/actions/admin/access.ts`, `apps/web/app/(org)/login/page.tsx`, `apps/web/app/(org)/login/form.tsx`, `packages/database/auth/auth-options.ts`, `apps/web/actions/organization/invite-by-email.ts`, and whatever file(s) redirect to the non-existent route `/auth/signin`.

## Fixes
1. **F004** — `apps/web/actions/auth/request-otp.ts`: remove the `console.log` that prints the raw OTP code (search for `[OTP]` near code generation). Never log the code.
2. **F010** — `apps/web/actions/admin/access.ts` (`resetUserPassword`): after updating `passwordHash`, also increment the user's `authSessionVersion` (the same column `signOutAllDevices` bumps) so existing sessions are invalidated on a forced reset.
3. **F011** — grep for `/auth/signin` and change those redirects to `/login` (that route does not exist; `/login` does).
4. **F012** — `apps/web/app/(org)/login/form.tsx` (~L49-50, `window.location.href = dest`): before navigating, validate `dest` — allow ONLY a same-origin relative path: must start with `/` AND not start with `//` AND not contain `://`. Otherwise fall back to `/dashboard`.
5. **F013** — `apps/web/actions/organization/invite-by-email.ts`: do NOT persist a passwordless "ghost" `users` row for a non-existent email; represent it as a pending invite only (a user row is created when they actually accept/sign up). If fully reworking is too invasive, at minimum stop persisting a passwordless user that can never log in.
6. **F014** — `packages/database/auth/auth-options.ts` (~L57 `debug: true`): gate it behind `process.env.NODE_ENV !== "production"` (or remove), so NextAuth does not log tokens in production.

## Report
Files changed + anything you could not safely fix (with why). Do NOT run git/typecheck.
