# PLAN 2026-09-10 — three owner requests + one measured production defect

Owner gave three orders live on 2026-09-10 (this session) plus one standing order about
worker routing. A production measurement made the same afternoon found a separate silent
defect that outranks all three. Everything below is decided; the open questions were
answered by the owner in two AskUserQuestion batches this session.

## Owner decisions already settled (do not re-ask)
- **A. Two options at the start.** Replace the current implicit two-stage flow with an
  explicit choice: **"Only transcript"** vs **"Full AI analysis"**. Placement: **on the
  video page**, before analysis starts (his tap: "Video sahifasida"). Not at upload time.
- **B. Copy + download in the refined section.** The refined (cleaned-up) tab must have the
  same copy and download affordances the transcript tab already has, and the downloaded
  file must be pleasant to read. Formats: **both .docx and .txt** (his tap: "Ikkalasi ham").
- **C. Multi-file import.** Allow selecting many files at once, **limit 20** (his tap).
  AI analysis is explicitly **NOT batched** — his words: "kop fayl yuklangani bilan ai
  tahlil alohida qilinadiku bitta bitta". So multi-import is an UPLOAD-only feature; each
  recording is analysed individually afterwards, exactly as today. The per-batch "which
  analysis mode" question is therefore moot and was dropped.
- **D. Worker routing.** Standing order 2026-09-10: "barcha arzon ishchi kuchini glm 5.3ga
  qildir" — burn the GLM allowance before the Claude allowance. Cheap DOING goes to
  `scripts/glm-run.ps1 -Model glm-5.3`. UNCHANGED: review/judge stays on Claude (a reviewer
  from the same family as the author has correlated blind spots), and `~/.claude` work never
  goes to GLM (CLAUDE.md rule 1 is a tier floor). GLM endpoint verified reachable this
  session: `-Check` returned CHECK PASS, glm-5.3, 19.5 s latency.
- **E. The two stuck recordings from 2026-09-10 must NOT be force-started** (his tap:
  "Yo'q, tegmang") — it would cost roughly 12 000 so'm of paid AI. They stay as they are.

## THE DEFECT THAT OUTRANKS ALL THREE (measured, not guessed)

Roughly **15% of uploads since 2026-08-26 silently never get processed at all.**

Measured on production this session (container `data365-web:d2c400c`, database `capdb`):

| date | uploads | never started |
|---|---|---|
| 2026-08-26 | 5 | 1 |
| 2026-09-02 | 3 | 1 |
| 2026-09-04 | 3 | 2 |
| 2026-09-05 | 2 | 1 |
| 2026-09-10 | 12 | 2 |

"Never started" means `videos.transcriptionStatus IS NULL` **and** no
`metadata.processingStartedAt`. Seven such rows exist since 2026-08-01.

Two distinct shapes:

- **Shape A — nothing at all.** Today's `6b1kdkgr46d3nm5` (11:33) and `jka07j0jekx883s`
  (13:33). `metadata` is exactly `{"isAudio": true}`. Storage holds only
  `raw-upload.mp4`, 165,553,362 and 123,894,845 bytes. Container logs show
  "Creating multipart upload ... content-type: audio/mpeg" then "Multipart upload completed
  successfully" for both, and **no error line anywhere mentions either video id**. Both
  rows were last touched about 30 seconds after creation and never again.

- **Shape B — playable but never transcribed.** `mz56jaba64m8z94`
  ("Platforma_taqdimoti", 2026-09-05) has `result.mp4`, `download-audio.mp3` and a
  thumbnail in storage, so the video pipeline finished, yet transcription never started.
  **This is the exact video the owner complained about on 2026-09-05 with a screenshot.**
  That complaint was read at the time as a quota/bundling problem; the chunk-size and
  transcript-first work shipped in response never touched the real cause, so his original
  bug is still live five days later. Say this plainly rather than quietly re-fixing it.

Why nobody reported it: people re-upload until it works. `6b1kdkgr46d3nm5` and
`3tcqnpjgk139cax` have byte-identical `raw-upload.mp4` (165,553,362) — the same file
uploaded twice, once stuck and once fine. Retrying users keep the dashboard looking clean
(the `feedback_survivors_hide_the_failure` pattern).

Related evidence, same session: about 86 ERROR log lines per 24 hours whose whole body is
`{"cause":{"name":"NoSuchKey"},"_tag":"S3Error"}`, logged at
`packages/web-backend/src/S3Buckets/S3BucketAccess.ts:35`, where `wrapS3Promise`'s
`Effect.tapError(Effect.logError)` fires before any caller-side `catchTag` or
`Effect.option` can swallow it. Most come from deliberate existence probes
(`apps/web/app/api/playlist/route.ts:116` and `:287`), so that log line is a false alarm and
should carry the object key (same file:line) rather than being silenced.

**Multi-import (C) must not ship before this defect is fixed.** At a 15% silent loss rate a
20-file batch loses about three recordings per use, and the person who dropped 20 files in
has no way to tell which three. This was stated to the owner in those terms this session.

## Work items

### 1. Root-cause and fix the never-started pipeline (highest priority)
An `architect` agent is diagnosing the call chain from multipart-complete to the enqueue of
`process-video`, with all the measurements above front-loaded. Its deliverable: the call
chain with file:line, one named root cause with a confidence grade, ruled-out alternatives,
and the minimal fix, preferring a server-side safety net that catches the whole class over
patching one call site. Check whether `recover-stale-ai-jobs` can pick up a never-started
video; the evidence so far says it only recovers jobs already in flight.

Acceptance: a synthetic upload reproducing the stuck shape gets picked up automatically, and
a test asserts the OUTCOME (a video with no `processingStartedAt` and a present
`raw-upload.mp4` is enqueued), never the argument passed. Mutation-check it: restore the old
behaviour and the test must go red. That discipline exists because on 2026-09-05 every gate
was green while the feature was a no-op.

### 2. Only-transcript vs Full-AI choice (A)
Current shape: `apps/web/app/s/[videoId]/_components/GenerateAiPanel.tsx` already splits
"transcript not ready" from "transcript ready, AI optional", and
`app/api/videos/[videoId]/generate/route.ts:172` passes `aiGenerationEnabled: false` so a
first press transcribes only. Turn that implicit sequence into two explicit buttons on the
first branch. "Full AI analysis" must pass `aiGenerationEnabled: true` through the same
route, which restores the pre-2026-09-05 one-press behaviour for people who want it.

Blast radius to handle in the same change: the three dispatch paths that redeem an
upload-time press (`generate/route.ts`, `process-video.ts`,
`recover-stale-ai-jobs/route.ts`) all currently force `false`; and the running stepper in
`GenerateAiPanel.tsx` still says "stage 1/3" and weights a 65% bar for a run that stops
after transcription, which becomes visibly wrong once the mode is explicit, so the stepper
must reflect the chosen mode.

### 3. Copy and download in the refined tab (B)
`apps/web/app/s/[videoId]/_components/panels/TranscriptPanel.tsx` already has the toolbar:
`handleCopy` at :503, `handleDownload` at :511, `downloadBlob` at :308, and filenames come
from `@/lib/download-filename`. `RefinedTranscriptPanel.tsx` has none of it. Port the same
affordances, reusing `downloadFilename` so a folder of exports stays distinguishable.

Formats: `.txt` (clean prose, no timestamp clutter) and `.docx`. No docx library is present
(`file-saver` is the only related dependency), so add the `docx` package and build the
document client-side. Add new i18n keys to `uz.json`, `en.json` and `ru.json` together —
four orphaned keys had to be removed on 2026-09-05 because only one locale was updated.

### 5. Cancel an upload mid-flight (owner order 2026-09-10)
His words: "upload bo'layotgan paytda yarim yo'lda cancel qilish bo'lsin, adashib bosilib
ketish holatlari bo'lyapti yuklanaganda" — people start an upload by accident and there is
no way out. Needed: a visible cancel control while an upload is in flight, which aborts the
multipart upload, removes the half-written object, and removes (or clearly marks) the video
row so it does not become another invisible dead record.

This item is not cosmetic and it touches item 1 directly: an aborted or abandoned multipart
upload is one candidate explanation for the never-started rows, because both stuck rows
today were last written about 30 seconds after creation and then never again. Whoever fixes
item 1 must state whether a cancelled or abandoned upload produces exactly the observed
shape (`metadata` equal to `{"isAudio": true}`, both status columns NULL, `raw-upload.mp4`
present and complete). If it does, cancel and the safety net are one fix, not two — the
storage evidence says the file was fully written, which argues against a plain abort, so
this has to be settled with evidence rather than assumed either way.

### 4. Multi-file import, up to 20 (C) — gated behind item 1
Upload only, no batch AI. Per-file progress and a per-file failure state that is impossible
to miss, precisely because the current failure mode is invisible.

## Verification bar (all items)
`tsc -b --force` exit 0 · full web suite green against the 2026-09-06 baseline of 181 files
and 1540 tests, 26 skipped · no CRLF churn (compare `--shortstat` against `-w`) · a blind
non-author judge on the diff · then the image-tag deploy and a live probe. Production has no
login credential on this machine, so anything behind a sign-in stays owner-verified and is
never reported as proven.

## ClickUp overlap found this session (41 open tasks, two visible lists)
The owner's three verbal orders are already filed there, so they are not new scope:
- `z92046pvtu` (high, "shkafda") — transcription-only with optional summary/tasks/vector,
  which is item A.
- `z92046r2vf` (high, "shkafda") — refined blocks collapsible, same panel as item B.
- `z92046jw05` and `z92046jw04` (upload flow, files landing in the root folder) — neighbours
  of item C.
- `86eyh74fk` (high) — set the recording title from the uploaded file name on import;
  belongs with item C, and explains why today's batch is named "1" through "11".

Two high-priority reports contradict what our own board treats as settled, and need
checking before anything else is promised to him:
- `z92046pvu0` (high) — "Videoni audioga o'girish ishlamayapti": the audio-replace button
  shipped in `643babf` is reported BROKEN by Bunyod, while `docs/STATE.md` records the owner
  confirming "sinaldi hammasi ishlayapti" on 2026-09-06. One of the two is wrong.
- `86eyjtx4p` (high) — AI progress disappears after a page refresh. Possibly the same
  never-started class as item 1; check whether it shares that root cause before treating it
  as separate work.

## ClickUp contradictions — BOTH RESOLVED by evidence this session, no owner question needed

**`z92046pvu0` "Videoni audioga o'girish ishlamayapti" — stale, not a live contradiction.**
Bunyod created it **2026-09-04 20:13 UTC**, which is BEFORE the audio-replace button shipped
(`643babf`, deployed 2026-09-06 ~00:10) and before the owner confirmed it working on
2026-09-06 13:40. So the board and the ticket do not disagree; the ticket simply was never
closed. Do not ask the owner to re-test it.

Two of its three requirements ARE still open and are real, small work:
- Move the "Audioga o'girish" option out of the surface header button and into the
  three-dot (⋮) menu. Our own board already lists this as a deliberate leftover: the header
  button reaches the destructive confirm in 2 clicks where the dashboard takes 3, and this
  action permanently overwrites the video with audio (a 53-minute client meeting was
  destroyed this way on 2026-08-06). Fewer clicks to an irreversible action is the wrong
  direction, so his request and our own review agree.
- Show audio in the preview after conversion.
His requirement that the video be deleted and only audio remain is already what
`replaceVideoWithAudio` does.

**`86eyjtx4p` "AI tahlil jarayoni sahifa yangilangandan keyin yo'qolib ketmasin" — almost
certainly already fixed; do not rebuild it.** Traced the mechanism: the panel polls
`/api/video/ai?videoId=…` (`apps/web/hooks/use-ai-status.ts:208`), and that route returns
`aiProcessingStep` straight out of the video's PERSISTED metadata
(`apps/web/app/api/video/ai/route.ts:135`, `:155`, `:173`). Progress therefore survives a
refresh by construction, and the ticket dates from around 2026-08-09, before much of this
machinery landed. What is genuinely missing is the second half of his ask — a clear
"Tahlil bekor qilindi" message when a run has stopped — and there is no mechanism for it
because an analysis run cannot currently be cancelled at all. Treat that half as new work,
not as a bug.
Confirming the first half properly needs one signed-in click, which this machine cannot do
(no login credential exists here), so it stays owner-verified and must not be reported as
proven.


## Deploy-day loop, 2026-09-11 — the recovery pass keyed on an empty column

SCOPE: The recovery pass committed in 91962be cannot recover the incident it was built for.
Measured on production this session: all six orphaned `video_uploads` rows, including the two
from 2026-09-10 (`6b1kdkgr46d3nm5`, `jka07j0jekx883s`), carry `raw_file_key IS NULL` and
`mode IS NULL`. The pass required `raw_file_key IS NOT NULL`, so it would have selected none
of them. Reproduce with: `SELECT video_id, phase, raw_file_key, mode FROM video_uploads WHERE
phase IN ('uploading','error');` on the prod database.

METRIC: a script-computable count, not a judgement. (1) The unit file
`__tests__/unit/recover-stale-upload-handoff.test.ts` must contain a case where
`upload.rawFileKey` is null and the relaunch still fires with the derived key
`owner-1/<videoId>/raw-upload.mp4`; that case must go RED when the derivation is removed.
(2) `tsc -b --force` exit 0 and the full suite at or above 185 files / 1579 tests passing.
(3) After deploy, the cron's own JSON must report `staleUploadRelaunched >= 1` on the first
tick that sees those two rows, and their `videos.metadata` must gain `processingStartedAt`.

DIRECTION: one change, measure, keep or discard. Change made: admit a row whose key is NULL
(`or(isNull(rawFileKey), like(rawFileKey, '%/raw-upload.%'))`) and derive the key by probing
the canonical `raw-upload.mp4` then `.webm` in storage, which doubles as the
bytes-really-there check. Edit rows and admin-reprocess rows always carry a non-null non-raw
key, so they stay excluded. Kept only if the metric above holds.
