# Codex Batch 1 — Surgical authorization/validation guards (low-risk security fixes)

You are fixing confirmed security bugs in the Ustoz app (self-hosted Cap fork; Next.js 16 App Router, Drizzle + MySQL, next-auth). Repo root is the current directory.

RULES:
- Make ONLY the changes listed below. Do NOT refactor, rename, or reformat unrelated code. Do NOT touch git.
- Match existing patterns. The auth helper is `getCurrentUser()` — see `apps/web/app/api/video/ai/route.ts` for the canonical "401 `{auth:false}` when unauthenticated" pattern, and `apps/web/app/s/[videoId]/page.tsx` + `packages/web-backend/src/Videos/VideosPolicy.ts` for the view/ownership policy.
- Keep each fix minimal and type-safe.
- After all edits, run `pnpm -F @cap/web typecheck` and make sure it passes (Node may need PATH: prepend `C:\Program Files\nodejs`). Report the result.

## Fixes

1. **F001 — `apps/web/app/api/video/ai/chat/route.ts`**: this handler has NO auth at all. Before processing, load the target video and enforce the SAME view policy the share page uses (`VideosPolicy` / canView): allow only if the video is public OR the requester is the owner OR it passes the existing password/email gating. Return 403 if not viewable. This preserves AI chat for legitimate public-video viewers while blocking access to PRIVATE videos by anonymous callers. If a rate-limiter helper exists in the repo, also apply a sane per-video/per-IP limit.

2. **N004 — `apps/web/app/api/thumbnail/route.ts`**: add `getCurrentUser()` + an ownership/public-access check before returning the signed S3 URL (mirror the view policy). Also remove the raw `error.message` from the 500 response body (return a generic message).

3. **N005 — `apps/web/actions/admin/access.ts`** (`getUsers`, ~line 35-40): remove `passwordHash` from the `select()` projection so it is never serialized to the client.

4. **N007 — `apps/web/app/api/analytics/track/route.ts`** (~147-151): derive `tenantId` ONLY from the server-side `videoRecord.ownerId` — never from `body.orgId` / `body.ownerId`. Clamp `body.occurredAt` to within ±5 minutes of now (otherwise use now).

5. **N008 — `apps/web/app/api/analytics/route.ts`** (~19-41): add a session + ownership/org check before returning `getVideoAnalytics`; remove the `console.log` of videoId/result.

6. **F022 — `apps/web/app/api/video/ai/route.ts`**: it authenticates but has NO ownership check. Add a check that the current user owns the target video before reading or triggering AI generation (return 403 otherwise).

7. **F023 — `apps/web/app/api/video/transcribe/status/route.ts`**: after the existing auth check, add the same ownership check (current user must own the video).

8. **N012 — `packages/web-backend/src/Videos/VideosPolicy.ts`** (`isOwner`, ~149-159): change the `repo.getById` `onNone` branch from `() => true` to `() => false`, so a non-existent video is NOT considered owned by anyone.

9. **N017 — `packages/web-backend/src/Spaces/SpacesRepo.ts`** (`passwordsForVideo`, ~32-43): do not return the raw `password` column to callers; compare in this layer (or return a minimal shape) and narrow the `select()` projection so space passwords are not leaked.

## Report
List the files you changed, the `pnpm -F @cap/web typecheck` result, and any fix you could NOT safely make and why. Do NOT run git.
