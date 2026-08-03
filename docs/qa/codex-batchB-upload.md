# Codex Batch B — Web upload reliability (parallel-safe; own ONLY the files listed)

Fixing confirmed upload bugs in the Ustoz web recorder. Repo root = current dir.

RULES: make ONLY these changes; no unrelated refactor; do NOT run git; do NOT run typecheck or build (another process owns the shared type output). Minimal + type-safe.

ONLY edit these files (do NOT touch any other file):
`apps/web/utils/upload-target.ts`, `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts` (and `.../web-recorder-dialog/instant-mp4-uploader.ts` ONLY if strictly needed for types).

## Fixes
1. **F021** — `apps/web/utils/upload-target.ts` (`uploadWithTarget`, the XHR with `xhr.onerror`): wrap the single-part upload in a bounded retry loop (up to 3 attempts, exponential backoff ~500/1000/1500ms). Retry on network error / 5xx; reject only after retries are exhausted. Keep the existing progress + success contract.
2. **F020** — `.../web-recorder-dialog/useWebRecorder.ts`: add a `beforeunload` warning WHILE an upload/recording is active — register `window.addEventListener("beforeunload", handler)` when active and remove it when idle/complete — so a refresh/navigate during upload warns the user instead of silently orphaning the multipart upload.

## Report
Files changed + anything you could not safely fix (with why). Do NOT run git/typecheck.
