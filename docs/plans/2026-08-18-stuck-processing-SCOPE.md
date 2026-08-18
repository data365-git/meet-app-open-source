# Stuck at "processing" after upload — autoresearch loop (2026-08-18)

## SCOPE (what is broken, reproducibly)
Transcription and AI analysis are started by the **browser**, not the server.
- `apps/web/app/(org)/dashboard/import/file/useImportUpload.ts:254-259` — after the bytes land the client `await`s `triggerVideoProcessing`.
- `apps/web/app/api/videos/[videoId]/generate/route.ts:171-172` — the kickoff is a client `fetch`; `apps/web/lib/transcribe.ts:74` is the only place that sets `PROCESSING`.

If the tab is backgrounded or killed between "bytes landed" and that call — the normal behaviour of a **phone** (screen lock, app switch, call) — the request never fires. The video then sits at `transcriptionStatus = NULL` and the UI shows "processing" **forever**.

**No server-side recovery covers this.** `recover-stale-ai-jobs` (the only relevant scheduled cron, every 30 min) only re-kicks jobs that already carry an `aiStartPendingUpload` / `aiGenerationRequestedAt` marker — a video whose kickoff never reached the server has no marker. `reconcile-storage` and `poll-batch-jobs` exist in code but are **not scheduled** on the host (`crontab -l`, verified 2026-08-18).

Secondary: `isUploadInProgress` (`apps/web/lib/transcribe.ts:59-72`) treats every `mode='multipart'` row as still uploading until the workflow clears it, so a half-finished upload session also blocks transcription.

### Live evidence (prod DB, 2026-08-18)
- 4 non-deleted videos permanently frozen at `transcriptionStatus = NULL`: `0vghhj9wm8smamw`, `mgz2et7cbzqy544`, `jbemr633th8ct7t` (2026-07-30), `9ese6p630hq61ae` (2026-07-18). Never recovered, weeks later.
- 2026-08-17 17:36→18:11 the owner uploaded the SAME file four times: `4tbr58yfd922bdz` (PROCESSING, deleted), `3fjk6nrsex5rz7n` (NULL, deleted), `d83pksbvbzqqzq9` (NULL; `video_uploads` row mode=multipart phase=uploading 0/0, never advanced, deleted), then `wcrwp896m1sqcvf` which succeeded.
- Not the cause, but relevant to "it takes forever": that successful 2h06m video's AI ran 18:11→20:30 (2h19m) because every free-tier Gemini call returned HTTP 429 and it fell back to paid.
- Nothing is stuck as of 2026-08-18 07:40 CEST; health 200, `db:ok storage:ok`.

## METRIC (a script computes it, not a model)
`SELECT COUNT(*) FROM videos WHERE deletedAt IS NULL AND (transcriptionStatus IS NULL OR transcriptionStatus='PROCESSING') AND createdAt < NOW() - INTERVAL 1 HOUR;`
- Baseline today: **4**. Target after the fix: **0**, and it must stay 0.
- Acceptance test: upload a file, kill the tab the moment the bytes finish → the video must reach `transcriptionStatus='COMPLETE'` with a summary within 15 minutes, with no further browser action.

## DIRECTION (one change → measure → keep or discard)
1. Server-side rescue: a cron that finds videos whose object is in storage but whose processing never started, and starts it (transcription + AI), idempotently. Schedule it every 5 min alongside the existing two.
2. Then re-measure the metric; keep only if it goes to 0 and no video is processed twice.
3. Only if step 1 leaves a gap: make the client kickoff survive backgrounding (`keepalive` fetch / `sendBeacon`).

## Measurements taken 2026-08-18 (before the fix)
- METRIC baseline **4** → **0** after the owner chose to trash the four July strays (`0vghhj9wm8smamw`, `mgz2et7cbzqy544`, `jbemr633th8ct7t`, `9ese6p630hq61ae` — soft-deleted, `deletedAt=NOW()`, so `purge-trashed-videos` removes them in 7 days and they are recoverable until then). **0 is now the baseline the fix must hold.**
- **Storage is NOT the cause this time.** A simulated browser preflight against the R2 bucket returns `204` with `Access-Control-Allow-Origin: https://data365.duckdns.org` and `GET, PUT, POST, HEAD, DELETE` — the 2026-08-14 CORS root cause has not regressed.
- AI spend is small and not a blocker: Aug 2026 = $5.50 total (transcription $3.81 / 520 calls, summary $1.66 / 413), July = $7.27. A 2-hour video costs ~$0.70. The free tier caps at **20 requests/day per model**, so a long video burns it in the first minutes and spends the rest on paid — that explains the wall of HTTP 429 in the logs and the 2h19m AI run, not a failure.

## Owner's decision, 2026-08-18
"Xafa qilib tuzat, muammo bo'lmasin boshqa. Telefonda ham, kompyuterda ham." → build BOTH layers (server rescue + client kickoff that survives backgrounding). Four July strays: trash them (done).

## ⚠️ THE METRIC ABOVE WAS THE WRONG ONE — corrected 2026-08-18
"Videos stuck right now" reads **0** and yet the defect is real, because **the user deletes each stranded upload and re-uploads**. Counting survivors hides exactly the failures we are hunting. The honest metric counts ATTEMPTS, deleted rows included:

`SELECT SUM(transcriptionStatus='COMPLETE')/COUNT(*) FROM videos WHERE createdAt > NOW() - INTERVAL 30 DAY;`

**Baseline: 23 of 32 attempts = 72% (28% of uploads never got analysed).** Target ≥95%, and the stuck-count query must stay 0.

The retry pattern is visible in pairs, always the same file minutes apart — a stranded attempt, then a successful re-upload:
- 08-11 16:39 `20j87edspt2q8r2` NULL (deleted) → 16:44 `bjwk6x3h6zc1mtz` COMPLETE
- 08-14 06:05 `4a951226qwjhbz9` NULL (deleted) → 06:17 `xbs8dqy4epxc0gx` COMPLETE
- 08-17 17:36 / 17:45 / 17:52 all stranded (deleted) → 18:11 `wcrwp896m1sqcvf` COMPLETE

## Two constraints the fix MUST respect (found late, they change the shape)
1. **Auto-starting AI is a settled owner decision AGAINST** — `STATE_ARCHIVE.md:158` ("AI is MANUAL by owner's choice", cost-confirm dialog), `:193` ("C1 — AI not auto-triggered after upload, manual only"), and rounds 5–10 (`:290-333`) deliberately DELETED every automatic paid escalation. `actions/videos/get-status.ts:114-116` states the same rule in a comment. So the rescue may only **resume work the user already asked for** — the intent must be recorded server-side when the user presses the button / picks AI at upload, and redeemed later even if the tab died. An upload with no recorded intent stays untouched and unbilled.
2. **Permission is not the blocker.** `app/api/videos/[videoId]/generate/route.ts:57` allows the video's own owner regardless of org role, and every recent upload belongs to `admin@ustoz.uz` (org `TEAM` owner). Abrorbek's own account `mirkomilovabror7@gmail.com` is only a `member` — worth knowing, but it is not what strands these uploads.

## ⛔ THE DIAGNOSIS ABOVE IS SUPERSEDED — the nginx log refuted it, 2026-08-18
The "the tab died before the trigger" story is **wrong** for the session the owner is complaining about. His device that evening was a phone, and he pressed the button — six times:

```
19:36:54 POST /api/upload/multipart/initiate 200      -> 4tbr58yfd922bdz
19:39:43 POST /api/upload/multipart/complete 200      -> bytes landed
19:45:02 POST /api/upload/multipart/initiate 200      -> attempt #2 (3fjk6nrsex5rz7n)
19:46:10 POST /api/videos/4tbr58yfd922bdz/generate 200   <- pressed "AI tahlilni boshlash"
19:47:51 POST /api/upload/multipart/complete 200
19:49:12 / 19:50:19 / 19:51:42  .../generate 200         <- pressed 3 more times
19:52:28 POST /api/upload/multipart/initiate 200      -> attempt #3, its /complete NEVER arrives
20:11:31 .../generate 200                                <- again
20:12:01 POST /api/upload/multipart/initiate 200      -> attempt #4 (wcrwp896m1sqcvf)
20:14:50 POST /api/upload/multipart/complete 200
20:15:40 .../4tbr58yfd922bdz/generate 200                 <- SIXTH press, 30 min after the first
20:16:06 / 20:17:35 .../wcrwp896m1sqcvf/generate 200     <- the copy that survived
```
(times CEST = UTC+2, all from a Mobile user agent)

**Where the hours actually went** — measured from `ai_usage_events`:

| video | length | upload → last AI call | transcription API span | summary API span |
|---|---|---|---|---|
| `4cvvj0n7hmax7tg` | 51 min | **7 min** | – | – |
| `gbjha7v748yy7yj` | 90 min | **21 min** | 8 min (42 calls) | 1 min (25 calls) |
| `bjwk6x3h6zc1mtz` | 120 min | **29 min** | 4 min (54 calls) | 0 min (32 calls) |
| `wcrwp896m1sqcvf` | 126 min | **138 min** | 2 min (50 calls) | 0 min (33 calls) |

The AI itself takes 2–8 minutes. Everything else is the stage BEFORE the first API call — fetch the object, ffmpeg-extract the audio, chunk it — and that stage has **no progress output at all**. For `wcrwp896m1sqcvf` it ran 2h10m (pressed 18:16 UTC, first AI call 20:26 UTC) where a same-length video days earlier took 24 min. That silent stage is the frozen "Ishlanmoqda" he was staring at.

**Deleting a video does not stop whatever is touching it** — but state this carefully, the strong version was checked and did NOT hold. What is PROVEN: `4tbr58yfd922bdz` was deleted 18:15:55 UTC and written again at 18:24:51; `3fjk6nrsex5rz7n` deleted 17:48:35, written again at 18:32:55 — 9 and 44 minutes after the user threw them away, so something still owned those rows. What is REFUTED: all three abandoned attempts have **zero `transcript_chunks` and zero `ai_usage_events`**, so no transcription or AI was ever billed for them, and the claim that the box was chewing three or four copies concurrently is **NOT established** — ffmpeg extraction leaves no DB trace, so it remains possible but unproven. Do not repeat it as fact; if the concurrency question matters to the fix, prove it with a live `docker stats` / process check during a real double upload, not with `updatedAt`.

**The code-level proof is cleaner than the timestamps, and it is conclusive:** the string `deletedAt` does not appear anywhere in `apps/web/workflows/transcribe.ts`, `workflows/process-video.ts`, `lib/transcribe.ts` or `lib/generate-ai.ts`. **No stage of the pipeline ever asks whether the video still exists.** A job that has started runs to the end — including the paid API calls — no matter that the user trashed the video. On 2026-08-17 nothing was billed only because those attempts had not yet reached the API stage. This is finding #2, and it is proven by absence, not inferred from `updatedAt`.

Independent of that, retrying is still the wrong move for the user: each re-upload pushes gigabytes from a phone again and restarts the whole silent stage from zero.

## The real fix set, in priority order
1. **Show the silent stage.** The AI-stage bar already exists (`GenerateAiPanel.tsx` renders `aiStageChunksCompleted/Total`); the download→extract→chunk stage before it reports nothing. Give it a moving step + percentage the existing poll can read.
2. **Cancel on delete.** In-flight work must stop (or refuse to continue at its next checkpoint) when the video is trashed.
3. **No silent re-press.** A second press must say "already running, N% done", not return a bare 200 — `generate/route.ts:180` already carries a comment about `{started:true}` losing the owner's 2026-08-16 request.
4. **Stranded rescue** (smallest half): resume only recorded intent, never auto-spend — bound by the manual-AI decision above.

**Metric unchanged and still correct:** 23 of 32 attempts reached COMPLETE in 30 days = **72%**; target ≥95%. Add a second: **time from "AI tahlilni boshlash" to a first visible progress change must be under 60 seconds** — today it can be two hours.

## 🎯 THE GAP LOCATED EXACTLY — metadata timestamps, 2026-08-18
`processingStartedAt` is written where transcription CLAIMS the video (`lib/transcribe.ts:311`), so it dates the moment real work began. All times UTC (nginx logs are CEST = UTC+2):

**`wcrwp896m1sqcvf`** (the copy that survived, 126 min long)
- 18:14:50 bytes landed (`multipart/complete`)
- 18:17:35 `aiGenerationRequestedAt` — the user's press, recorded correctly
- **20:20:12 `processingStartedAt` — 2 h 03 m later**
- 20:26–20:30 every transcription + summary API call. **The whole AI job took 10 minutes.**

**`4tbr58yfd922bdz`** (the copy he gave up on)
- 18:15:40 last of six presses recorded
- 18:15:55 user deletes it
- **18:24:51 `processingStartedAt` — it claimed and began working 9 minutes AFTER being deleted**, and ran on into the window where the surviving copy was waiting.

So the two hours are not the AI and not the upload. They sit between "bytes landed + user pressed" and "transcription claimed the video" — inside the video's own post-upload processing phase, which emits nothing the UI can show. And an abandoned copy claims that phase after deletion and competes with the copy the user actually wants. Whether the surviving copy was blocked by a lock or merely starved for CPU is still undetermined — `lib/concurrency.ts` only bounds AI chunk fan-out (`AI_CHUNK_CONCURRENCY = 3`), and no per-video processing lock was found. **Distinguish those two before choosing between "serialise extraction" and "cancel on delete" — or implement cancel-on-delete, which is correct either way.**

Comparison that makes the anomaly concrete: `bjwk6x3h6zc1mtz`, also ~120 min, went from upload to finished AI in **29 minutes total** on a quiet evening.

## THE DESIGN (architect, 2026-08-18 — under blind review, not yet approved)
**The silent stage is now located to the line:** `workflows/transcribe.ts:614-712` (`extractAudio`) runs one silencedetect pass and then a **per-chunk ffmpeg loop** at `lib/audio-extract.ts:466` that writes NOTHING between the `extract_audio` step set at `transcribe.ts:625` and `0/N` at `:697`. That loop is the two hours the owner sat watching.

A second consequence falls out of the same silence: `recover-stale-ai-jobs` measures staleness from `aiProgressAt` (`stale-job-helpers.ts:25,31-40`), and a live extraction stamps it **zero times** — so the 30-minute cron can re-claim a video that is working fine and launch a duplicate run. That is a plausible second source of the pile-up on 08-17, and per-chunk progress writes close it for free.

**The four edits, in the order they matter**
1. **Progress out of the silent loop** — `lib/audio-extract.ts:414` gains `onChunkExtracted(done,total)`; `workflows/transcribe.ts:657` passes a callback writing `extractionChunksCompleted/Total` + `aiProgressAt` into `videos.metadata` (JSON — no migration; `packages/database/types/metadata.ts:208` gains the types). Remux progress uses ffmpeg `-progress` → `video_uploads.processing_progress` (column already exists) from `lib/video-convert.ts`. Surfaced through the poll that already exists (`app/api/video/ai/route.ts:106` → `hooks/use-ai-status.ts:145-158` → `GenerateAiPanel.tsx`), plus a "Video tayyorlanmoqda — N%" bar in the banked branch and an "Audio ajratilmoqda i/N" detail line. `video_uploads` was rejected as the carrier for extraction because that row is claimed to be gone by then — **the reviewer is checking exactly that claim.**
2. **Cancel on delete** — a ~6-line `assertVideoNotDeleted(videoId)` at existing checkpoints (before remux, before each audio-chunk upload, before each Gemini call). No queue.
3. **No silent re-press** — the server already answers `alreadyRunning` (`generate/route.ts:132,157`) and `queued` (`:211`); `GenerateAiPanel.tsx:181-186` throws the body away. Client-only: show "Allaqachon ishlanmoqda — N%", and add `keepalive:true` so a backgrounding phone still lands the press.
4. **Stranded rescue inside `recover-stale-ai-jobs`** (the only cron proven to run; the host crontab has already silently dropped three routes). Selection joins `video_uploads`→`videos`, webMP4 only, phase `uploading` older than 2 h or `processing`/`generating_thumbnail` older than 6 h, LIMIT 3 — then **judges completeness ONLY by HEAD-ing the assembled object**, never by `uploaded`/`total`, which is what keeps the multipart trap (bytes complete before `CompleteMultipartUpload`) from firing. Restarts remux only; **AI can start solely through the recorded `aiStartPendingUpload` marker** (`process-video.ts:180-237`), so the manual-AI decision holds by construction rather than by prose. Give-up at 3 attempts → `phase='error'` + ops alert, so the UI stops claiming "processing".

**Money guard:** `transitionVideoToProcessing` (`lib/video-processing.ts:48-86`) is claimed to be a compare-and-swap, the transcription claim CAS is `transcribe.ts:305-353`, and a counter-CAS on `uploadRescueAttempts` serializes restarts. A video with no recorded intent must end up processed, playable, `transcriptionStatus` NULL, showing the manual start button — and **zero `ai_usage_events` rows**, which is the RED test.

**Also proposed, deliberately flagged as the weakest item:** an in-process semaphore (limit 2) around the ffmpeg spawns. Only worth keeping if the reviewer confirms module-scope state is real protection in this deployment.

**Independent confirmation from the DATA side (not from reading the code):** `video_uploads` holds only **3 rows** on prod — `d83pksbvbzqqzq9`, `4a951226qwjhbz9`, `r5m2y8jxhatkmef`, every one of them a FAILED upload. Not one of the 24 videos that reached COMPLETE has a row. So the row really is cleared once processing succeeds, and the architect's reason for rejecting `video_uploads.processing_progress` as the carrier for extraction progress holds from two directions.

## 🔴 ROOT CAUSE — the container logs name it outright, 2026-08-18
```
[process-video] Optimization failed for 4tbr58yfd922bdz,  keeping the original raw upload playable: Error: Video conversion timed out
[process-video] Optimization failed for 3fjk6nrsex5rz7n,  keeping the original raw upload playable: Error: Video conversion timed out
[process-video] Optimization failed for wcrwp896m1sqcvf,  keeping the original raw upload playable: Error: Video conversion timed out
[process-video] Starting AI requested during upload for wcrwp896m1sqcvf
[transcribe] Extracted 42 audio chunks for wcrwp896m1sqcvf
```
**All three of the owner's attempts died in the same place.** `workflows/process-video.ts:113` calls `optimizeRemoteVideoToMp4(videoUrl)` with no options, so `lib/video-convert.ts` applies its defaults — `DEFAULT_COPY_TIMEOUT_MS = 10 min` (`:20`) then `DEFAULT_COMPRESS_TIMEOUT_MS = 45 min` (`:23`). **Up to 55 minutes of ffmpeg that was never going to finish**, on top of pulling a multi-GB file down to feed it. Only when that expires does the catch at `:127` shrug — *"keeping the original raw upload playable"* — and let transcription start. Transcription then took 10 minutes.

So the two hours were **not** the audio-extraction loop and **not** the AI. They were a doomed optimization pass that produces nothing, run on every long upload, three times over in one evening on a 4-vCPU box. That also settles the concurrency question the earlier section left open: three concurrent 55-minute ffmpeg runs is a real fight, not a supposition.

### The fix, re-ranked by what the evidence actually says
1. **Do not start a conversion that cannot finish.** `probeRemoteVideo` already exists and is already called in the catch (`:135`). Probe FIRST and skip optimization when the source is already a playable MP4, or when duration/size puts it past the budget. The product demonstrably works without the optimized copy — that is exactly what the fallback path does today. This removes up to 55 min from every long upload and is a handful of lines.
2. **Transcription must not queue behind optimization.** It needs the audio, not the optimized MP4.
3. Progress for whatever long stage remains — and during remux the carrier is `video_uploads.processing_progress`, not the extraction loop.
4. Cancel-on-delete, then the re-press toast, then the stranded rescue.

**This supersedes the ranking in the design section above.** The extraction-loop progress work is still worth doing; it is simply no longer the headline.

### The ladder, read line by line (`lib/video-convert.ts:393-427`) — and why "skip optimization" is too blunt
```
try   ffmpeg -i <signed url> -c copy -movflags +faststart out.mp4     timeout 10 min
catch ffmpeg -i <signed url> -c:v libx264 -preset veryfast -crf 26 …  timeout 45 min
```
Two different things are hiding behind one name:
- **The copy** is a remux, not an encode — cheap on CPU, but it must pull the entire multi-GB file down the signed URL. For a 2-hour upload that alone can exceed 10 minutes, so it times out on **size, not on difficulty**. What it buys is `+faststart` (moov atom at the front), i.e. the browser can start playing before the whole file arrives. That is worth keeping.
- **The re-encode** is the pure waste: a full libx264 pass over a 2-hour video on 4 shared vCPUs cannot finish in 45 minutes, and it only ever runs because the cheap copy timed out. It has never once produced output for these uploads.

So the sharper fix is not "skip optimization": it is **scale the copy's timeout with duration/size so the cheap remux can actually finish, and stop falling through to the re-encode for long sources** (the fallback path already keeps the raw upload playable, which is what every long video has been served by all along). The judge is being asked to rule between that and a plain probe-and-skip. Naming the trade-off explicitly: dropping optimization altogether costs `+faststart` on large files — slower first play, no correctness loss.

### How often does the optimization pass actually pay off? Counted, not assumed
In the running container's whole life (19 h): `Optimization failed` — **3**. `Optimized video for` (the success line at `process-video.ts:121`) — **0**. Not once. Every one of those three cost up to 55 minutes of ffmpeg and produced nothing, and the videos were served from the raw upload, which is what the team has been watching all along.

**Sample honesty:** three attempts, one container run, all of them the same ~2-hour file — enough to condemn the pass for LONG videos, not enough to say it never succeeds for short ones. Older container logs are gone, so this is the whole record available. Before deleting the pass outright, log a one-line outcome for every optimization attempt and read it back after a week; before then, gate it by duration/size rather than removing it.

**The codebase already states that the optimization is optional** — `workflows/process-video.ts:83-86` docblock: *"Never throws on an optimization failure: the raw upload stays intact and still plays via /api/playlist's existing raw-upload fallback, so a broken ffmpeg run must never brick an otherwise-fine recording."* Skipping or gating the pass is therefore consistent with the design as written, not a departure from it. There is no env flag anywhere in `lib/video-convert.ts`, so any change here needs a deploy — no zero-deploy mitigation exists.

## "mobiledan" — there is no separate mobile defect
Worth stating plainly so nobody hunts one: the owner's presses arrived and were recorded server-side (`aiGenerationRequestedAt` is set), the multipart upload from the phone completed normally, and R2 CORS is healthy. The phone was simply where he happened to be sitting through a wait that would have been just as long on a desktop. The one genuinely mobile-flavoured improvement in the plan is `keepalive:true` on the press, and that is insurance, not the bug.

## ⚠️ CORRECTION — "the optimization never succeeds" was TOO BROAD (measured 2026-08-18)
The 0-successes-3-failures count came from one container window, and that window happened to contain only the big-file attempts. Object sizes, read straight from R2 through the app's own signed URLs:

| video | length | raw upload | result.mp4 | optimization |
|---|---|---|---|---|
| `gbjha7v748yy7yj` | 90 min | 22 MB | **82 MB** | succeeded |
| `bjwk6x3h6zc1mtz` | 120 min | 84 MB | **119 MB** | succeeded |
| `wcrwp896m1sqcvf` | 126 min | **1.22 GB** | absent — `videoType=mp4` serves the raw file, same byte count | FAILED |

So optimization works fine for ordinary team recordings (22–84 MB) and failed on the **1.22 GB** download. That size is the whole story: a gigabyte pulled over the network and remuxed inside a 10-minute budget needs a sustained ~2 MB/s and did not make it; the 45-minute re-encode of a 2-hour 1080p source on 4 shared vCPUs was never going to make it either.

**This does not weaken the fix — it aims it.** Scaling the copy budget with duration (126 min → 45 min ceiling) gives that 1.22 GB copy room to finish; refusing the compress fallback after a TIMEOUT removes the wasted hour; skipping compress past 3600 s stops the doomed re-encode. What it does change is the claim that may be made out loud: **do not say "optimization is pure waste"** — it is waste on large sources only.

**Separate finding, not fixed here, worth its own card:** the "optimization" makes files 1.4×–3.7× BIGGER (22 MB → 82 MB, 84 MB → 119 MB). It buys `+faststart` and codec normalisation, and pays for it in storage and every viewer's bandwidth. Whether that trade is wanted is an owner question, not a bug — record it, do not act on it inside this wave.

## ⚠️ SECOND CORRECTION — the copy timeout is NOT a bandwidth problem (measured 2026-08-18)
The whole reason for scaling the copy budget with duration was the assumption that pulling a large source over the network dominates the cost. **Measured on the box: 22.7 MB/s from R2** (a 200 MB range request in 9.2 s). At that rate the 1.22 GB source is a **54-second** download — nowhere near the 10-minute budget it blew.

So something other than bandwidth makes `ffmpeg -i <signed url> -c copy` take over ten minutes on that file. The likely candidate, untested: ffmpeg reading MP4 over HTTP does not read linearly — if the source's `moov` atom sits at the END (normal for a downloaded or recorded file), it seeks there first, and every seek is a fresh ranged HTTPS request against a presigned URL; `+faststart` then rewrites the output in a second pass. A pathological request pattern, not a slow pipe.

**What this means for the change already made, stated plainly:**
- Scaling the copy timeout is a **mitigation, not a diagnosis**. A 1.22 GB source may still fail at 45 minutes; nobody has proven otherwise.
- **The owner's actual complaint is fixed regardless**, because CHANGE 2 means transcription no longer waits for optimization at all. Whether the optimize pass eventually succeeds or gives up, the user gets their transcript in minutes. That is the number the metric measures, and it is the one that matters.
- **Wave 2 candidate, now with evidence behind it:** fetch the source to local disk once (54 s at the measured rate) and run ffmpeg against the local file instead of the signed URL. If the seek-over-HTTP theory is right, that turns a >10-minute copy into well under a minute. Test the theory before building it — time one `ffmpeg -c copy` against the URL and one against a local copy of the same object.

Recorded because the alternative was to let a plausible story ("big file, slow network") stand as if it had been measured. It had not been, and when it was, it was wrong.
