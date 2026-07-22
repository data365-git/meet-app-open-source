# E6b storage-integrity investigation — 2026-07-22

**Verdict: SYSTEMIC, but the mechanism is a false-positive CODE BUG in `reconcile-storage`
+ a UI that trusts it blindly — not real data loss, not an R2 lifecycle rule, not a
delete-path bug, not a key rotation.** 11 of the 13 flagged videos are fully intact and
still playable right now (confirmed live). 2 of 13 are genuinely-failed/abandoned
uploads that never had media in R2 in the first place (a separate, already-documented,
accepted limitation — not new).

This still needs a real fix: the bug is not a one-off, it is a standing landmine that
will keep mislabeling real future recordings as "gone forever" in front of the internal
team.

## Scope actually found (broader than the 8 COMPLETE videos in the original finding)

`storageMissing=true` on prod right now: **13 videos**, all owned by the single real
account `admin@ustoz.uz` (`25s3fqp7e7vc5p0`) — 7 of the 8 `COMPLETE` videos (all but
`t91bnh582gnhgy8`) **and** 6 of the 18 `transcriptionStatus IS NULL` videos. So the flag
is not specific to the COMPLETE bucket — it hits any video, regardless of transcription
status, whose optimize/finalize step didn't produce `result.mp4`.

## 1. Is the loss real? — ground truth via live R2 HEAD/LIST (read-only, app's own creds)

Ran a Node script inside the prod app container (`pokroz1qrj8wfc82bl63ns2c-*`, using its
own `CAP_AWS_*` env — same account/bucket as `docs/DEPLOY_SECRETS.md`, no key rotation)
against Cloudflare R2 directly. Full raw output: `r2-listing-all-13.json`.

Result for all 13 `storageMissing=true` videos:

| video id | result.mp4 | raw-upload.* | source/original.mp4 | verdict |
|---|---|---|---|---|
| q7qty7tw1dxgt5z | missing | **present** (2.6MB) | – | false positive |
| bbzt2424z6vvy6t | missing | **present** (58.5MB) | – | false positive |
| fm3pz7yref328m7 | missing | **present** (545MB) | **present** | false positive |
| aydm0823n9f20s4 | missing | **present** (62KB) | – | false positive |
| p52hh76m1epfhb3 | missing | **present** (2.5MB) | – | false positive |
| 15xgcytw49pmrj8 | missing | **present** (2.0MB) | – | false positive |
| j1q9mjg8kewr2en | missing | **present** (375MB) | **present** | false positive |
| 4bepm8mpa3y059p | missing | **present** (1.4MB webm) | – | false positive |
| 3ajv7sz0p0zsbad | missing | **present** (375MB) | – | false positive |
| gyfhg0pwjhb50yh | missing | **present** (375MB) | **present** | false positive |
| 0qqwsy3j4wr7q9y | missing | **present** (1.2MB webm) | – | false positive |
| br5rgj9a31a3y42 | missing | **absent** (0 objects) | – | **real, but see §5** — failed mid-upload (82%, `video_uploads.phase=error`, 308.5MB/375.5MB) |
| h6bsfryz7qkthw0 | missing | **absent** (0 objects) | – | **real, but see §5** — 0-byte upload attempt, `phase=error`, `raw_file_key=NULL`, and the row is already soft-deleted (`deletedAt` 1s after being flagged) |

**Live proof the "false positive" ones are actually playable right now** — a plain
read-only GET against the real playback endpoint (no auth needed, both videos are
public):

```
GET https://data365.duckdns.org/api/playlist?videoId=bbzt2424z6vvy6t&videoType=mp4
→ HTTP/1.1 302 Found
  Location: https://…r2.cloudflarestorage.com/ustoz-videos/25s3fqp7e7vc5p0/bbzt2424z6vvy6t/raw-upload.mp4?X-Amz-…

GET https://data365.duckdns.org/api/playlist?videoId=j1q9mjg8kewr2en&videoType=mp4
→ HTTP/1.1 302 Found
  Location: https://…r2.cloudflarestorage.com/ustoz-videos/25s3fqp7e7vc5p0/j1q9mjg8kewr2en/raw-upload.mp4?X-Amz-…
```

Full headers: `playlist-live-check.txt`. Both recordings the internal team is currently
being told are "unavailable" are, right now, one click away from playing fine — the
share page just never tries, because it trusts the DB flag first (see §3).

## 2. R2 lifecycle / expiry rule?

`GetBucketLifecycleConfigurationCommand` against the bucket → `AccessDenied` (the app's
R2 token isn't scoped to read bucket lifecycle config, so this couldn't be checked
directly via the API). However the behavioral evidence rules it out:
- `raw-upload.mp4` files from as far back as 2026-07-07 (15 days old at check time) are
  still present, untouched, same size, same `lastModified` as upload time — a lifecycle
  rule would have expired these long before the still-missing `result.mp4` files "expired."
- Only ever `result.mp4` is absent, never `raw-upload.*`/`transcription.vtt`/
  `source/original.mp4`/`screenshot/*` — a lifecycle rule matches by prefix pattern and
  age, it would not selectively spare every other object type while always striking one
  specific filename regardless of the video's age.
- §4 below shows `result.mp4` was never created for these videos in the first place —
  not created-then-expired.

**Conclusion: no evidence of a lifecycle rule causing this. Ruled out by pattern, not by reading the policy directly (that remains a minor open gap — see "Unresolved").**

## 3. A delete path removing media for a COMPLETE, non-deleted video?

Grepped every `DeleteObject`/S3 delete call in the repo
(`apps/web/actions/organization/delete-space.ts`, `upload.ts`,
`replace-with-audio.ts`, `__tests__/unit/{account-erasure,trash-purge-cron,
video-permanent-delete}.test.ts`, `packages/web-backend/src/{S3Buckets,Storage,
ImageUploads,Videos}/*`). None of them touch a video that is not itself
trashed/deleted/erased — `purge-trashed-videos` cron only acts on videos with
`deletedAt` already set, `replace-with-audio` only touches its own video's raw key when
explicitly invoked by the user, account-erasure only on account deletion. None of the 13
storageMissing videos are in trash and only one (`h6bsfryz7qkthw0`) has `deletedAt` set —
and that was a 0-byte failed upload, deleted a second after being (correctly) flagged, so
there's nothing there to have been deleted by a cleanup bug.

**No delete-path found that explains the missing `result.mp4`s.**

## 4. The actual root cause — found in code, not inferred

`apps/web/workflows/process-video.ts`, `optimizeAndFinalizeVideo()`:

```ts
try {
  const result = await optimizeRemoteVideoToMp4(videoUrl);
  … await bucket.putObject(`${ownerId}/${videoId}/result.mp4`, …) …
} catch (error) {
  console.error(`[process-video] Optimization failed for ${videoId}, keeping the
    original raw upload playable:`, error);
  // duration probe fallback, no rethrow
}
```

The function's own doc-comment says it plainly: *"Never throws on an optimization
failure: the raw upload stays intact and still plays via `/api/playlist`'s existing
raw-upload fallback, so a broken ffmpeg run must never brick an otherwise-fine
recording."* — this is a deliberate, reasonable resilience design. When the ffmpeg
encode fails (which the same file documents happens routinely for certain inputs —
audio-only files being run through a video-oriented encode, VP9/Opus browser
recordings, etc.), `result.mp4` is simply never written, and the **caller**
(`processVideoWorkflow`) still treats this as success and unconditionally deletes the
video's `video_uploads` row (lines 39–41) — which is exactly the row `reconcile-storage`
would otherwise use to find the raw key.

Every one of the 11 false-positive videos has **no `video_uploads` row at all**, forcing
`reconcile-storage`'s own `resolveVideoKey()` to fall back to a hardcoded
`${ownerId}/${id}/result.mp4` guess — with no raw-upload fallback:

```ts
// apps/web/app/api/cron/reconcile-storage/route.ts
async function resolveVideoKey(video): Promise<string> {
  const [uploadRow] = await db().select({rawFileKey: …}).from(videoUploads)…
  if (uploadRow?.rawFileKey) return uploadRow.rawFileKey;
  return `${video.ownerId}/${video.id}/result.mp4`;   // ← no raw-upload fallback
}
```

Compare this to the **actual** playback resolution that the share page uses
(`apps/web/app/api/playlist/route.ts`, the `videoType === "mp4"` branch): it HEAD-checks
`result.mp4` first, and if absent, calls `resolveRawPreviewKey()` which checks the raw
upload key / `raw-upload.mp4` / `raw-upload.webm` before giving up. **Three independent
copies of "what's the playable key for this video" exist in this codebase**
(`playlist/route.ts`, `video-proxy/route.ts`, `reconcile-storage/route.ts`) and they have
drifted: two of the three know about the raw-upload fallback, the reconcile cron does
not. That drift is the entire bug.

So the causal chain is:
1. ffmpeg optimize fails for some raw upload (happens routinely for audio-only /
   unusual-codec inputs — expected, not rare, per the code's own comments).
2. `result.mp4` never gets written; failure is swallowed; `video_uploads` row is deleted
   as if processing fully succeeded.
3. ≥2h later, `reconcile-storage` checks the ONLY key it knows (`result.mp4`), finds it
   missing (correctly — it really doesn't exist), and permanently sets
   `metadata.storageMissing = true` (candidates are excluded from ever being re-checked
   once flagged, so this can never self-heal).
4. `ShareVideo.tsx:684` renders `<StorageMissingOverlay>` whenever
   `data.metadata?.storageMissing` is true — a raw, cached DB flag, not a live check —
   so the real, playable raw-upload file behind it is never even attempted.

## 5. Timeline (from real `gh run` logs of `.github/workflows/reconcile-cron.yml`, not guesses)

| run (UTC) | trigger | checked | missing | note |
|---|---|---|---|---|
| 2026-07-17 06:03:53 | manual (workflow_dispatch, first-ever successful run) | 8 | **8** | every eligible video at that point was *already* missing `result.mp4` — a backlog, not a fresh event |
| 2026-07-17 21:56:15 | schedule | 0 | 0 | |
| 2026-07-18 21:54:04 | schedule | 2 | 0 | control: fresh videos DO come back "present" — proves the check isn't just always-false |
| 2026-07-19 21:56:17 | schedule | 12 | **5** | second burst |
| 2026-07-20 22:02:27 | schedule | 7 | 0 | |
| 2026-07-21 22:05:23 | schedule | 7 | 0 | |
| (2026-07-22 ~09:42–09:47, no matching `gh run` — a manual/direct curl outside the scheduled workflow, most likely the read-only query pass that produced the original E6b finding) | — | — | 3 more (`bbzt2424z6vvy6t`, `aydm0823n9f20s4`, `15xgcytw49pmrj8`) | |

Two clusters (07-17 and 07-19), not a steady drip — consistent with "the finalize step
fails for a subset of recordings, in bursts tied to whatever content got uploaded that
day," not with a time-based lifecycle rule or a continuous leak. `reconcile-cron.yml`
itself only started successfully reaching the live app on 2026-07-14 (it pointed at the
dead Railway URL before that), so nothing before 07-17 was ever actually checked either
way.

## Answering the 5 investigation questions directly

1. **Confirmed real?** `result.mp4` really is absent for all 13 (true negative on that
   specific key). But for 11/13 the video itself is NOT lost — raw-upload/original is
   intact and live-served today. Only 2/13 are genuinely empty in R2.
2. **Lifecycle rule?** No evidence for one; ruled out by pattern (see §2). Could not read
   the policy directly (token scope) — noted as the one unresolved technicality.
3. **Delete path?** None found that fits (see §3).
4. **Timeline?** Two burst events (07-17 backlog, 07-19 new burst), not a steady per-day
   loss — matches "ffmpeg finalize fails for a subset of uploads," not a slow leak.
5. **Scope — NULL-status videos too?** Yes, 6 of 18 NULL-status videos are flagged too,
   same pattern (no result.mp4, raw-upload intact) except the 2 genuinely-failed uploads.
   Confirms the cause is pipeline/storage-layer, not transcription-status-specific.

## The fix (cheap, surgical)

Make `reconcile-storage`'s existence check match what `/api/playlist` actually does
before declaring a video's storage gone: HEAD `result.mp4`, and if absent, HEAD the raw
upload fallback (`video_uploads.rawFileKey` if the row still exists, else
`raw-upload.mp4`/`raw-upload.webm`) — only flag `storageMissing` when *neither* exists.
Reusing `resolveRawPreviewKey`'s logic (already exported-shape in `playlist/route.ts`)
instead of re-implementing a third, narrower copy removes the drift for good.
Separately: the 13 already-flagged rows should be re-verified (or just manually
unflagged for the 11 confirmed-intact ones) so the internal team stops seeing
"unavailable" on recordings that play fine.

## Unresolved

- Could not read the R2 bucket's lifecycle configuration directly (`AccessDenied` on the
  app's own token) — ruled out by strong behavioral evidence instead of the policy
  document itself. If the owner wants it settled with zero doubt, the Cloudflare
  dashboard → R2 → bucket → Lifecycle Rules tab (or a token with bucket-admin scope) is
  the one next probe.
