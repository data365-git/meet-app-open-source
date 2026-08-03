# Codex Batch 2 — SSRF, input-validation & access guards (round 2)

Fixing confirmed security bugs in the Ustoz app (Next.js 16, Drizzle+MySQL, Effect-based web-backend). Repo root = current dir.

RULES: make ONLY the listed changes; no unrelated refactors/reformat; do NOT touch git. Match existing patterns. Keep each fix minimal + type-safe. After all edits run `pnpm -F @cap/web typecheck` (PATH may need `C:\Program Files\nodejs`) and report the result + any fix you could not safely make.

## Fixes

1. **N009 — Loom import email gate** (`packages/web-backend/src/Loom/Http.ts` ~24-25, and the same gate duplicated in `Loom/Http/Live.ts`, `Loom/ImportVideo.ts`, `Workflows.ts`): replace `email.endsWith("@cap.so")` with an EXACT domain-segment match (e.g. `email.split("@").at(-1) === "cap.so"`), so `attacker@evil.com@cap.so` / `x@hackcap.so` are rejected. Replace the `Effect.die` rejection with a typed Unauthorized/PolicyDenied error (not a 500 defect).

2. **N010 — SSRF in Loom import** (`packages/web-backend/src/Loom/ImportVideo.ts` ~21,118): before any server-side fetch of `payload.loom.video.downloadUrl`, validate the host: must be https and an allowlisted Loom/CDN host (e.g. `*.loom.com`, `cdn.loom.com`, known Loom CDN); REJECT loopback / link-local / RFC-1918 / non-https. Redact the full signed URL from any `Effect.log` (log only the host or an id).

3. **N011 — unauth ffmpeg transcode** (`apps/web/app/api/tools/loom-download/route.ts` ~162-297): require authentication (getCurrentUser) on the handler; validate the `cdnUrl` host with the same allowlist as N010; add a Content-Length guard (reject oversized) and an ffmpeg timeout. (A simple concurrency guard is a plus but optional.)

4. **N013 — cross-tenant bucket creds** (`packages/web-backend/src/S3Buckets/S3BucketsRepo.ts` ~146-158): `getById` must not return any bucket by id alone. Add an owner/org-scoped variant (e.g. `getByIdForOwner(bucketId, ownerId)`) and switch the USER-INPUT-driven call sites to it; leave trusted/internal callers working. Ensure typecheck passes (update call sites as needed).

5. **N015 — video metadata overwrite** (`apps/web/app/api/video/metadata/route.ts` ~33-38): ownership is already checked; add a server-side ALLOWLIST of user-editable metadata fields and MERGE them into existing metadata (do not replace the whole JSON column, so server fields like `aiSummary`/`chapters`/`aiGenerationStatus` cannot be spoofed or erased).

6. **N016 — stale signed-object token** (`apps/web/app/api/storage/object/route.ts` ~111-116): on the valid-token path, still run the video view policy (or re-verify `public`/password/email gating) before streaming, so a token issued before the video was restricted no longer grants access.

7. **N018 — cacheable signed GIF URL** (`apps/web/app/api/video/preview/route.ts` ~64-65): change the redirect `Cache-Control` from `public, max-age=300` to `private, no-store` (the redirect target is a credential-bearing presigned URL).

8. **N020 — image-upload content-type** (`packages/web-backend/src/ImageUploads/index.ts` ~28,33): allowlist image MIME types (png/jpeg/webp/gif/svg? — exclude text/html & application/javascript); derive the file extension from the validated type. Reject disallowed types.

9. **F008 — comment auth + disabled** (`apps/web/actions/videos/new-comment.ts` ~20-54): require an authenticated user to post a comment/reaction (reject anonymous), AND enforce the video/org `commentsDisabled` setting server-side (reject if comments are disabled). Keep the existing optimistic-UI contract working for the authed path.

## Report
Files changed, `pnpm -F @cap/web typecheck` result, and anything you could not safely fix (with why). Do NOT run git.
