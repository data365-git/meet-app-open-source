# Upload/processing progress is invisible — SCOPE / METRIC / DIRECTION

_Owner complaint, 2026-08-18: "nega upload bo'layotganda foiz ko'rsatmayapti — yuklanyaptimi yo qotib qoldimi bilib bo'lmayapti."_
_He chose the FULL fix (both layers) when asked. This is wave 2 item #1, re-scoped against the code as it actually stands after wave 1 (`f917459`)._

## SCOPE — what is broken, reproducible by someone else

Dashboard → **Upload video** → pick a file larger than ~100 MB (multipart path,
`MULTIPART_UPLOAD_THRESHOLD_BYTES`). Watch the placeholder card.

Two distinct blind windows, with different causes:

**Window 1 — while the bytes are uploading (client).**
The percentage IS computed: `useImportUpload.ts:172-181` and `:222-231` push
`progress: percent` into the uploading store on every `onProgress` tick.
`UploadPlaceholderCard.tsx` consumes it, but feeds it **only** to
`strokeDashoffset` of a 16×16 px SVG ring (`:13-21`, `:44-68`) and renders the
bare word "Uploading" (`:41-43`, `getFriendlyStatus`). **No number is ever
printed.** On a phone, a 16 px ring moving 1% per few seconds is
indistinguishable from a frozen one. The numeric label exists — `statusLabel`
= `` `Uploading... ${progressPercent}%` `` (`useImportUpload.ts:411-419`) — but
its only consumer is `ImportFilePage.tsx:91-97`, the standalone
`/dashboard/import/file` screen that the one-click `UploadCapButton`
deliberately bypasses.

**Window 2 — after the bytes land, while the server works (nothing at all).**
`process-video.ts:64-66` **deletes the `videoUploads` row as its first step**
(wave 1, so transcription no longer queues behind optimization). From that
moment `GetUploadProgress` returns nothing, `useUploadProgress` returns `null`,
and `CapCard`'s overlay disappears (`CapCard.tsx:346-349`). Meanwhile
`optimizeAndFinalizeVideo` downloads the raw file, runs ffmpeg, and uploads
`result.mp4` — minutes on a big file — with **zero** progress written anywhere:
`processingProgress` is only ever set to `0`, and only on the error path
(`process-video.ts:280-281`, `lib/video-processing.ts:26,51`). The card just
looks like an ordinary, idle video.

Not the gap: the **AI** stage already has granular progress (wave 2.1 —
`useAiStatus` + `aiProcessingStep` + `transcriptionChunksCompleted/Total`,
`CapCard.tsx:300-343`). Only the pre-AI optimize/save stage is silent.

Consequence, and why this is not cosmetic: a user who believes the upload froze
re-uploads the same file. That is exactly the 2026-08-17 incident on record —
one file uploaded four times in 35 minutes.

## METRIC — the number that says "fixed"

Computed, not judged. Two gates, both required.

**M1 (pre-deploy, runnable on this machine): `pnpm test:web` exit 0** with new
RED-first tests proving:
- `UploadPlaceholderCard` renders the literal text `47%` when the store holds
  `progress: 47` for each of `converting` / `uploadingThumbnail` /
  `uploadingVideo`, and renders no stale ring for `serverProcessing`.
- a simulated ffmpeg stderr stream (`frame=… time=00:05:00.00 …` lines against
  a known duration) produces a monotonically non-decreasing sequence of at
  least 5 distinct integer percentages through the new `onProgress`.
- the throttle never writes more often than once per 5 s of simulated time.
- mutation check on each: revert the production line, the new test must fail.

**M2 (post-deploy, needs one real upload): visible-update gap ≤ 30 s.**
For one upload of a ≥300 MB file, sample what the card displays every 5 s from
the press until the video is ready. Required: **every sample carries a number,
and no two consecutive changes are more than 30 s apart.**
Baseline today: window 1 = 0 numbers shown (ring only), window 2 = no indicator
at all, longest gap = the whole optimize stage.
_This machine has no login credential (next-auth JWT sessions, `sessions` table
empty), so M2 is measured by the owner or a team member, not here._

## DIRECTION — one change → measure → keep or discard

Two independent changes, shipped in this order, each keepable on its own.

**Change A — print the number (client only, no server involvement).**
`UploadPlaceholderCard.tsx`: render `label + NN%` next to the ring, for every
status that carries `progress`; for `serverProcessing` show the label with an
indeterminate spinner instead of a ring frozen at 0. Discard rule: if the text
is not visible on a 375 px viewport, it did not fix anything.

**Change B — give the silent server stage a carrier.**
`videoUploads` cannot be it — wave 1 deletes that row on purpose, and putting
it back would resurrect the 2-hour queueing bug. Carrier = `videos.metadata`,
the same channel the AI stage already uses and the same poll
(`useAiStatus`) that already reads it:
- `lib/video-convert.ts` — the ffmpeg child is already spawned with stderr
  piped (`:95`, `:113`); parse `time=HH:MM:SS.ms` out of the chunks already
  being accumulated and expose an optional `onProgress(percent)` computed
  against the probed duration. No new pipe, no new process.
- `workflows/process-video.ts` — write `metadata.processingStage`
  (`optimizing` | `saving`) + `processingPercent` + `processingUpdatedAt`,
  throttled to at most one write per 5 s AND only when the integer percent
  changed; clear all three when the step ends, on success and on failure.
- the AI-status endpoint behind `useAiStatus` returns those three fields, and
  polling is enabled when the server-rendered `cap.metadata.processingStage` is
  set (mirroring the existing `aiRunning` gate — no new poller on idle cards).
- `CapCard` + the share page render `stage · NN%`.
- one-liner while we are there: the existing overlay prints the percentage only
  for `status === "uploading"` (`CapCard.tsx:966-968`); print it for
  `processing` / `generating_thumbnail` too, so the seconds before the row is
  deleted are not wordless either.
Discard rule: if a duration cannot be probed, `onProgress` reports null and the
UI shows elapsed time with an indeterminate spinner — never a fake percentage.

## Blast radius

- `UploadPlaceholderCard` is rendered on every upload entry point (caps grid,
  folder page) — check both before claiming Change A is done.
- `useUploadProgress` has four consumers (`CapCard`, `CapVideoPlayer`,
  `ShareVideo`, `EmbedVideo`); the percentage one-liner must not change what
  the embed shows to an outside viewer.
- The 5-minute stale detector (`ProgressCircle.tsx:88-124`) turns
  progress-stuck-at-0 into a red "Qayta ishlashda xatolik". Once Change B
  writes real progress this stops being reachable in the normal path — do not
  also loosen the threshold, or a genuinely stuck job goes quiet again.
- Metadata writes must use `JSON_SET`/`JSON_REMOVE` on the existing column, the
  way `startPendingAiRequest` does (`process-video.ts:255-261`) — a whole-object
  overwrite races the AI counters written by the transcription pipeline.
