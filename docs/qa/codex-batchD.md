# Codex Batch D — surgical security + devtools (parallel-safe; own ONLY listed files)

Fixing confirmed bugs in Ustoz (Next.js 16). Repo root = current dir.
RULES: ONLY these changes; do NOT touch other files; do NOT run git; do NOT run typecheck/build (shared type output is owned by another process). Minimal + type-safe.

ONLY edit: `apps/web/instrumentation.ts`, `apps/web/actions/videos/password.ts`, and the file that renders TanStack Query Devtools (find it: grep `ReactQueryDevtools`).

## Fixes
1. **N001 — `apps/web/instrumentation.ts`**: the Axiom token is exposed to the browser via `NEXT_PUBLIC_`. Rename `NEXT_PUBLIC_AXIOM_TOKEN` → `AXIOM_TOKEN` and `NEXT_PUBLIC_AXIOM_DATASET` → `AXIOM_DATASET` (drop the `NEXT_PUBLIC_` prefix so the secret is NOT inlined into the client bundle). `register()` runs server-side only, so server env is fine. Update all references in this file.
2. **F009 — `apps/web/actions/videos/password.ts`** (`verifyVideoPassword`): add an in-memory rate limit to stop brute-forcing. Use `headers()` from `next/headers` to read the client IP (`x-forwarded-for` first entry, else `x-real-ip`, else `"unknown"`). Limit ~10 attempts per (videoId + IP) per 5 minutes (simple Map-based counter, like the one in `apps/web/app/api/video/ai/chat/route.ts`). Return a clear "too many attempts" error when exceeded; do not reveal whether the password was right.
3. **L2 — TanStack Query Devtools**: in the file that renders `<ReactQueryDevtools .../>`, set `initialIsOpen={false}` and only render it in development (`process.env.NODE_ENV !== "production"` guard) so it does not auto-open over the UI.

## Report
Files changed + anything you could not safely fix. Do NOT run git/typecheck.
