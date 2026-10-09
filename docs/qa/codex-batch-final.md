# Codex Batch FINAL — remaining straightforward QA fixes (security/engine + tiny UI)

You are fixing confirmed bugs in the Ustoz app (self-hosted Cap fork; Next.js 16 App Router, React 19, Drizzle + MySQL, next-auth). Repo root is the current directory.

## RULES (read carefully)
- Make ONLY the changes listed below. Do NOT refactor, rename, or reformat unrelated code. Do NOT touch git.
- Match existing patterns already in the codebase. Look at neighbouring files for the canonical style (auth helper is `getCurrentUser()`; view policy is `packages/web-backend/src/Videos/VideosPolicy.ts`).
- Keep each fix minimal and type-safe. No `as any`, no `@ts-ignore`.
- For EACH fix: first open the cited file and CONFIRM the bug is real. If it is already fixed or not actually a bug, SKIP it and say so in your report — do not invent a change.
- After all edits, run the REAL typecheck from the repo root: `pnpm typecheck` (this runs `next typegen && tsc -b`). Node may need PATH: prepend `C:\Program Files\nodejs`. Do NOT use `pnpm -F @cap/web typecheck` — that is a no-op that always passes and verifies nothing.
- Report at the end: files changed, the `pnpm typecheck` result, and any fix skipped + why.

## GROUP A — security / engine (these survive the upcoming UI redesign — do them well)

1. **F024 — `apps/web/app/api/videos/[videoId]/retry-transcription/route.ts`** (~line 40-43): when re-transcribing, the handler INSERTs new `transcriptChunks` without removing the old ones, so the transcript context DOUBLES on every retry. Fix: DELETE the existing `transcriptChunks` rows for that `videoId` BEFORE the re-INSERT (use the existing Drizzle delete pattern). Make it idempotent.

2. **F025 + F031 — `apps/web/app/api/video/ai/chat/route.ts`** (same file, two related fixes):
   - **F025**: there is no rate limiting on this POST. Check the repo for an existing rate-limit helper/util first; if one exists, apply a sane per-IP (or per-video) limit. If NONE exists, add a small in-memory fixed-window limiter (e.g. N requests per minute per IP) in this route only — keep it simple, no new deps. Return HTTP 429 when exceeded.
   - **F031**: the chat forwards the FULL `messages` history to Gemini unbounded. Cap it to the most recent N messages (e.g. `MAX_MESSAGES = 20`) before sending, so token cost and context length stay bounded.

3. **F028 — `packages/web-backend/src/Videos/VideosPolicy.ts`** (~line 54-57, `buildCanView` / the canView builder): for a NON-EXISTENT video the `onNone` branch effectively returns `true`, which can expose IDOR if a caller forgets to `notFound()`. Change the not-found branch to return `false` (deny). (Note: `isOwner`'s onNone was already fixed to false in a prior commit — apply the same safety to the view path.) Confirm the exact location first.

4. **F029 — `apps/web/app/api/video/og/route.ts`**: this Open Graph endpoint may leak metadata (title etc.) of PASSWORD-PROTECTED or private videos to social crawlers. Add a guard: if the video has a password set OR is not public, return generic/empty OG metadata (do NOT include the real title/description). Confirm what fields are exposed before editing.

5. **N019 — `packages/web-backend/src/ImageUploads/index.ts`** (~line 28, 33): the upload `contentType` has no allowlist, so an attacker could store `text/html` or `application/javascript` → stored XSS. Add an allowlist of image MIME types only (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/avif`) and reject anything else before the S3 put.

## GROUP B — tiny UI fixes (NOTE: this dashboard/share UI is slated for a Phase-1 rewrite, so keep these to the absolute minimum — 1-3 lines each)

6. **F016 — `apps/web/components/VideoThumbnail.tsx`** (~line 51-58, 104, 166): the no-thumbnail placeholder picks its gradient color with `Math.random()` IN RENDER, causing a server/client hydration mismatch (console error on every dashboard load). Fix: derive the gradient deterministically from the video id (e.g. hash `video.id` to an index into a fixed palette). Same color server and client. Remove the `Math.random()`.

7. **F017 — `apps/web/app/(org)/dashboard/caps/components/Folder.tsx`** (~line 256-289): after a successful drag-drop folder MOVE, the UI is stale until manual reload. Add `router.refresh()` after the move action resolves (match how other mutations in this dir refresh).

8. **F018 — `apps/web/app/(org)/dashboard/caps/components/CapCard.tsx`**: the "View analytics" link points to `/dashboard/analytics/s/[capId]` which 404s. Find the correct existing analytics route in the app (grep the `app/(org)/dashboard` tree) and fix the href to the real path. If no analytics page exists at all, remove/disable the broken link instead.

9. **F032 — `apps/web/app/(org)/dashboard/settings/account/components/ApiKeysSection.tsx`** (~line 59-72): deleting the Gemini API key has no confirmation, so an accidental click permanently loses it. Add a simple confirm step before the delete (use the codebase's existing confirm/dialog pattern if one exists; otherwise a `window.confirm`).

## Report
List the files you changed, the `pnpm typecheck` result, and any fix you skipped + why. Do NOT run git.
