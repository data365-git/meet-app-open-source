# Codex — N002: make the S3/MinIO bucket private (remove public-read policy)

RULES: own ONLY `apps/web/instrumentation.node.ts`. Do NOT edit any other file; do NOT run git; do NOT run typecheck/build.

## Context
`createS3Bucket` applies a bucket policy that grants `s3:GetObject` to `Principal: "*"` for the whole bucket — every object (recordings, thumbnails) is publicly readable by URL, which bypasses the app's access control (private videos are not actually private at the storage layer). All legitimate reads already go through **presigned URLs** (playback via `/api/playlist`, thumbnails via `/api/thumbnail`), so public-read is unnecessary.

## Fix
Remove the public-read bucket policy — the `PutBucketPolicyCommand` (or equivalent) that sets `Principal: "*"` / `s3:GetObject`. Keep bucket creation and the CORS setup intact. Do NOT add any replacement policy. If that policy step has its own try/catch or helper, remove the whole apply-public-policy step cleanly so it is never applied. Add a short comment noting objects are served via presigned URLs only.

## Report
Show exactly what you removed (lines) and confirm bucket creation + CORS remain. Do NOT run git/typecheck.
