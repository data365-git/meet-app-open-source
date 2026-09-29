# Ustoz (data365) — STATE

_Trigger words: "ustoz", "cap", "cap-v2", "data365". Source of truth for resume._

> **2026-09-29 - FIX IN PROGRESS (owner: "pul tugasa kut, pul kelsa yo bepul limit ochilsa yakunla, chalg'itma").** ROOT CAUSE: `workflows/transcribe.ts` partial-quota branch fires only when EVERY failed chunk is quota-like; 37fm had 10 quota (402/429) + 2 Gemini 503 -> fell through to COMPLETE-with-gaps. SCOPE: repro = unit test, 3 chunks: ok / 402 / 503 -> must throw TranscriptionQuotaFailureError (ERROR+QUOTA -> cron ladder resumes from partial seed). METRIC: that test red before, green after; `transcribe-quota-failure.test.ts` + transcribe suites all green; genuine-only failures still NOT quota. DIRECTION: a failure set with >=1 quota-like chunk and the rest transient (503/overloaded) is a quota wait; keep/discard by the metric.
> **2026-09-29 - "end of long audio cut off" DIAGNOSED (no code change).** Video `37fm9q81veb28g4` ("Sales meet - AI course Nurbek 1", 4814 s): 12/13 chunks FAILED -> gaps [0,600],[800,3239],[3591,4814] (only ~9 min transcribed). Cause = money, not truncation: OpenRouter balance $0.23 (40 - 39.77) < $0.50 audio floor -> HTTP 402; free Gemini 429 quota; Gemini 503 high demand; gap-fill hit the same walls. NEXT: owner top-up -> re-run gap-fill for 37fm (resume reuses the good chunk). Proposed (not built, owner decides): low-balance guard = defer transcription + auto-resume after top-up instead of COMPLETE-with-gaps, plus an early balance alert.
> OWNER TODO (since 2026-09-29): top up OpenRouter (openrouter.ai -> Credits, $10+) -> you should SEE the balance above $0.50; tell me "to'ldirdim" and I re-run the 1h20m audio; if you'd rather not pay, say so and the video stays partial.
> **2026-09-28 ~14:12 UTC - DEPLOYED `2195e8f` (multi-file import, max 20, sequential).** Merge of 602e393 + 8ba1d5f (5 must-fixes) + c09465c (busy guard inside processFile - a drop bypassed the picker check; judge re-review SHIP, its finding 1 fixed + mutation-proven). 147/147 related tests, typecheck 0, merge gate green. Live: in-flight uploads 0 before switch, container Up on data365-web:2195e8f, /api/health db/storage ok, /login 200, share page renders with 0 console errors, only the benign authorName migration notice. Rollback: `cd /opt/data365 && cp docker-compose.app.yml.bak-2195e8f docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` (-> 46a3bc2). qa-fixes NOT pushed. NOT proven: a real browser picking 3 files (no login credential here) -> OWNER TODO below. Judge low findings left open: no test for the Import-file disabled prop; on cards < ~250 px the Cancel tap area may cover the first waiting file's X.
> OWNER TODO (since 2026-09-28): on data365 dashboard press Upload, pick 3 short videos -> you should SEE "Fayl 1/3" with 2 names waiting, then one final toast "3 tadan 3 tasi yuklandi"; if anything is off, just tell me what you saw (rollback takes seconds).
> **2026-09-27 (later) - 5 must-fixes COMMITTED `8ba1d5f` on feat/multi-import** (spec `_handoff/2026-09-27-data365-multi-import-fixes.md` DONE; GLM hit its time limit exit 124 after the code, Opus verified). 140/140 related tests, typecheck 0; mutation-proven: 602e393 handlers -> 5/6 new tests red, toast fix reverted -> red. Known timing flake: upload-cap-button-fast-path.test.ts (passes alone). Fresh judge re-review running. NEXT: act on its verdict, then merge into qa-fixes + deploy per the line below.
> **2026-09-27 - LIVE POINT: multi-file import COMMITTED `602e393` on branch `feat/multi-import` (worktree `.claude/worktrees/multi-import`), NOT merged/deployed.** Up to 20 files, strictly sequential, per-file X removes a waiting file, Cancel on the current one continues the batch, one summary toast; single-file path unchanged. Built by GLM from `_handoff/2026-09-26-data365-multi-file-import.md` (status DONE); Opus review fixed a real bug (onStart re-added removed files -> `queueAfterStart`, tested). 9 queue tests (parallel mutation -> 3 red), 140 related green, typecheck 0. Blind review = FIX-FIRST, 5 must-fixes written into the handoff spec (section BLIND REVIEW) - #1 is a BLOCKER (FileList read after input reset -> uploads nothing). NEXT: (1) fix the 5 (GLM re-run on the spec or doer), re-review; (2) (3) merge into qa-fixes, full suite, build on host with nohup + BUILD_EXIT marker (never `a && b &` over ssh - it backgrounds the tar cat -> 0-byte tar; never pgrep/pkill with the full-command flag - matches itself), in-flight check, switch image, health/login/share + cron by hand. Dashboard UI cannot be eyeballed here (no login credential on this machine) -> OWNER TODO after deploy.
> **2026-09-26 ~15:30 - DEPLOYED `46a3bc2` (owner law "no waste: resume, never a full re-do").** A transcript that COMPLETEs with gaps now keeps itself as the resume seed (`transcription-partial.vtt`); video edit/restore drops the seed (new clock). GLM blind review SHIP + follow-up applied; full suite 195 files green. LIVE PROOF: pgc1r9a0h4j31af (old COMPLETE, gap [4839,5035]) got its seed copied by a one-off R2 script (`scratchpad/seed-copy.mjs`, env CAP_AWS_ACCESS_KEY/CAP_AWS_SECRET_KEY) + ERROR+QUOTA flip (`/root/repair-pgc1-gaponly.sql`) -> log `resume: reused 34/35 chunk(s)` -> COMPLETE, gaps NULL (~2 cents instead of ~$1). Rollback: `.bak-46a3bc2` compose (-> 3b39a64). Never-started uploads since 09-12: 0 of 16 (dars6.3 = recovered, awaiting press). **IN FLIGHT: multi-file import (max 20, sequential, per-file remove + cancel continues queue)** - spec `_handoff/2026-09-26-data365-multi-file-import.md`, GLM running in worktree `.claude/worktrees/multi-import` (branch feat/multi-import). NEXT: read GLM REPORT + diff, blind review, live-check at 375 px, merge, deploy.
> **2026-09-26 ~12:00 - DEPLOYED `3b39a64` (transient AI auto-retry, 3x bounded + honest "retrying n/3").** 4 blind review rounds (FIX-FIRST x3 -> fixed: nested-SQL `?` test guard now mutation-proven on SELECT + booking UPDATE; unusable-output never classified transient; share page refreshes every 60 s while retrying, resumes live poll on cron re-kick, resetQueries clears stale ERROR). New cron SQL run clean on prod MySQL 8 before deploy; after deploy: container Up, health db/storage ok, login/share 200, `recover-stale-ai-jobs` by hand -> success:true, mobile share page 0 console errors. Full suite 194 files green, typecheck 0. qa-fixes PUSHED. Rollback: `cd /opt/data365 && cp docker-compose.app.yml.bak-3b39a64 docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` (-> 3b41198). **OpenRouter balance $0.66 (35 - 34.34)** - barely above the $0.50 audio floor; pgc1 re-transcription (~$1, gap [4839,5035] speech lost) WAITS on the owner top-up. Lesson: pgrep/pkill with the full-command flag over ssh matches its own bash -c line (hung wait loop, killed own session) - use nohup + a log exit marker.

> **2026-09-25 ~21:20 — DEPLOYED `3b41198` (both GLM jobs shipped). Last point:**
> - JOB B processed-marker `7e57210` (blind GLM review SHIP) + JOB A honest-ai-status `19d2338` (review FIX-FIRST -> 4 findings fixed by GLM: public summary-quota line no longer claims transcript failed, 402 w/o numbers no longer shows $0.00/$0.00, 2 dead-code items removed). Merged into qa-fixes; combined HEAD: typecheck 0, 193/193 test files green.
> - Live: container Up on data365-web:3b41198, health db/storage ok, login 200, share page renders with no console errors (mobile). Rollback: `cd /opt/data365 && cp docker-compose.app.yml.bak-3b41198 docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` (-> 5a8b8ac).
> - ccgg9nqjwmw8ehy had ended aiGenerationStatus=ERROR (free Gemini 429 + paid Gemini 503 at 13:32); re-queued 19:18 UTC via ERROR->PROCESSING + cron re-kick (`retried:1`). ccgg summary COMPLETE (verified in DB + live page, Uzbek summary renders).
> - GAP found live: spec state "S5 OTHER" (e.g. provider 503) was deliberately left as the bare "AI analysis failed. AI generation error." — contradicts the owner's "never a bare failure". Proposed follow-up (not built): an honest transient line + retry. Handoff flow now: Opus writes spec -> `glm-run.ps1 -Handoff` -> GLM blind review -> Opus spot-check -> commit/deploy.
> - qa-fixes is ahead of origin (not pushed — push needs owner OK).

> **2026-09-25 (later session, budget+deploy):** owner ordered the monthly AI limit raised to $100; prod had `monthlyUsdCents=100000000` (= **$1,000,000**, a units mistake — the code multiplies cents ×10,000, `ai-cost-guard.ts:101-104`, so $100 = 10000) — **corrected to 10000 and verified in DB**; month spend $14.02/$100. Also **deployed `e61a9ed`** (cancel-mid-upload review fixes + the 2026-09-24 quota-honesty fix): container Up, health 200 db/storage ok, login 200, only the benign `authorName` migration notice. Rollback: `cp docker-compose.app.yml.bak-e61a9ed` + `up -d`. **The real remaining wall is the OpenRouter balance: $2.52** (35 credits − 32.48 used; ~$1 per 3h audio) — owner top-up pending. Repairs: y71 ✅ gaps NULL · 2creq ✅ 2 gaps = proven real silence · pgc1 ✅ one 196s gap (speech-unmeasured) · ccgg PROCESSING at check time.
<!-- KEEP THIS LINE IN THE TOP 10 LINES. The state-pointer hook reads the quoted
     phrases from the first 10 lines of this file to route the owner's word
     "ustoz" to THIS project. A top-block rewrite on 2026-08-04 dropped it and
     the routing silently broke — restore it in every future rewrite. -->

## GOAL — what "done" looks like
data365 runs on the team's own Contabo server (`https://data365.duckdns.org`) and is **boringly reliable**: uploads finish, AI analysis simply works, the system restarts what stalls, and the owner stops hearing complaints from the team. He is a non-programmer — every screen must say what is happening in a number he can act on.

## ✅ DEPLOYED `5a8b8ac` — 2026-09-25 13:16 UTC (resume-dedup `8a2bfde`, blind GLM review SHIP; typecheck 0, 27/27 touched tests)
Live: health db/storage ok, login/share 200. Rollback: `docker-compose.app.yml.bak-5a8b8ac` (→ b87cb37). Pre-deploy in-flight check: only `ccgg9nqjwmw8ehy` PROCESSING, already dead since the 12:32 GLM deploy restart (heartbeat 12:28:52) → the 13:30 cron should re-kick it on the dedup-fixed code. **NEXT: verify ccgg reaches COMPLETE.**
**Remaining work handed to GLM (owner: "qolgan ishlar specini yoz glmga qildiraman"):** `D:\vibecoding\_handoff\2026-09-25-data365-processed-marker-finish.md` and `...-honest-ai-status.md` (both READY; detail in `docs/plans/2026-09-25-glm-remaining-SPEC.md`). GLM does not commit — on "tekshir": read GLM REPORT + diff, blind non-author review, commit, ONE batched deploy with the in-flight check first.

## ✅ DEPLOYED `b87cb37` — 2026-09-25 12:55 UTC (AI budget card display fix)
Owner: "sayt orqali 100$ qilsam ham refreshdan keyin 10$ga qaytyapti". Root cause: both AiBudgetCard files read the user budget from context `user`, which `resolveCurrentUser` builds WITHOUT `preferences` → always the $10 default; a re-save wrote it over the real cap (likely origin of the $11.63 cap that blocked all AI today). Fix `08da860` reads `userPreferences`; test by GLM-5.3 (RED on revert: `expected '10.00' to be '100.00'`, re-verified by main session); blind GLM review SHIP. Live: container Up, health db/storage ok, login 200, share 200. Rollback: `cp docker-compose.app.yml.bak-b87cb37 docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` (→ e61a9ed). NOT yet eyeballed on the authed settings page (no login on this machine) — owner's refresh is the final check.
Still queued (Opus limit until 17:10 Warsaw): `fix/processed-marker` round-3 fixes (cutoff→processingRunAt, order tests, end-of-run gap, admin replace marker); `fix/resume-dedup` 8a2bfde needs its blind review; honest AI-status UI (owner confirmed wording, NO balance banner) not started — worktree `glm-honest-status` is now on branch fix/budget-display, create a fresh branch for it.

## ▶️ UPDATE 2026-09-25 ~06:05 UTC (new session) — dars6.3 RECOVERED on prod (option 2 done)
- Inserted a `video_uploads` row for `h4tvk8raknrgq5b` (phase 'processing', raw_file_key NULL, updated_at now-2h) → `/root/run-cron.sh recover-stale-ai-jobs` returned `staleUploadRelaunched: 1` → log `Optimization failed ... Compress skipped: durationSec=4082.65` (the benign >3600 s branch, raw kept playable) → upload row gone, `videos.duration` = 4082.65. It is playable; it is NOT transcribed (no press recorded, zero AI spent — by design). `processingStartedAt` is not visible afterwards because the finally-block clears it; the upload-row deletion + log line are the proof.
- Owner said "menimcha qilib bo'lingan" — checked: the 4 cancel fixes were NOT in any branch or worktree (`cancel-upload.ts` has no phase guard, toast still hard-coded English). A doer is on them in a worktree, branch `fix/cancel-review`.
- **Agent routing snag:** `~/.claude/settings.json` env maps `sonnet`→`glm-4.7` and `opus`→`glm-5.3`; the desktop app sends those names to the Anthropic API → HTTP 404 model_not_found. A `model: sonnet` doer died on it. Owner/system decision.
- **Owner answers 2026-09-25 (batch):** (a) 4 damaged audios — "if all one recording, do one and delete the rest; if different, just fix" → measured: 4 DIFFERENT recordings (Samanizade / MS aka AI agent talk 2 / Dars pedagogika #1 / SHMS - Azizbek) → fixed all 4; (b) PREVENT (durable `processedAt`) = YES, building; (c) GLM env block removed from `~/.claude/settings.json`; (d) ultra-tezkor → NORMAL rejim (`.ultra-mode` flag removed).
- **4-audio repair, ~06:17 UTC:** backup of the 4 rows at `/root/repair-4audio-backup-2026-09-25.tsv` on the VPS; flipped COMPLETE → ERROR + `transcriptionError.code=QUOTA` (SQL in `/root/repair-4audio.sql`); cron by hand → `quotaRetried: 3`, the 4th goes on the next */30 tick. No partial checkpoint exists for COMPLETE rows (deleted at `transcribe.ts:2024`), so each is a FULL re-transcription — est. ~$2 total vs $4.99 balance. **NEXT: verify all 4 reach COMPLETE with `transcriptionGaps` empty (the METRIC), and re-read the OpenRouter balance.**
- **~11:04 UTC — the first re-kick silently did NOTHING: org AI budget was $11.63/month (`organizations.settings.aiBudget.monthlyUsdCents=1163`), month spend $11.66 → `transcribeVideo` returned "AI budget exceeded" — ALL AI on the org was blocked.** Rows reverted to COMPLETE, owner asked, he chose **$100** → set `monthlyUsdCents=10000` (user pref already 10000). Re-flipped + cron → 3 rows PROCESSING (`processingStartedAt` 11:03:51); `y71wes3p9q32bg4` next tick (LIMIT 3).
- **Owner 2026-09-25: "Muammoni hal qil".** Loop for the remaining code defects:
  SCOPE: (1) cron quota re-kick (`route.ts:439-462`) clears `transcriptionError` and counts `quotaRetried++` even when `transcribeVideo` returns success:false (budget/no key) → the row is left ERROR with NO code, invisible to every pass forever (observed on prod today, 3 rows); (2) cancel judge findings 1-5 on `bc8724c`; (3) rowless lost-upload recovery (B) blocked by Loom import finishing without `processVideoWorkflow` (`loom.ts:399`, `import-loom-video.ts:194-197,306-308`).
  METRIC: each defect has a unit test that goes RED on revert, GREEN with the fix (mutation-checked by a non-author); root `pnpm typecheck` 0; full suite green; on prod the 4 repaired audios reach COMPLETE with `transcriptionGaps` absent/empty.
  DIRECTION: one fix per defect → measure test → keep/discard; B only with a per-video relaunch cap and a Loom-side `processedAt`.
- **Cancel fixes DONE on `fix/cancel-review`: `bc8724c` + `33f642b`** (judge round 2 findings 1-5 applied; mutation RED evidence for each guard line; root typecheck 0; 188 files / 1605 tests). Main session reviewed the 33f642b diff: clean. Ready to merge.
- **~11:13 UTC: `2creq6ysyk7b074` re-transcribed → COMPLETE but STILL 2 gaps [[6161,6421],[6731,7131]].** Log: `chunk@6121 cue-rescale SKIPPED factor=6.586 (speech span 288s)`, `chunk@6791 too-few-cues (speech span 349s)` → the model returned the text squeezed into a fraction of the chunk's timestamps (or dropped it); gap-fill then went free-only and hit the free-tier 429 (limit 20/day) → kept as gaps. Chunks now ~6 min while the compression artefact was only ever measured at 3 min (comment transcribe.ts ~:1758-1775). Opus diagnosis agent running (read-only): Q1 text present-but-squeezed vs missing, Q2 why free-only, Q3 which model, Q4 smallest fix.
- **DIAGNOSIS DONE (Opus, read-only, measured on prod):** 2creq's 2 gaps are REAL SILENCE (prayer break — "asr o'qib olaylik" 1:42:44 … "O'tiringlar" 1:58:50; silencedetect -30 dB: 3 s/300, 7 s/300, 1 s/100 speech). No text lost. **The real defect is the opposite: chunk@6415.98 (OpenRouter gemini-3.7-flash, ×1.348 rescale) INVENTED 51 cues of a 1C accounting tutorial at 1:47:01-1:52:15 over room noise (8 s speech/375)** — no speaker tags, even 5-7 s spacing, sign-off phrase. Gap-fill correctly skipped paid (speech < 60). Chunk size is 6 min since 8ef9e17 (2026-09-05); the squeeze artefact was only measured at 3 min.
- **Merged `fix/cancel-review` → qa-fixes `1c48832`.** In flight: judge on `fix/processed-marker` (`c79b04f`: processedAt + Loom marker + rowless recovery with 2-attempt cap + quota re-kick `quotaRetryBlocked`; NOTE its cutoff constant 2026-09-25T00:00Z must be moved to the real deploy time); doer on `fix/silence-hallucination` (reject invented chunks via measured speech, calibrated on ≥2 other recordings; label silent gaps; paid-worthy gap failure → QUOTA).
- **OWNER ORDER 2026-09-25 (after the repairs):** "pul tugasa pul tugadi desin — nima muammoligini va aniq statusni ko'rsatsin, yolg'on va bugsiz."
  SCOPE: every AI-stopped state (provider money out = QUOTA; org/user monthly cap = BUDGET; free quota wait; transcript COMPLETE-with-gaps; summary blocked) must show the user the TRUE reason + what happens next, never "Failed"/"done"/silence. Measuring the current UI first (scout, read-only).
  METRIC: a test per state renders the component with that server state and asserts the honest text (RED when the mapping is removed); zero states verdicted MISLEADING/SILENT by a non-author re-scan.
  DIRECTION: one state at a time → test → keep/discard.
- OpenRouter balance 2026-09-25 ~12:10 UTC: $2.52 left (35 credits, 32.48 used; today's repair ≈ $2.47). OWNER TODO top-up relayed.
- **~11:45 UTC repair results:** `y71wes3p9q32bg4` COMPLETE, gaps NONE ✅ · `pgc1r9a0h4j31af` COMPLETE, 107-min gap → one 196 s gap [4839,5035] (not yet measured for speech) · `2creq6ysyk7b074` COMPLETE, 2 gaps = real silence ✅ · `ccgg9nqjwmw8ehy` still PROCESSING.
- **Hallucination guard NOT built — measured impossible by loudness:** calibration (`fix/silence-hallucination` agent) — quiet REAL speech (`y71`@1440: 14.4 s at -30 dB, 23 tagged cues, 117 words) measures the same as silence/invented chunks (8-20 s); at -40 dB room noise reads 251-358 s. A loudness threshold would delete real quiet conversation. Open idea (4 samples only, not built): low speech AND zero speaker tags AND high cue/speech ratio. Needs research before any build. Draft diff: agent scratchpad `items1-4-full.diff`.
- `887be0b` (paid-worthy gap-fill failure → QUOTA re-kick) — **NOT SHIPPING (my call after blind judge):** flipping to ERROR hides an already-readable transcript + summary for up to ~4.4 days (forever after the 12-attempt ladder), and single-chunk videos (≤7 min) have no checkpoint → full re-bill. Branch left unmerged. **The judge also found a LIVE latent defect in deployed a0d43a7:** on quota resume, re-transcribed chunks' fresh cues merge on top of the seed's stale cues for that chunk (no dedup) → duplicated captions. Fix dispatched: branch `fix/resume-dedup` (drop seed cues only for chunks that got fresh cues; keep them if re-transcription fails). Full suite showed 1 flaky upload test per run (different each run, green alone).
- `fix/processed-marker` judge = SHIP WITH FIXES (edit-revert via marker-less trimmed video HIGH; cutoff < deploy HIGH; live-run duplicate in the row-deleted→first-progress gap MEDIUM; tests blind to the rowless SQL) → author applying. Prod check: DB/container are UTC; only 4 rowless untranscribed videos in 30 days, all before the cutoff → B touches none today.
- In flight (old line): doer on `fix/cancel-review` (cancel fixes 1-6); doer on `fix/processed-marker` (PREVENT + rowless recovery pass with a 2026-09-25 createdAt cutoff). Each needs a fresh non-author judge before merge → one image deploy.

## ▶️ LIVE POINT 2026-09-25 ~06:30 UTC — session closed at the context ceiling; resume HERE
Owner's order: "Muammo hal boʻldimi endi jonliga ham chiqar" — make it actually solved, then deploy. Nothing new is deployed yet; prod is still `a0d43a7`.
- **Committed, NOT deployed:** `9aac82c` upload-CANCEL feature (owner order 2026-09-11). Gates green (tsc 0, 187 files / 1596 tests).
- **Two background agents were running when this session closed (both Opus):**
  1. a blind `judge` on `9aac82c` (5 questions: can cancel ever erase a real recording, are multipart parts released on every path, leftovers, UI/i18n, unrequested scope). Its verdict was not read. **Re-run it in the new session** if nothing is on disk — deploy only after SHIP / SHIP WITH FIXES applied.
  2. a `doer` in an isolated WORKTREE fixing the third never-processed shape (dars6.3, next block). Find its result with `git worktree list` and `git branch -a` — a new branch off `9aac82c` touching `recover-stale-ai-jobs/route.ts` + `recover-stale-upload-handoff.test.ts`. Its first duty was to find the durable fact that separates "processing died" from "processed fine, awaiting the analyse press"; if it reported none exists, do NOT ship a relaunch. If it committed: read the diff yourself, get a fresh non-author judge on it, merge, gates.
- **UPDATE ~06:40 UTC — the fixer agent STOPPED correctly and built nothing.** Its finding, with file:line: NO stored fact separates "processing died after deleting the upload row" from "processed fine, awaiting the analyse press". A finished run writes no success marker (`process-video.ts:67-69` deletes the row first; `:292-297` metadata is cleared in `finally` at `:200-207`/`:319-331`); `result.mp4` is not proof (optimize is skipped for non-aac audio over 3600 s, `video-convert.ts:33,288-289,594-601`, swallowed at `process-video.ts:174-190`); duration/width come from the client before processing (`multipart.ts:597-603`). So a healthy 68-min mp3 looks EXACTLY like dars6.3 — any automatic pass would relaunch healthy videos. Also: `startVideoProcessingWorkflow` throws "No upload record found" without a `video_uploads` row (`lib/video-processing.ts:48-79`). Its two options, **owner to decide**: (1) PREVENT — make `processVideoWorkflow` write a durable `metadata.processedAt` as its last step, then a recovery pass can key on its absence (does not help videos processed before); (2) RECOVER dars6.3 once by hand — insert a `video_uploads` row (phase 'processing', key `25s3fqp7e7vc5p0/h4tvk8raknrgq5b/raw-upload.mp4`, updatedAt older than 30 min) and the existing pass relaunches it on the next tick; zero AI cost. Recommended: both. Worktree left at `.claude/worktrees/agent-a8350abed7f60163a` (no changes) — safe to remove.
- **UPDATE ~06:50 UTC — blind judge on `9aac82c`: SHIP WITH FIXES. Do NOT deploy the cancel feature until fixes 1-4 land.**
  1. HIGH — `cancel-upload.ts:55-57` guards on transcription fields only; a recording that is processing or processed-but-untranscribed passes and would be erased (no Trash). Unreachable from today's UI, but the "whatever the client sends" claim is false. FIX: refuse unless a `video_uploads` row exists with `phase = 'uploading'` (set at `create-for-processing.ts:158`, flips to 'processing' at `lib/video-processing.ts:52`) + a REFUSES test for that row.
  2. MEDIUM — `multipart-upload.ts:522` `firstError = error` lets a later "network error" from a parallel worker overwrite the `CancelledUploadError`, so a cancel on a flaky network shows "Failed to upload" and keeps an 'error' row. FIX: after the abort at `:534`, `if (signal?.aborted) throw new CancelledUploadError()`. Same narrower issue in `upload-target.ts:196-201`. Only key the outer catch on `signal.aborted` AFTER fix 1.
  3. MEDIUM — `useImportUpload.ts:366-375`: if `cancelUpload` fails, it still toasts "Upload cancelled." and leaves the row at 'uploading'; a failed `abortMultipartUpload` leaves parts in storage (`permanentlyDelete`'s listObjects cannot see unfinished multipart parts). Check whether the bucket has an abort-incomplete-multipart lifecycle rule.
  4. MED-LOW — `UploadPlaceholderCard.tsx:145`: the X stays until "serverProcessing", which the client sets only after /complete + progress POST — confirming in that window deletes nothing but says it will. FIX: hide the X once all bytes are sent; close the dialog when the status changes.
  5. LOW — 28px button (<44px touch target); "Upload cancelled." toast hard-coded English (`useImportUpload.ts:374`).
  6. LOW — revert formatting-only hunks; make `uploadPartBlob`'s `onabort` read `signal?.aborted` and drop the duplicated `isCancelled` wiring.
- **Then deploy both in ONE image** (recipe: git archive → host `docker build -f apps/web/Dockerfile` → back up compose → switch image tag → `up -d` → health/login/share 200; rollback = the `.bak-<sha>` compose file). Then run `/root/run-cron.sh recover-stale-ai-jobs` by hand and confirm `h4tvk8raknrgq5b` gains `processingStartedAt` — that is the proof the owner asked for.
- **Tier-guard snag:** after the owner switched to `claude-opus-5-5`, the tier guard still recorded the session as `claude-sonnet-5` and refused every command that names this board file — so this board edit is NOT committed. Commit it first thing in the new session.
- Parked (owner decides): repair the 4 gap-damaged 3h audios (~$5) against a $4.99 OpenRouter balance — top up first.

## 🔎 VERIFIED ON PROD 2026-09-25 ~05:30 UTC — is it actually solved? PARTLY. Read this first.
Owner asked: "Muammo aniq hal qilinganmi tekshir." Measured, not assumed:

**3-hour audio "half transcript" (fix `a0d43a7`) — deployed, NOT yet proven on a real recording.**
- Prod runs `data365-web:a0d43a7`, Up 7h, healthy.
- **Zero audio uploads since the deploy** (newest row created 2026-09-24 12:32 UTC, before it), so the new honest-QUOTA path has never run on real data. The METRIC (a 3h audio reaching COMPLETE with `transcriptionGaps` empty) is still unmet.
- **OpenRouter money is no longer the blocker:** `GET /api/v1/credits` → `total_credits 35`, `total_usage 30.01` → **$4.99 left**, above the $0.50 audio floor. At ~$1 per 3h audio that is ~5 recordings — the 4-audio repair (~$5) alone would drain it.
- The 4 damaged audios are still damaged: e.g. `ccgg9nqjwmw8ehy` still reads COMPLETE with 2 gaps. The repair step below has not been run.

**🔴 Silent upload loss is NOT fully solved — a THIRD shape, found today.**
`h4tvk8raknrgq5b` "dars6.3" (68 min, not deleted): a complete **63,499,898-byte `raw-upload.mp4` in storage since 2026-09-24 12:33**, `metadata = {"isAudio": true}`, `transcriptionStatus NULL` — and **no `video_uploads` row at all**. Both recovery passes key on that row (the upload-hand-off pass joins it; the transcription passes need a status), so it is invisible to every cron — 17h and 34 cron ticks returned `staleUploadRelaunched: 0`. Most likely mechanism (unproven): `processVideoWorkflow` deletes the upload row as its FIRST step and then died before stamping `processingStartedAt` — exactly finding 4 of the 2026-09-11 blind review, accepted then as "inherited", now observed in production.
SCOPE for the fix: a non-deleted video older than the staleness window, with no `video_uploads` row, `transcriptionStatus IS NULL`, no `processingStartedAt`, and a present `raw-upload.*` object, is never processed and never retried. METRIC: a unit test for exactly that shape goes red→green and is mutation-checked; on prod, `h4tvk8raknrgq5b` gets `processingStartedAt` within one cron tick of deploy. DIRECTION: extend the recovery pass to a LEFT-JOIN candidate set rather than a new mechanism; relaunch processing only (no transcription, no AI spend).
Also still open: `pcmkzh2rbm4aga9` (2026-09-17) has `result.mp4` but was never transcribed — the "playable but never transcribed" shape.

## ✅ DEPLOYED `a0d43a7` — 2026-09-25 ~00:45 laptop (supersedes the "in flight" line in the block below)
Evidence: container `data365-web:a0d43a7` **Up** · `/api/health` 200 `db:ok storage:ok` · `/login` 200 · the new code is grep-CONFIRMED inside the running container (`'quota/credits exhausted'` + the quotaRetryAttempts cron filter in `/app/apps/web/.next/server/`) · only the benign `ER_DUP_FIELDNAME authorName` migration notice in the first 5 min of logs. Branch pushed `c40d044..a0d43a7` (git is the backup). **Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-a0d43a7 docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` — `2c9dd6b` is still on the host. Remaining for the fix to be VISIBLE: the owner's OpenRouter top-up (OWNER TODO below), then repair + live-verify steps in the block below.

## RESUME HERE — live point 2026-09-25 ~00:30 laptop — 3h-audio "half transcript" bug ROOT-CAUSED, fix `a0d43a7` committed, deploy in flight at write time

**Owner complaint (2026-09-24):** "data365 da 3soatlik audiolar to'liq qilinmayapti, yarmi qilinyapti." All measured on prod; SCOPE/METRIC/DIRECTION in `docs/plans/2026-09-24-3h-audio-half-transcript-SCOPE.md`.

### ROOT CAUSE (measured, not guessed)
dars3 `060m9ty4kqqspxp` (204 min, marked COMPLETE): free Gemini leg 429'd ~72 min in, paid OpenRouter leg 402'd — **"This request requires at least $0.50 in balance for audio"** — so 22/34 chunks died, every failure quota-shaped, yet the workflow wrote `transcriptionStatus=COMPLETE` with `transcriptionGaps [{4315→12265}]` (transcript silently stops at 72 min). COMPLETE rows are invisible to the recovery cron (ERROR+QUOTA only), so the damage was terminal. Paid TEXT calls (summary) kept working — OpenRouter's **$0.50 floor applies to AUDIO requests only** — which made the account look alive. Cost truth from `ai_usage_events`: a 123-min audio = **$0.44** paid transcription → 3h ≈ **$1**.

### THE FIX — `a0d43a7` on `qa-fixes` (root typecheck clean · 86/86 touched-suite tests · blind judge GO-WITH-CONDITIONS, both conditions landed)
Partial all-quota death now throws `TranscriptionQuotaFailureError` (same path as all-chunks-failed): markError records QUOTA → the */30 cron re-kicks and **resumes from the partial checkpoint, re-transcribing only uncovered chunks** once credits return. Judge conditions: markError ops-alerts on every QUOTA death; the cron's LIMIT-3 quota query filters exhausted rows. Tests: C2/C3 in `transcribe-chunks.test.ts` + the reversed MIXED pin in `transcribe-quota-failure.test.ts` (updated with incident citation, not weakened). Deploy health-check evidence lands in the NEXT block above this one (append-only discipline).

### WAITING ON THE OWNER (the money half of the fix)
**OWNER TODO (since 2026-09-25): OpenRouter balansni to'ldirish** — openrouter.ai → Settings → Credits → add funds. Past $0.50 the audio floor clears; **$10 ≈ 10 ta 3-soatlik audio (~$1 each)**. He will SEE: 3h audios finish COMPLETE, full transcript, cron auto-fills within ~30 min of top-up. Undo/adjust: any amount works; without it new 3h audios honestly sit ERROR "AI balance" instead of pretending done.

### AFTER TOP-UP (my next steps, in order)
1. Repair the 4 damaged non-deleted audios by flipping rows to ERROR+QUOTA so the cron re-runs them (~$5): `pgc1r9a0h4j31af` (gap 6109→12538), `ccgg9nqjwmw8ehy` (3598→5738), `y71wes3p9q32bg4` (6254→6979), `2creq6ysyk7b074` (6161→6880). dars3/etb are soft-deleted by the user — skip unless asked.
2. Live-verify the honest path: after top-up, watch one re-kick reach COMPLETE with `transcriptionGaps` empty (the METRIC).

### OPEN, NOT THIS BUG (do not lose)
- **Shape-A never-started RECURRED post-2c9dd6b:** 09-17 `pcmkzh2rbm4aga9`, 09-23 `2meg0g659zqppfk`/`7efxdvdppfwpn1m` at `transcriptionStatus NULL`, metadata `{"isAudio": true}` — the shape the 09-11 fix claimed dead. Separate defect, history in the 2026-09-10 plan.
- ~~Another session's UNCOMMITTED upload work~~ → that was the upload-CANCEL feature (owner order 2026-09-11). Finished and committed 2026-09-25: the 5 red tests were mock gaps for its new imports, now fixed. NOT deployed.
- Accepted edge (judge finding 3, money-only, self-healing): a swallowed checkpoint-save failure makes a re-kick re-bill covered chunks.

⬇ The 2026-09-11 block below is HISTORY (its "RESUME HERE" heading predates this one).

## RESUME HERE — live point 2026-09-11 ~00:45 laptop — ✅ DEPLOYED `2c9dd6b`, live and healthy, and the upload-recovery fix is PROVEN IN PRODUCTION on a real lost recording

**Owner's standing order this session:** "barcha ishlarni yakunla mensiz, toxtama bajarilib done bolguncha" — full autonomy, finish everything. Earlier the same session he gave five product orders and one routing order; every open question was answered in two AskUserQuestion batches. **The whole session's decisions and evidence live in `plans/2026-09-10-transcript-options-refined-export-multi-import.md` — read that before touching this work.**

### 🔴 THE FINDING — about 15% of uploads silently never process, and it is ROOT-CAUSED
Measured on production this session (image `data365-web:d2c400c`, DB `capdb`): 7 rows since 2026-08-01 have `videos.transcriptionStatus IS NULL` **and** no `metadata.processingStartedAt`. Per-day: 08-26 1/5 · 09-02 1/3 · 09-04 2/3 · 09-05 1/2 · **09-10 2/12**.

**Decisive evidence (`video_uploads`, note the snake_case table and column names — `videoUploads.videoId` does not exist):** today's `6b1kdkgr46d3nm5` and `jka07j0jekx883s` both sit at **`phase = 'uploading'` with `uploaded == total`** (165,553,362 and 123,894,845 bytes), `mode` NULL, no `processing_error`. Their `raw-upload.mp4` is complete in R2 and the container log carries "Multipart upload completed successfully" for both. So the bytes arrived, and the hand-off that should have flipped the row to `processing` and launched the pipeline **never took effect**. `videos.updatedAt` never moved after the completion second, which rules out any later write. Right now 2 rows sit in `uploading` and 4 in `error`.

**Root cause (architect agent, HIGH confidence on structure):** the step from "bytes complete" to "processing started" is a single unrecorded, in-process, fire-and-forget call with no reconciler behind it, and transcription has no automatic starter at all. `/api/upload/multipart/complete` (`apps/web/app/api/upload/[...route]/multipart.ts:316-806`) verifies the object with only a ~350 ms retry budget (:555-568), then calls `startVideoProcessingWorkflow` (:624-643) inside a try whose catch logs **without the video id** (:637-642). `apps/web/lib/video-processing.ts:115-117` returns `"already-processing"` **silently without launching**, and `:119-135` runs `processVideoWorkflow(...).catch(...)` un-awaited and outside `after()`. The `"use workflow"` strings are inert: `apps/web/next.config.mjs:230-232` never applies `withWorkflow`, so this is a bare promise in the web process. Crucially, the recovery cron **cannot see these rows**: `apps/web/app/api/cron/recover-stale-ai-jobs/route.ts:191` requires `aiStartPendingUpload <> ''`, so a never-started marker-less row is invisible.

**Why nobody reported it:** people re-upload until it works. `6b1kdkgr46d3nm5` and `3tcqnpjgk139cax` share a byte-identical `raw-upload.mp4` (165,553,362) — the same file uploaded twice, once lost, once fine. Retrying users keep the dashboard clean.

**Do NOT conflate the owner's 09-05 complaint with this.** `mz56jaba64m8z94` ("Platforma_taqdimoti") is a DIFFERENT shape: `phase = 'error'`, `processing_error = 'Upload stalled'`, yet `result.mp4` and `download-audio.mp3` exist in storage, so its video pipeline did finish and only transcription is missing. Whether he pressed the button and it failed, or never pressed, is NOT established — do not claim it either way without the access log.

### DEPLOYED AND PROVEN — 2026-09-11 ~00:45
Container `data365-web:2c9dd6b` Up · `/api/health` `{"status":"ok","checks":{"db":"ok","storage":"ok"}}` · `/login` 200 · public share page 200. Baseline before the switch, for comparison: `d2c400c`, Up 4 days, health ok, 0 error and 0 S3Error lines in the previous hour, 27G free on `/opt`.
**Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-2c9dd6b docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` — `d2c400c` is still on the host.

**The recovery pass fired on real production data, not a fixture.** Triggered by hand rather
than waiting for the `*/30` cron (`/root/run-cron.sh recover-stale-ai-jobs`), it returned
`"staleUploadRelaunched":1`. The recovered recording is **`jka07j0jekx883s`** — the genuinely
lost upload from 2026-09-10 13:33. Its `video_uploads` row is gone (which is what a
successful relaunch does: `processVideoWorkflow` deletes it as step one) and the container
logged `[process-video] Optimization failed for jka07j0jekx883s, keeping the original raw
upload playable: Compress skipped: durationSec=8544.78 exceeds the 3600s compress limit` —
the pre-existing benign branch for a 142-minute recording, so it is playable. A second cron
run returned 0, correctly: nothing else was eligible.

**No AI money was spent.** Neither row carried `aiStartPendingUpload`, so nothing transcribes
until a person presses the button — exactly as the owner instructed.

### ⚠️ I OVERSTATED THE PROBLEM — the corrected numbers
The "~15% of uploads silently lost" figure repeated all through this board was **wrong**: it
counted rows the USER had deleted as losses. Re-measured with `deletedAt IS NULL`:

| date | uploads | genuinely lost | deleted by the user while un-transcribed |
|---|---|---|---|
| 2026-08-26 | 5 | 1 | 0 |
| 2026-09-02 | 3 | 1 | 0 |
| 2026-09-04 | 3 | 0 | 2 |
| 2026-09-05 | 2 | 0 | 1 |
| 2026-09-10 | 13 | 1 | 1 |

**Since 2026-08-01: 60 uploads, 3 genuinely lost — about 5%, not 15%.** The second "stuck"
row from 2026-09-10, `6b1kdkgr46d3nm5`, carries `deletedAt = 11:33:56`: the user deleted it
nine seconds after creating it, which also explains the byte-identical duplicate found
earlier. The pass correctly leaves it alone — resurrecting a deleted video would be a defect.
Say 5% to him, not 15%, and do not quietly drop the correction.

Caveat worth keeping: some of those four deletions may be downstream of the bug — the user
gave up and deleted. `mz56jaba64m8z94` ("Platforma_taqdimoti", the one he screenshotted as
stuck on 2026-09-05) is in that bucket. That is a suspicion, not a measurement.

### KNOWN GAP, not fixed: rows that reached `phase='error'` are never recovered
The pass admits `phase IN ('uploading','processing')` only. The two older lost recordings
(2026-08-26 and 2026-09-02) sit in `error` rows and stay lost. Recovering those is a scope
decision, not a bug fix: an `error` row can also be a genuinely failed upload, and retrying
it burns server work for nothing. Ask him before widening it.

### THE PRE-DEPLOY CHECK EARNED ITS KEEP — read this before trusting the recovery pass
The second blind review plus one production query found that the pass, already committed and
green on 185 test files, **would have recovered nothing at all**: every orphaned
`video_uploads` row — including the two from the incident — carries `raw_file_key IS NULL`,
and the query required it non-null. The fixture had it filled in because the fixture came
from the same belief as the code. Fixed in `2c9dd6b`: a row with an empty key is admitted and
the canonical `raw-upload.mp4` / `.webm` is probed instead.

Three more real findings, all fixed in the same commit:
- the storage probe was a boolean, so "bucket unreachable" was indistinguishable from "object
  gone" — and an absent object gets the row RETIRED, so one expired credential would have
  condemned a whole scan of healthy uploads. Now tri-state; only a real NoSuchKey means
  absent. **How that is detected was measured:** a `runPromise` rejection is a
  `FiberFailureImpl` whose only own fields are stack/message/name, with the original name
  folded into the label `"(FiberFailure) NoSuchKey"` — there is no cause chain to walk.
- `rowsAffected` was a twin of the existing `getAffectedRows`, and the only shape the test
  exercised was one this project's driver never returns.
- the claim did not stamp `updated_at` (no ON UPDATE on that column), so a claimed row whose
  launch threw would be re-claimed every tick forever, holding a relaunch slot.

**Accepted gap, stated not hidden:** two upload-completion paths (the extension/import
finalize branch and instant recording) use `result.mp4` as their raw key, and those rows stay
excluded — admitting them risks re-encoding a finished video onto itself.

### AFTER THE DEPLOY — verify in this order
1. `/api/health` returns `db:ok storage:ok`; `/login` 200; a public share page 200.
2. **Trigger the cron by hand instead of waiting 30 minutes** (it is `*/30` in root's crontab
   as `/root/run-cron.sh recover-stale-ai-jobs`): run that script and read its JSON. Expect
   `staleUploadRelaunched` to be 1 or more, because `6b1kdkgr46d3nm5` and `jka07j0jekx883s`
   are sitting there with complete objects.
3. Then confirm in the database that those two rows moved: `videos.metadata` should gain
   `processingStartedAt`, and their `video_uploads` row should leave `phase='uploading'`.
   **No AI money is spent by this** — neither row carries `aiStartPendingUpload`, so nothing
   transcribes until a person presses the button.
4. Container logs for 5 minutes: clean apart from the pre-existing benign
   `Duplicate column name 'authorName'` migration notice.

**Baseline captured before the deploy, for comparison:** prod was `data365-web:d2c400c`, Up 4
days, health ok, **0 error lines and 0 S3Error lines in the previous hour**, 27G free on
`/opt`.

**Local is 11+ commits ahead of `origin/qa-fixes` and has NOT been pushed** — the project rule
requires his word for a push, and he has given it for the deploy only. Ask him.

### The nine commits, newest first — all gated
- `91962be` fix(cron): **hardening of the recovery pass after the first blind review found
  three real defects.** Worth knowing why this mattered: (a) the object-presence check ran
  after `LIMIT 3`, so three permanently dead rows would have starved every genuinely stuck
  upload forever — the safety net would have existed and never fired; (b) `video_uploads` rows
  are also written by the editor and by admin reprocess, so the pass could have relaunched the
  PRE-EDIT original and silently reverted a user's trim half an hour later; (c) `forceRestart`
  drops the phase guard, so a row claimed by a real upload completing in that window could
  have received a second concurrent `processVideoWorkflow`, two ffmpeg runs racing on
  `result.mp4`. All three fixed, each pinned by a test whose mutation goes RED at value level.
  Dead rows are now retired as `error / Upload never completed` and counted as
  `staleUploadRetired`; the scan is 50 wide with relaunches still capped at 3.
- `19c429a` merge + `5e4d459` feat(share): **"Only transcript" vs "Full AI analysis"** as two
  explicit buttons before anything starts (his order today). All three upload-press redemption
  paths carry the mode, and the stepper no longer describes a three-stage run for a
  transcript-only job. 11 new tests; swapping the modes turns 7 of them RED.
- `83d6884` fix(cron): the `rawFileKey` null-narrowing that the merge below had left behind.
- `945e15a` docs(state).
- `0938194` merge + `cd1b8dc` fix(upload): the recovery pass itself.
- `af7cf67` feat(share): refined-tab copy and `.txt`/`.docx` download.
- `24ccad7` merge + `f8bd476` fix(share): **refined blocks expand, collapse and stop
  hijacking audio** — the six defects he dictated by voice. The first one was not the toggle
  at all: three click handlers seeked the player, two of them on the block and the title, so
  an ordinary click jumped playback and the panel re-rendered around the new position, which
  is exactly what "the block gets replaced" looks like. Only the play button seeks now.
  7 jsdom tests that drive the real component; mutation-checked twice at value level. The
  child's ~26 strict-null type errors were fixed by the main session with helpers that THROW
  and name what is missing — zero non-null assertions, no new casts, every assertion
  unchanged.

### Owner-confirmed today, close these
- **"videoni audioga ogirish ishlayapti"** — his words. ClickUp `z92046pvu0`'s bug claim is
  settled (it was filed 2026-09-04, before the fix shipped). **Two of its three requirements
  are still OPEN and are small:** move the option out of the surface header button into the
  three-dot (⋮) menu — our own review wanted this too, since the action permanently overwrites
  the video and reaching an irreversible action in fewer clicks is the wrong direction — and
  show audio in the preview after conversion.

### NOT verified, and must not be claimed as done
Nothing in these six commits has been clicked by a human. There is no login credential on this
machine, so every owner-gated control — the two start buttons, the refined copy/download, the
collapsible blocks — has been read and reasoned about, never pressed. One specific risk to
watch on iPhone: the `.docx` anchor click happens after `await Packer.toBlob`, outside the
tap's user-activation window, unlike the synchronous `.txt` path.

### Still open, deliberately not done
- From the first review of the recovery pass: the 4 tests do not assert the query predicates
  themselves (the db mock ignores `where`/`limit`), and a relaunch that dies the same way the
  original did leaves no error, because `processVideoWorkflow` deletes the row as step one.
- **Fix C is the owner's decision and is NOT built:** making "audio uploaded" mean "audio
  transcribed" without a press costs roughly $0.5 per import, automatically. Ask him.
- Multi-file import (up to 20, upload only, AI still one-by-one — his correction) and
  cancel-an-upload-mid-flight are specced and unbuilt. Specs are in the scratchpad; the plan is
  `plans/2026-09-10-transcript-options-refined-export-multi-import.md`.
- The audio extraction waste: 47 minutes of wall clock across 238 chunks today at a flat ~11 s
  per chunk, which points at per-chunk source re-reads rather than encoding. Mechanism named,
  saving NOT yet measured.

### COMMITS LANDED THIS SESSION — both gated, neither deployed
- **`af7cf67`** feat(share): copy + .txt/.docx download on the refined transcript tab.
  Details in the section below. Blind non-author review returned SHIP WITH FIXES; all three
  substantive findings were applied before the commit (lazy `await import("docx")` so
  share-page viewers do not pay ~220 KB gzipped, the recording title threaded as a prop from
  `ShareVideo.tsx` instead of read out of a react-query cache by literal key, and
  `stripMarkdownBold` narrowed to PAIRED markers so .txt, .docx and the screen agree).
- **`cd1b8dc`** + merge **`0938194`** fix(upload): recover uploads whose processing hand-off
  was lost — the fix for THE FINDING below. Built by GLM-5.3 from the written spec.
  New reconciliation pass in `apps/web/app/api/cron/recover-stale-ai-jobs/route.ts` keyed on
  the durable facts (a `video_uploads` row still in `uploading`/`processing`, older than the
  staleness window, whose raw object is genuinely present in storage) rather than on the
  marker the lost step writes. Relaunches with `forceRestart: true`, capped at 3 per tick in
  both SQL and JS because the relaunch runs ffmpeg inline. **No transcription is started and
  `aiStartPendingUpload` is never written — this costs server CPU and zero AI spend.**
  Plus the observability fixes: the video id now appears in the two multipart-complete catch
  logs and on the silent `"already-processing"` return in `apps/web/lib/video-processing.ts`.

**Gates on the merged tree, run by the main session:** `tsc -b --force` exit 0 · full suite
**183 files / 1558 tests passed**, 26 skipped, exit 0 · the merge commit itself went through
the repo's pre-commit gate (it BLOCKED the first attempt — GLM's version did not typecheck,
`rawFileKey` is nullable in the schema; fixed with a JS narrowing guard rather than a cast,
which also makes a future loosening of the query fail loudly).

**Mutation check re-run by the main session, not trusted from the agent's report:** disabling
the storage guard makes the "absent object is left untouched" test fail with
`expected "spy" to not be called at all, but actually been called 1 times`, then pass again
on revert. Also verified by diff that **zero `expect` lines** were removed or altered in the
two pre-existing test files whose mocks the agent extended.

**Still open on this fix:** a blind non-author review is running against five questions — can
the pass ever spend money, can it corrupt a live run, is the candidate query right, does it
fail safe, and would any of the 4 tests still pass with the feature removed. Read its verdict
before deploying.

**Fix C remains the owner's call and is NOT built:** making "audio uploaded" mean "audio
transcribed" without a press would cost roughly $0.5 per import, automatically. Ask him.

### IN FLIGHT (GLM-5.3 children, each in its own worktree)
- **Only transcript vs Full AI analysis** — `wt-mode`, branch `glm/two-mode-choice`. Note it
  is also editing `recover-stale-ai-jobs/route.ts` (its spec required a decision on all three
  upload-press redemption paths), so expect a merge conflict there against `0938194` and
  resolve it by hand.
- **Refined blocks collapsible** — `wt-collapse`, branch `glm/refined-collapsible`, from
  `0938194`. Six defects the client dictated by voice: expand/collapse not working, the
  chevron missing or clipped, no auto-collapse, plain clicks on a block or title moving audio
  playback, title click should close, and the first block open by default. The likely cause of
  the first one is already traced: three `handleChapterSeek` click handlers, two of them on
  the block and title, so an ordinary click jumps the player and the panel re-renders around
  the new position — which reads as the block being replaced. Only the play button keeps its
  seek.

### DONE and VERIFIED this session (uncommitted at the time of writing) - refined-tab export
The refined (cleaned-up) transcript tab now has a copy button and downloads as **.txt and
.docx**, matching the plain transcript tab which already had them. Built by a GLM-5.3 child
from a written spec; verified by the main session, not by the author.

Files: `apps/web/app/s/[videoId]/_components/panels/RefinedTranscriptPanel.tsx` (modified),
`apps/web/lib/refined-transcript-export.ts` (new, 165 lines),
`apps/web/__tests__/unit/refined-transcript-export.test.ts` (new, 12 tests), one key
`downloadDocx` in each of the three locale files, and `docx@^9.7.1` in
`apps/web/package.json`.

**Gates, run by the main session:** `tsc -b --force` exit 0 - full suite **182 files / 1553
tests passed**, 26 skipped, exit 0 (baseline 181 / 1540) - **no CRLF churn** (`--shortstat`
and `-w --shortstat` identical at 455/128) - lockfile churn inspected: no dependency changed
version, only docx added.

**Mutation check, done and passed:** forcing `bold: false` in the docx run builder turns the
bold test RED with a value-level message (expected the run XML to contain `<w:b/>`, got
`<w:b w:val="false"/>`), not a missing-symbol error, then GREEN again on revert. That test
is a real guard.

**Two defects found in the agent's own tests and fixed by the main session** - the agent
wrote tests that failed against its own correct implementation: (1) a typo, `"CRM rejesini"`
where the fixture says `"CRM rejasini"`; (2) assertions on raw text where Word escapes
apostrophes. **Measured** with docx 9.7.1: an apostrophe is emitted as `&apos;`, so the test
helper now decodes `&apos;` and `&quot;` only, leaving `&lt;`/`&gt;`/`&amp;` alone so tag
matching still works. The implementation was never wrong.

**Also measured:** the generated package is structurally a real Word file - 22 parts
including all four required ones (`[Content_Types].xml`, `_rels/.rels`,
`word/document.xml`, `word/_rels/document.xml.rels`), so it opens in Word rather than being
a renamed zip.

**NOT verified and must not be claimed:** nobody has clicked these controls. The refined tab
sits behind a sign-in and no login credential exists on this machine, so the on-screen
button placement, the copy confirmation and a real download on a phone remain owner-verified
only.

### GLM-5.3 ROUTING - measured result, the owner should know this
His order was to burn the GLM allowance first. Followed. **Measured outcome on the first
three dispatches, each a written spec via `glm-run.ps1` at a 900 s budget: all three hit the
timeout (exit 124). Only one had written any files at all; the other two produced nothing in
15 minutes.** The one that did produce work also damaged the shared dependency tree - after
its run, `tsc` failed with `Cannot find module 'vitest'` and `@ts-rest/core`, and a root
`pnpm install` was needed to restore it (7.4 s, no version changes).

Changes made in response, not abandoning his order: the budget is now **2700 s**, and every
spec carries a TIME BUDGET block telling the child to read only the named files, to run ONLY
its own new test file, and explicitly NOT to run `tsc -b --force` or the 181-file suite -
the main session runs those. The full suite alone takes minutes and is the likeliest thing
that consumed the first attempts. Each job also runs in its **own git worktree** with
junctioned `node_modules` (under the user's Temp directory as `wt-fixa` and `wt-mode`) so
two children never write the same tree.

### ▶️ NEXT STEP — Fix A, then the four features, in this order
**Fix A (safety net, $0 of AI, catches the whole class).** In `recover-stale-ai-jobs/route.ts` after the pending-request loop (~:404): select `video_uploads JOIN videos` where `videos.deletedAt IS NULL AND phase IN ('uploading','processing') AND updated_at <= now-30min AND raw_file_key IS NOT NULL`, `LIMIT 3` (the relaunch runs ffmpeg inline — that is why the neighbouring loops cap at 3). HEAD the raw object (reuse `verifyRawFileUploaded` from `apps/web/actions/video/trigger-processing.ts`); if `ContentLength > 0` call `startVideoProcessingWorkflow({ …, forceRestart: true })` — `video-processing.ts:60-61` already supports it. Object absent → leave untouched. Report a `processingRelaunched` count. Idempotent via the CAS in `apps/web/lib/transcribe.ts:305-339`. Also add the video id to the log calls at `multipart.ts:637-642` and `:748-753` and log the silent `already-processing` outcome — without that, the next incident is again "no line mentions the id".
Tests (must assert the OUTCOME, then be mutation-checked): stale row + object present → relaunch with `forceRestart:true` · row younger than 30 min → untouched · stale row, object missing → untouched · at most 3 per tick.

**Fix C is an OWNER decision, not a bug fix — do not ship it silently.** Making "audio uploaded" mean "audio transcribed" without a press means writing `aiStartPendingUpload` at birth (`apps/web/actions/video/create-for-processing.ts:128-131`) and costs roughly $0.5 per audio import, automatically. Hukm: shubhali until he says he wants every import billed without a press. Ask before building.

**Then, in order:** the Only-transcript / Full-AI choice · the refined-tab export · upload cancel · multi-file import LAST (it must not ship before Fix A: at a 15% silent loss a 20-file batch loses about three recordings and nobody can tell which three — stated to him in those terms).

### Money — measured today, and it is the real cost story
2026-09-10: 13 videos, **$4.98** in one day, against a month-to-date total of $7.61. The free Google quota died around midday (free rows per hour 7 → 16 → 23 → 8 → 6 while paid went 24 → 6 → 48 → 111 → 88), so everything after ~12:00 ran on paid OpenRouter (287 paid rows on `openrouter/google/gemini-3.7-flash`). `GEMINI_API_KEY` and `GEMINI_API_KEY_FREE` are still the SAME key on prod (sha256 `075c5dfd8827` both) — one free quota, and the ladder has exactly one free slot (`apps/web/workflows/transcribe.ts:933`, `apps/web/workflows/generate-ai.ts:1008`). Default cap is $100/month and $20/video (`apps/web/lib/ai-cost-guard.ts:34-35`); nothing is near it this month, but at $5 on a heavy day the cap becomes reachable, and hitting it makes AI stop with `BudgetExceededError`.

### Answered for him this session (measured, not guessed)
He asked why an already-audio upload still says "extracting audio" and whether time is wasted re-converting. It is NOT pointless: `apps/web/lib/audio-extract.ts:70-95` deliberately downmixes to mono, 24 kHz, 64 kbps mp3 so the file sent to Gemini is small and cheap; keeping the original codec would be slower and dearer. The **real** waste is that the source is read from R2 repeatedly — one silence-detection pass over the whole file, then one `-i <signed URL>` per chunk in the loop at `:466-485` (about 16 reads for a 92-minute recording)  instead of fetching once and slicing locally.

**MEASURED the same session, from the container log's own timestamps** (the gap between
"Local ffmpeg audio check for <id>" and "Extracted N audio chunks for <id>"), across the ten
recordings processed on 2026-09-10:

| recording | audio length | chunks | extraction wall time |
|---|---|---|---|
| 2nc76rs8d16wqsq | 42 min | 7 | 74 s |
| 3tcqnpjgk139cax | 179 min | 30 | 472 s |
| qm91w4h7nvnab7e | 144 min | 24 | 277 s |
| 61wgws9zcj9k4p7 | 132 min | 22 | 240 s |
| 1d89tjnk2qkjycd | 107 min | 18 | 216 s |
| sk3h9m6ars30gf2 | 141 min | 24 | 265 s |
| vbgh19d40dczfn9 | 141 min | 24 | 234 s |
| 2w0angvrzkh98cs | 172 min | 29 | 356 s |
| qt40a98b80w1ax9 | 146 min | 24 | 275 s |
| 6zk3qenctyw0d0x | 213 min | 36 | 424 s |

**About 47 minutes of wall clock went to audio extraction alone today, across 238 chunks —
a strikingly steady ~11 s per chunk regardless of recording length.** That flat per-chunk
cost is the signature of per-chunk overhead (a fresh range request and decode of the source
for every slice) rather than of encoding work, since a 6-minute mono 24 kHz 64 kbps mp3
encode is a few seconds at most. The window also contains one full-file silence-detection
pass per recording.

**What is NOT yet proven:** how much of the ~11 s a fetch-once-then-slice-locally design
would actually save. The mechanism is identified and the baseline is measured; do not quote
a saving to the owner until a one-file experiment measures it. Note also that today's batch
was 23.6 hours of audio in one afternoon, which is the real reason the day cost $4.98.

### False alarm, do not chase
About 86 ERROR lines per 24 h whose entire body is `{"cause":{"name":"NoSuchKey"},"_tag":"S3Error"}` come from `packages/web-backend/src/S3Buckets/S3BucketAccess.ts:35`, where `wrapS3Promise`'s `Effect.tapError(Effect.logError)` fires before any caller `catchTag`/`Effect.option` can swallow it. Most are deliberate existence probes (`apps/web/app/api/playlist/route.ts:116` and `:287`). Fix the CLAIM — log the object key at that same line — do not silence the trigger.

### Worker routing — standing order 2026-09-10
"barcha arzon ishchi kuchini glm 5.3ga qildir": burn the GLM allowance before the Claude allowance. Cheap DOING goes to `powershell -File C:\Users\mirko\.claude\scripts\glm-run.ps1 -PromptFile <spec> -Dir D:\vibecoding\ustoz-github -Model glm-5.3`. Verified this session: `-Check` → CHECK PASS, glm-5.3, 19.5 s. UNCHANGED: review/judge stays on Claude (same-family reviewers share blind spots) and `~/.claude` never goes to GLM. He also warned GLM can hang — `-TimeoutSec` is the guard, 900 s used here.

### ClickUp — 41 open tasks, and two contradict this board
All four of his verbal orders were already filed, so none of it is new scope: `z92046pvtu` (transcription-only, high) · `z92046r2vf` (refined blocks collapsible, high) · `z92046jw05` and `z92046jw04` (upload flow) · `86eyh74fk` (title from the uploaded file name — which is why today's batch is named "1".."11"). **Two high-priority reports contradict what this board treats as settled:** `z92046pvu0` says "videoni audioga o'girish ishlamayapti" while this board records the owner confirming "sinaldi hammasi ishlayapti" on 2026-09-06 — one of the two is wrong; and `86eyjtx4p` says AI progress disappears after a page refresh, which may share the root cause above. Settle both before promising him anything about that button.

## (previous) live point 2026-09-06 ~17:10 — ✅ DEPLOYED `d2c400c` (FREE/PAID cost pill + alias-key $0 guard); owner glance pending

### 2026-09-06 ~17:10 — ✅ DEPLOYED `d2c400c`, live and healthy; NOT yet seen by the owner
Deploy (scripted, `scratchpad/deploy.sh`): `git archive d2c400c` → host build `BUILD_OK` → `docker-compose.app.yml` backed up to `.bak-d2c400c`, image line `643babf` → `d2c400c`, container recreated. Measured after: container `data365-web:d2c400c` Up · `/api/health` `{"status":"ok","checks":{"db":"ok","storage":"ok"}}` · `/login` 200 · public share `/s/zp46nk5t66cdqfv` 200 · Browser pane, anon share page, mobile viewport: **0 console errors** before AND after (baseline captured pre-deploy) · container logs 5 min: only the pre-existing benign `Duplicate column name 'authorName'` migration notice. **Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-d2c400c docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` (→ `643babf`, still on the host).
**What shipped:** cost card leads with a PULLIK (amber) / BEPUL (green) pill + paid amount; renders for free-only videos ("0 so'm to'landi"); second line "qisman bepul kvota: ~X tejaldi" only when ≥ 1 so'm; live pill while a run is in flight ("Hozircha bepul" → "Pullikka o'tdi"), driven by ShareVideo's `aiPollEnabled` + a final refetch at terminal; all four server-Gemini legs (transcribe, generate, translate, chat) record $0 when the server key is the free-key alias (never a personal owner key, never OpenRouter). Prop `costPanel` → `showCostPanel`. 6 i18n keys ×3 locales.
**NOT verified by machine (owner-only card, no login here):** the pill itself on a real video. **OWNER TODO (since 2026-09-06):** open `ny3tnmep1rjmrds` → expect **PULLIK · 5 882 so'm** + "qisman bepul…"; open `yjwprjdjdx25b8d` → expect **BEPUL · 0 so'm to'landi**; on any NEW recording watch the pill say "Hozircha bepul" and flip if quota runs out. Wrong → tell me, tag rolls back in seconds.
**Housekeeping:** `qa-fixes` pushed to origin 2026-09-06 with the owner's word (`7e3d560..6bc6d3b`); local == remote again.

## (previous) live point 2026-09-06 ~15:30 — NEW WORK IN FLIGHT: FREE/PAID cost pill (plan approved, doer building)

### 2026-09-06 ~15:30 — IN PROGRESS: cost card must say BEPUL / PULLIK at a glance (owner: "bepulmi yo pullikdan ketyaptimi tushunishmayapti", "ui juda aniq bo'lsin bir qarashda")
**Plan (approved, judge-reviewed, all 6 findings closed):** `C:\Users\mirko\.claude\plans\narx-ko-rsatishni-yanada-aniqlashtirish-composed-spindle.md` — read it before touching this work. Owner decisions in it are binding: TWO states (PULLIK · X so'm / BEPUL · 0 so'm to'landi, no "ARALASH"), owner-only visibility unchanged, live label while a run is in flight, historical 08-09..11 phantom rows NOT corrected, deploy approved once gates + blind review are clean.
**Facts found today (prod, measured):** paid ⇔ `costUsdMicros > 0` ⇔ `openrouter/…` model, free ⇔ `$0` non-embedding rows — clean since 2026-08-14. **`GEMINI_API_KEY` and `GEMINI_API_KEY_FREE` are the SAME key on prod** (identical sha256); owner confirmed the Google project is free and OpenRouter is the only paid channel → the plan's part D records any "paid Gemini" call on that key at $0. Test videos for his glance after deploy: `ny3tnmep1rjmrds` (PULLIK · 5 882 so'm, 51 free rows) and `yjwprjdjdx25b8d` (BEPUL, 12 free rows).
**UPDATE ~17:00 — BUILT, REVIEWED, COMMITTED `d2c400c`; deploy of `d2c400c` was RUNNING when this line was written (build on host → tag switch → health).** Gates on the final tree, run by the main session: `tsc -b --force` exit 0 (106 s, then 114 s after follow-ups) · full suite **181 files / 1540 tests** passed, 26 skipped (baseline 179/1529) · CRLF parity · 3 mutation checks red→green. Judge round 2 (non-author, on the diff): SHIP AS-IS + one follow-up (translate + chat legs also needed the alias-$0 guard) → applied, plus the "~0 so'm" line gate; a third narrow judge on those 4 hunks: PASS. If this session died mid-deploy: `ssh` in, `docker images | grep d2c400c`, `grep image: /opt/data365/docker-compose.app.yml`; finish with the 3-command tag switch in the 643babf note below; rollback = `.bak-d2c400c`.
**(earlier) State:** one `doer` is building A–D from the plan (server field, pure tier rule, card + ShareVideo prop change, safety fix, 6 i18n keys, tests). NEXT after it lands: main session reads every changed file → gates → blind `judge` on the diff (bar in the plan §Verification 3) → deploy via the usual image-tag switch → tell the owner to open the two videos above. If this session died mid-way: `git status` in the repo shows the doer's uncommitted work; the plan file is the spec.

## (previous live point) 2026-09-06 ~00:10 (DEPLOYED 643babf, live and healthy; only a human click is left)

### 2026-09-06 ~00:10 — ✅ DEPLOYED `643babf`. Live, healthy, and NOT yet clicked by a human.

**Deploy done:** image built, `docker-compose.app.yml` backed up to `.bak-643babf`, the one `image:` line switched from `a8c1bd0`, container recreated. Measured after: `/api/health` 200 `{"status":"ok","checks":{"db":"ok","storage":"ok"}}` · `/login` 200 · public share page 200 · container `data365-web:643babf` Up · logs clean apart from the pre-existing benign `ER_DUP_FIELDNAME` migration notice and the Tinybird-not-configured warning. **Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-643babf docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` — `a8c1bd0` is still on the host.

**The one thing still unproven: nobody has pressed the buttons.** No login credential exists on this machine, so the two-stage flow and the header buttons have been read and reasoned about, never clicked. That is the whole remaining risk surface.

**UPDATE 2026-09-06 ~13:40 — ✅ OWNER CONFIRMED, closed:** owner tested live and reported "sinaldi hammasi ishlayapti" (tested, everything works) — no granular per-button breakdown given, taken as a pass on both the two-stage transcript/AI flow and the "Audioga almashtirish" button. This was the last open risk on `643babf`. Nothing pending on this deploy now; next work needs a new owner direction.

--- superseded notes from the mid-deploy stop, kept for the reasoning ---

**Where it stands.** Two commits landed after the ones described below: `a4c5b99` (the feature) and **`643babf`** (the fix a blind review forced). Production is still on **`a8c1bd0`** — nothing user-visible has changed yet. `data365-web:a4c5b99` was built and is now STALE (superseded); the build for `643babf` was running when this session stopped. Check it first: `ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 "docker images | grep 643babf; tail -4 /tmp/build-643babf.log"`. Source is already extracted at `/opt/data365/app-643babf`; if the image is missing, rebuild with `cd /opt/data365/app-643babf && docker build -f apps/web/Dockerfile -t data365-web:643babf .` (the Dockerfile is at `apps/web/Dockerfile`, NOT the repo root — a build from the root fails with "no such file").

**The defect the second review caught, and why it mattered.** The first pass flipped `aiGenerationEnabled` to `false` at all three transcription entry points and declared transcript-first done. It was a NO-OP for the owner's most common flow. `generate/route.ts` also stamped `metadata.aiGenerationRequestedAt` when the press happened during upload; nothing ever clears that marker, and `shouldStartAiAfterTranscription` returns `aiGenerationEnabled || hasPendingAiGenerationRequest(metadata)` — the OR put the auto-chain straight back. Every gate was green because the tests asserted the ARGUMENT that was changed, never the OUTCOME. `643babf` stops writing that marker on a not-yet-transcribed video (the PROCESSING branch still writes it, correctly — there the transcript is already underway so a press really does mean "run AI after"). Two assertions added and **mutation-checked**: restoring the old write turns both RED. Lesson filed in memory as the 11th shape of `feedback_unasserted_rule_is_not_a_rule` — a flag an OR can bypass is not a switch.

**▶ NEXT STEP — three commands, then verify.**
1. `cd /opt/data365 && cp docker-compose.app.yml docker-compose.app.yml.bak-643babf && sed -i 's|data365-web:a8c1bd0|data365-web:643babf|' docker-compose.app.yml && grep -n 'image:' docker-compose.app.yml`
2. `docker compose -f docker-compose.app.yml up -d`
3. Verify: `/api/health` must return `db:ok storage:ok`; `/login` 200; a public share page 200.
**Rollback, seconds:** `cp docker-compose.app.yml.bak-643babf docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` — `a8c1bd0` is still on the host.

**What is verified and what is NOT — do not overstate this to him.** Verified by machine: `tsc -b --force` exit 0 · 179 files / **1529 tests** passed, 26 skipped · no CRLF churn · two independent blind Fable reviews, all blocking findings fixed. NOT verified: **no human has clicked any of it** — there is no login credential on this machine, so the two-stage flow and the header buttons have only ever been read, never pressed. One full-suite run failed once and the immediate re-run was green at 1529; the repo already documents `upload-cap-button-fast-path.test.ts` as a known pre-existing flake, but the failing test name was not captured, so treat it as uncharacterised rather than dismissed.

**OWNER TODO (since 2026-09-05):** after the deploy, open a NEW recording and confirm the two-stage flow — the transcript appears and is usable WITHOUT a summary, and pressing "Xulosalash" then produces the summary. He confirmed he usually presses the button before the upload finishes, which is exactly the path `643babf` fixes, so that is the path to test. **Separately, and this one carries real risk:** the header's new "Audioga almashtirish" button permanently destroys the video (audio survives; transcript and AI survive). Test it the FIRST time on a throwaway recording, never a client meeting. Undo valve for everything: tell me and the image tag rolls back in seconds.

**CLOSED 2026-09-06 ~13:40:** owner confirmed "sinaldi hammasi ishlayapti" — this OWNER TODO is done, delete this line on the next full board rewrite.

**Left open, deliberately, not blockers:** the second review's optional note that the header button reaches the destructive confirm in 2 clicks vs the dashboard's 3 (moving it into the owner-only "..." menu would restore the dashboard's shape); the running stepper still says "stage 1/3" and weights a 65% bar for a run that now stops after transcription; the mobile share-menu download still gates on `isDownloading` rather than the combined flag; `canReplaceWithAudio` is computed in `Share.tsx:509` and threaded to `CapVideoPlayer`, which never uses it — dead plumbing worth deleting when someone is next in that file.

### 2026-09-05 (evening) — CORRECTED + reviewed + committed, NOT deployed. Deploy is the next step and needs his word.

**The audio button was built WRONG and is now right.** I first read "audioga almashtirish" as a playback-mode toggle and built one (URL param + audio chrome). The owner corrected it: he means the REAL, already-existing `replaceVideoWithAudio` server action — the one the dashboard card has offered since T4b, which permanently overwrites `result.mp4` with extracted audio and reclaims the raw upload. Its own docstring records why it must stay behind a confirmation: a 53-minute client meeting was replaced on 2026-08-06 and came back at telephone quality with no way back. **What shipped instead:** the header button (owner-only, hidden once `isAudio`) opens the SAME destructive-styled `ConfirmationDialog` the dashboard uses, reusing the existing `replaceWithAudio*` keys — no new i18n. My toggle mechanism was fully reverted; `ShareVideo.tsx` is byte-identical to HEAD again. Useful find: `canReplaceWithAudio` is ALREADY computed in `Share.tsx:509` (owner && !isAudio) and threaded to `CapVideoPlayer`, which never uses it — dead plumbing, left in place, worth deleting when someone is next in that file.

**Transcript-first now covers EVERY entry point, not one.** The blind review caught that `generate/route.ts:172` was only ONE of three dispatch paths — `process-video.ts` and `recover-stale-ai-jobs/route.ts` also start transcription when they redeem an upload-time press (`aiStartPendingUpload`), and both still forced `aiGenerationEnabled=true`. Asked the owner whether he presses "AI tahlil" before the upload finishes: **he does, routinely** — so without this the whole feature would never have fired in his actual daily flow. All three now pass `false`. Verified safe: marker redemption keys on `result.success`/`result.code`, never on the flag.

**Blind non-author review (Fable): SHIP WITH FIXES — all fixed.** (1) the URL-param toggle re-ran the `?t=` deep-link effect and yanked playback back ~4s on every press — gone with the toggle; (2) the three-path gap above; (3) the Download menu's spinner/disabled tracked only video, so audio (ffmpeg over the whole recording on first request) looked idle and ate re-clicks — now `isPreparingDownload` covers all three; (4) four orphaned i18n keys removed from all locales. Claims verified by the reviewer: branch split in `GenerateAiPanel` is control-flow-equivalent; `CapVideoPlayer`'s `isAudio` is chrome-only; the new transcript route matches `audio/route.ts`'s same-answer-for-missing-and-forbidden discipline; `use-ai-status.ts` untouched.
**Left open, cosmetic (his call, not a blocker):** the running stepper still says "stage 1/3" and weights a 65% bar for a run that now stops after transcription, and the first-branch button still reads "Start AI analysis" while it only transcribes.

**Gates on the final state:** `tsc -b --force` exit 0 · `pnpm --filter @cap/web test` **179 files / 1528 tests passed**, 26 skipped · CRLF matched (233/48 both ways). Two tests updated (not weakened) to assert the new intended behaviour: `pending-ai-request.test.ts` — the upload-time press must still START the job, now as transcript-only, and the source-text guard on `reclaimProcessing` re-anchored to the new 3rd argument.

**▶ NEXT STEP — deploy, and it needs his word first.** Everything is committed locally; nothing is on the server. The owner was asked whether to deploy tonight or in the morning, because after this lands EVERY new recording stops at the transcript and the team must know to press "Xulosalash" for a summary. Deploy is the same one-line image switch as `a8c1bd0`: ship the source tar to `/opt/data365/app-<sha>`, `docker build -f apps/web/Dockerfile -t data365-web:<sha> .`, `cp docker-compose.app.yml{,.bak-<sha>}`, switch the one `image:` line, `docker compose -f docker-compose.app.yml up -d`. **Verify after:** `/api/health` `db:ok storage:ok`, then ask him to open a fresh recording and confirm the transcript appears WITHOUT a summary and the "Xulosalash" press produces one — nothing here has been clicked by a human yet, because no login credential exists on this machine.

### 2026-09-05 — transcript-first UI bundle built (NOT yet committed/deployed) + chunk-size reverted to 6min

**Owner's request, from a live screenshot of a stuck video ("Platforma_taqdimoti"):** (1) use the free Gemini quota more efficiently — bigger transcription chunks IF it doesn't hurt quality; (2) stop bundling AI summary/tasks with transcription — transcript should be usable on its own, summary optional via a button; (3) turn the header's audio-download button into a "switch to audio-only playback" toggle, and fold audio download into the main Download button as a dropdown item.

**1) Chunk size — RESOLVED, committed, tested.** Real measurement (not guessed): fetched a real 92-min meeting recording (`9v79ybb18qjwprz`, R2 object `raw-upload.mp4`, pulled directly via boto3 using the container's own R2 credentials), ffmpeg-sliced a 13-min segment (matching the owner's "10-15 min" ask), ran it through Google's real Files-API transcription path with the app's exact production prompt/model (`gemini-3.5-flash` free). No truncation, no repetition, no dropped content — but one concrete factual divergence against the existing 3-min-chunked transcript of the SAME audio: a client deal size came back as **"300 dollar"** where the original says **"1000 dollar"**. Presented this finding to the owner with 3 options; he chose the safe middle: **`LONG_AUDIO_CHUNK_DURATION_SEC` 3min → 6min** (the historically-validated value, drift 5.7s/8.7s median / 11.7s/29.6s max, never showed the numeric-error failure mode) rather than pushing to 12-15min. Change is in `apps/web/workflows/transcribe.ts`, gated by the existing test suite (65 tests across the 3 affected files, unaffected by the exact constant since they use fixture-controlled boundaries) — `tsc -b --force` clean, no CRLF churn. **This one IS safe to commit on its own** — it's an isolated 2-constant change with its own passing tests, independent of the UI bundle below.

**2) Transcript-first + optional AI summary, download options, audio-toggle — BUILT, self-reviewed, blind-reviewed, NOT committed.** Root cause found before building: `app/api/videos/[videoId]/generate/route.ts:172` was the ONLY real caller passing `aiGenerationEnabled: true` to `transcribeVideo` — every OTHER piece of the machinery (the free-tier ladder, `shouldQueueAiGeneration`, `isAiStatusTerminal`'s poll-stop logic, `SharePanel`'s per-tab `tabReady` gating) already treated "transcript done, AI not requested" as a normal, correctly-handled state — it was NEVER exercised in practice because this one flag always forced the auto-chain. Fix is a single value change (`true` → `false`), NOT the deep pipeline rewrite it first looked like.

Built by one `doer` (Sonnet) agent, following a spec I wrote after this investigation:
- `generate/route.ts:172` — `aiGenerationEnabled: false`. Pressing "start" on a fresh video now runs transcript ONLY; the existing COMPLETE-branch `startAiGeneration` call becomes the explicit "step 2" trigger, reached by pressing the SAME button again once transcript is ready.
- `GenerateAiPanel.tsx` — the old single "not run yet" branch split into two: "transcript not ready" (new copy) vs "transcript ready, AI optional" (new copy + a "Xulosalash"/"Summarize" button, key `aiStartSummary`).
- New `app/api/videos/[videoId]/transcript/route.ts` — downloads the transcript as readable `[mm:ss] Speaker: text` plain text. Reads `transcription.vtt` from storage (the same canonical key `get-transcript.ts`/`transcript-index.ts`/`translate-ai.ts` all already read) — same signed-in-only auth pattern as the neighboring `audio/route.ts`, including its same-error-for-missing-and-forbidden discipline.
- `ShareHeader.tsx` — "Yuklab olish" is now a dropdown (Video / Audio / Transcript, Audio+Transcript still signed-in-only). The freed Audio-button slot now holds an audio-only-PLAYBACK toggle (not a download).
- `ShareVideo.tsx` — the toggle is threaded via a `?audioMode=1` URL param (ShareHeader and ShareVideo are server-rendered siblings, not sharing a client parent, so a plain prop couldn't reach across — same pattern already used here for `?t=` deep-link seeking), OR-combined into `data.metadata?.isAudio` at the 4 render-only call sites that pick video-chrome vs the existing calm audio-chrome (`AudioPlayer.tsx`).
- i18n: 9 new keys added to `uz.json`/`en.json`/`ru.json` (`share` namespace).

**Verification so far:** I independently re-read every changed file myself (not just the agent's self-report) — confirmed `transcription.vtt` is a real, pervasively-used key (not invented), confirmed the Effect-TS pattern in the new route matches `get-transcript.ts`'s own established style, confirmed all 4 `isAudio` call sites are render-only props into player-chrome components. `tsc -b --force` clean, `pnpm --filter @cap/web test` 179 files / 1528 tests passed (26 skipped), CRLF matched. A fresh blind non-author review (Fable, not the author) is running against the specific risk claims: branch-order equivalence in the GenerateAiPanel split, whether `isAudio` leaks into any behavioral (non-render) logic in child components, the new route's auth-discipline parity with `audio/route.ts`, and confirmation `use-ai-status.ts` was untouched.

**NOT yet done:** committing, deploying, or a live click-through — no login credentials exist on this machine, so the owner-gated buttons (Start transcript, Xulosalash, the 3 download items, the audio toggle) have never been clicked by anything but code-reading. **Next real step needs the owner**: once the blind review clears and this is committed/deployed, ask him to open a fresh video and confirm the two-stage flow (transcript appears without AI summary; a second press produces the summary) plus the new header buttons look and work as described.

### 2026-08-31 — DEPLOYED `a8c1bd0`: the paid OpenRouter leg moved to `google/gemini-3.7-flash`

**What broke, measured not guessed.** The owner restricted his OpenRouter key to 3.7 on the dashboard. Our code pinned `google/gemini-3-flash-preview`, so the production key answered **404** and every PAID transcription / summary / translation / chat call threw. Users saw **"AI analysis failed. AI generation error."** — reported on `y71wes3p9q32bg4` ("SHMS - Azizbek bilan suhbat", 121 min, transcription COMPLETE, `aiGenerationStatus = ERROR`). The free Google chain was untouched, which is why short videos looked fine and it went unnoticed for days. Before the fix, prod's last successful OpenRouter row was 2026-08-27 18:37.

**The fix is TWO lines, and the second is the one that mattered.** A model-only swap would have failed every call: 3.7 rejects our `reasoning: { max_tokens: 0 }` with **400 "Reasoning is mandatory for this endpoint and cannot be disabled"**. Measured alternatives on one prompt — `effort: "minimal"` → reasoning_tokens **0**, $0.00032; the field omitted → **457** reasoning tokens, $0.0021, and a 200-token cap truncated the JSON mid-string. So: `OPENROUTER_MODEL = "google/gemini-3.7-flash"` + `reasoning: { effort: "minimal" }`. Comments asserting the now-dead reasoning-off parity were rewritten, not left to lie.

**Evidence gathered before the tag switch** (production key, production request shape):
- `google/gemini-3.7-flash` on OpenRouter: same input modalities incl. **audio**, same 1,048,576 context, same 65,536 max completion, $0.375/$1.875 per 1M vs $0.50/$3.00.
- **Real Uzbek audio probe** (45 s voice note, the app's exact `TRANSCRIPTION_INSTRUCTION_PREFIX`, temperature 0.1, effort minimal): HTTP 200, `finish_reason: stop`, **reasoning_tokens 0**, 698 audio-in tokens, $0.00248 → correct **WEBVTT in Uzbek Latin** with real timestamps and no invented speaker labels on a single-speaker note.
- Structured-output leg: valid JSON, good Uzbek, `finish_reason: stop`.
- Pricing-table risk **falsified**: `packages/utils/src/ai-pricing.ts` uses `PRICES[model] ?? DEFAULT_PRICE`, and DEFAULT_PRICE is 2.5-flash's *higher* rates, deliberately so an unknown model never under-prices. No $0 rows, spend backstops stay armed. (The `openrouter/`-prefixed key was already absent before this change — pre-existing, not a regression.)
- Gates by the main session: `tsc -b --force` exit 0 · **179 files / 1527 tests passed**, 26 skipped, exit 0 · no CRLF churn (14 == 14).
- **Blind non-author review (Fable): GO with conditions.** It caught three things the author missed — the pricing-table question, that the summary A/B does not cover *transcription* parity, and that paid and free legs now run DIFFERENT models so one long video can mix free-Google and paid-3.7 chunks with possible style drift. That last one is accepted and un-mitigated; surface it if transcripts start reading inconsistently.

**Deploy:** `cp docker-compose.app.yml docker-compose.app.yml.bak-a8c1bd0`, one `image:` line → `data365-web:a8c1bd0`, `docker compose -f docker-compose.app.yml up -d`. Live after: container `Up` on `a8c1bd0` · `/api/health` `db:ok storage:ok` · `/login` 200 · `/s/zp46nk5t66cdqfv` 200 · `POST /api/video/ai/chat` → **HTTP 200, 9 token frames, 0 error frames**, a real Uzbek answer with timestamp citations.
**Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-a8c1bd0 docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` → back to `f70063c`, still on the host.

**✅ PROVEN IN PRODUCTION 2026-09-01 13:04 (server time), by the owner pressing "Retry" on `y71wes3p9q32bg4`.** That 121-minute video now reads `aiGenerationStatus: COMPLETE`, step `done`, a **47,204-char** summary and 651 chars of chapters. `ai_usage_events` shows the designed ladder actually walked: free `gemini-3.5-flash` and `gemini-3-flash-preview` rows at $0 first, then **10 paid rows on `openrouter/google/gemini-3.7-flash`**, each with a real non-zero charge (695–5,410 microdollars, ≈ **$0.042** for the whole video). The paid OpenRouter leg is therefore verified end-to-end through our own code, not merely against the vendor API.

**Quality signals, computed rather than judged.** New summary (3.7) vs the stored old-model summary of `zp46nk5t66cdqfv`: **0 Cyrillic characters in both** (Uzbek Latin held), **0 question marks in both** measured server-side, apostrophe density 812 vs 806 — i.e. no mojibake and no script drift. A `?????` seen while dumping the text was a terminal transport artifact, NOT in the data; `qmark_count = 0` in the DB proves it. Structured output is intact: valid JSON with `tasks[]` carrying title/assignee/category/priority in clean Uzbek.
**What this still is NOT:** a controlled A/B. The two summaries are of DIFFERENT videos, and a same-video comparison against the old model is impossible now (the owner's key rejects `google/gemini-3-flash-preview`). The only controlled test left is regenerating `zp46nk5t66cdqfv` on 3.7 and diffing against `scratchpad\ab-3.7\BEFORE-old-model-summary.txt` (53,201 bytes, saved) — one owner tap, and it overwrites that video's stored summary, which the backup makes reversible.

**A/B baseline saved for the quality comparison he asked for:** the old-model summary of `zp46nk5t66cdqfv` (110 min, 53,201 bytes) is at `scratchpad\ab-3.7\BEFORE-old-model-summary.txt`. A true side-by-side on the SAME model pair is now impossible — his key rejects the old id — so the comparison is stored-old vs regenerated-new, and regenerating that video overwrites its summary (the backup makes that reversible).

### 2026-08-22 — code package for an outside developer (NO product code changed)
Owner's order: zip the whole repo for a cheap outside developer/agent, no secrets, required env vars obvious. Delivered to his Telegram:
- **`data365-meetapp-CLEAN-2026-08-22.zip`** (40 MB, 1844 entries) — `git archive HEAD` of `7e3d560`, minus `docs/`, `autoresearch/` and the internal root `*.md` files, plus **`ENV_REQUIRED.md`** (7 required vars, ~35 optional, each cited to `packages/env/server.ts`) and **`START_HERE.md`** (stack, repo map, 9-step local run, gate commands). This is the one to hand out.
- **`data365-meetapp-FULL-2026-08-22.zip`** (43 MB) — same code WITH the internal docs. Owner-only, do not hand out.
**Two defects caught by verifying instead of trusting the agent's report:** (a) the credential scan was clean (0 real keys) yet `docs/` carried the prod IP, `hetzner_ustoz` and `ssh -i` in **32 places across 9 files** — infrastructure is a separate sweep from credentials, and the sweep must cover the whole package, not a hand-picked file list; (b) PowerShell `Compress-Archive` writes **backslash** path separators, which is against the ZIP spec and turns the tree into a flat pile of oddly-named files on macOS/Linux — both archives rebuilt with `tar.exe -a -c -f` (bsdtar) and verified at 0 backslash entries. Lesson stored as `feedback_share_package_leaks_infra`.
**Two facts worth keeping for the product:** `WEB_URL` and `INVITE_TOKEN_SECRET` are REQUIRED to boot (`packages/env/server.ts`) but are **missing from `.env.example`** — anyone setting up from the template fails at boot. `ELEVENLABS_API_KEY` (schema) vs `ELEVEN_API_KEY` (a code grep hit) is an unresolved name mismatch. Neither is fixed; both are one-line fixes when someone touches `.env.example` next.
Branch `qa-fixes` untouched at `7e3d560`; this board was compressed 38.8 KB -> 21.7 KB the same day, the removed stretch moved verbatim into `STATE_ARCHIVE.md`.

### Deploy state (unchanged since 2026-08-19)

**Live image `data365-web:f70063c`, deployed 2026-08-18 ~23:55, and M1 PASSED against the real site — not against a test.** Same request, same video, before vs after the switch: `POST https://data365.duckdns.org/api/video/ai/chat` on `2e466nedt9f8kgp` returned exactly one `{"error":"Gemini batchEmbedContents failed: 429 … RESOURCE_EXHAUSTED"}` frame and zero tokens before; after, **20 `{"token":…}` frames, 0 error frames, 1785 bytes** of a real Uzbek answer. `/api/health` `db:ok storage:ok` · share page `/s/2e466nedt9f8kgp` 200 · `/login` 200 · container `Up`. (`/api/video/ai` answering 401 to an anonymous caller is pre-existing auth gating, not a regression.)

**What shipped in it:** upload percentage + speed + time-remaining · server-stage progress during optimize/save (carrier is `videos.metadata`, NOT `video_uploads` — wave 1 deletes that row as its first workflow step) · the AI-chat 429 fix (32-per-request paced embeddings, halving to a floor of 4, honouring the 429's own `retryDelay`) · a poll that stops on a dead AI job. Commits on `origin/qa-fixes`: `35f8001` → `5217819` → `4e4a9ed` → `f70063c`. Gates on `f70063c`, run by the main session: `pnpm tsc -b --force` exit 0 · `pnpm test:web` **179 files / 1527 tests passed**, 26 skipped, exit 0 · no CRLF churn (80 == 80).

**Rollback, seconds:** `cd /opt/data365 && cp docker-compose.app.yml.bak-f70063c docker-compose.app.yml && docker compose -f docker-compose.app.yml up -d` → back to `f917459`, which is still on the host.

**Wave 1 is WORKING, measured 2026-08-18 ~18:30:** a phone upload logged `[process-video] Optimized video for q15gmkfa9dvhexh: 116783866 bytes, duration=5304.55` — the optimize step SUCCEEDING, which had never once happened in that container (prior record: 0 successes, 3 failures after the 55-minute timeout). Honest caveat: 111 MB phone video, not like-for-like against the 2h03m baseline. Strong evidence, not the metric. Do not tell a fresh session wave 1 is unmeasured.

### NEXT — this needs the owner, not the machine
**M2 is the one unmeasured number and it cannot be driven from this laptop** (next-auth uses JWT sessions; there is no login credential here): on ONE real ≥300 MB upload, every 5 s sample shows a number and no two changes are >30 s apart. The SAME upload also settles wave 1's own number (`multipart/complete` → `processingStartedAt`, target <3 min against a 2h03m baseline). **Ask for ONE upload, get BOTH.** Tell him to hard-refresh first — a page left open across a deploy fires dead Server Actions.

### Open / carried
- **Accepted residual, non-blocking (in code):** a workflow killed between transcribe's COMPLETE write and generate-ai's QUEUED write leaves that ONE open tab polling every 4 s. No recovery path exists (`recover-stale-ai-jobs` keys on a marker the redeemer already consumed) and bounding it needs a COMPLETE-anchored timestamp that does not exist today. Round four proved every alternative worse — a press-anchored staleness bound re-created the freeze for long videos.
- **Non-blocking, pre-existing:** `workflows/process-video.ts:151-154` — the heartbeat wraps only the `saving` putObject; during `optimizing` the only writer is ffmpeg's `onProgress`, so a >5-min callback silence stales the stage and the overlay vanishes while the encode is alive. Comment corrected; ffmpeg path deliberately untouched (owner: percentage is enough).
- **Open question, do NOT build yet:** browser-side shrink before upload. `@remotion/webcodecs` is already a dependency and already converts recordings in production (`web-recorder-dialog/recording-conversion.ts:111`). He says big files are frequent — but re-encoding a 2-hour video on his low-end laptop may cost more time than the upload it saves. Answer the throughput question first.
- **Carried, NOT confirmed:** the four cards he approved 2026-08-16 (`z92046jw04`, `z92046jvh3`, `z92046jvh4`, `z92046jw05` — upload-into-folder, multi-file move, folder-into-folder, 1-click upload) appear to have been built in the 08-17 range, but that was never confirmed card-by-card on ClickUp. Verify before telling him anything shipped.
- **Known flake, recorded not fixed:** `upload-cap-button-fast-path.test.ts` failed once in four full-suite runs, passes 5/5 in isolation. Cosmetic and out of scope: the optimize percentage restarts near 0 when a copy times out and the compress fallback begins.

### The lesson this stretch paid for — five blind non-author review rounds, four found a real defect
**A fix is new code; it gets its own review.** Twice a round's fix introduced the exact defect the next round caught — including the mirror case where fixing "the share page polls forever" produced "the poll stops mid-transcription". Never treat *the reviewer's findings are fixed* as *the reviewer approved it*.
**CRLF:** three agents flipped LF files to CRLF, inflating one diff from 1394 real lines to 3087. Always compare `git diff --shortstat` against `git diff --ignore-cr-at-eol --shortstat` before committing here.

---
## ⭐ OWNER DECISIONS — infra & data (2026-07-18, SESSION i) — BINDING

1. **Domain: STAY on the free `*.duckdns.org` for now.** Owner explicitly declined buying a domain at this stage. Consequence to remember: no mail provider can be verified on it (so transactional email stays unavailable — fine, the access model needs none), and it must be revisited before any wider/commercial launch. Do NOT re-raise this before then.
2. **Account deletion = REAL deletion, with a hard confirmation gate.** Owner rejected soft-delete/grace-period. Data is actually erased; the safety net is friction, not retention: require the user to TYPE an exact confirmation phrase (e.g. "delete my all data") before anything is destroyed — so nobody wipes their account by misclicking. This answers audit finding H13: the erasure workflow must inventory and purge recordings, storage objects, transcripts, AI data, comments, analytics and API keys — not just the user row (`apps/web/actions/account/delete-account.ts:32-39` currently deletes only membership/session/OAuth/user).
3. **Firewall: owner asked for an independent check first** (Codex or Fable) rather than acting on Claude's word alone — correct instinct, since a wrong rule locks everyone out of the VPS.

## 🔁 STANDING REQUIREMENT — SERVER PORTABILITY (owner, 2026-07-18)

The Railway → Contabo/Coolify migration was painful. Owner's directive: **build so that changing servers is never that painful again.** Treat host-portability as a real requirement, not a nice-to-have — no hidden coupling to one provider, everything needed to stand the app up elsewhere must be written down and reproducible. Judge future infra choices against "how hard is it to move off this?"

## 🚦 AGREED ROAD TO PRODUCTION (owner, 2026-07-18) — follow this order, do not skip a step

1. **Claude finishes the code fixes** (audit findings C1–C4, H1–H16, M1–M12 as scoped).
2. **Fable AND Codex each re-audit production-readiness independently** — separately, neither seeing the other's report, same as the SESSION-h heart audit that both returned "STILL BROKEN" and was trusted precisely because they converged.
3. **Only after both sign off** → Claude writes a step-by-step OWNER QA SCRIPT: one instruction at a time, each saying where to click, what should happen, and what "wrong" looks like. Owner is a non-programmer — no jargon, no batched steps.
4. **Owner executes the human-only half**: real Google Meet capture on a laptop, real device playback, phone checks. Claude does everything a machine can do; the owner does only what genuinely needs hands and a real device.
5. Deploy only after that.

Owner's framing: *"qila oladiganingni sen qilasan"* — do not hand the owner a task a tool could have done. Manufactured busywork trains him to ignore the list.

## ⭐ OWNER PRODUCT DECISIONS (2026-07-18, SESSION i) — BINDING, do NOT re-litigate

Pinned during the Codex production-readiness review. These define the access/billing model:

1. **THREE KINDS OF PERSON (owner confirmed "ha shunday", 2026-07-18).** This is the access model — build everything against it:
   - **Guest** — no account. Arrives via a share link. Can WATCH + use AI CHAT (daily-capped). Nothing else.
   - **Requester** — signed up on their own. Has an account but **NO organization membership at all**. Sees a friendly "we'll contact you to open your workspace" screen, NOT a dead end — a curious customer signing up is a **sales lead**, so the owner gets a list of pending requests in the dashboard (who, when, which email) with approve/dismiss.
   - **Member** — the owner explicitly added them to the company org. Full product.
   **Free users never record.** They only watch + chat. So a self-signup needs NO workspace of its own — the earlier "give each signup their own org" plan is CANCELLED (owner: storage is only 10 GB free; signup exists mainly so the owner can add members).
   **Signup stays OPEN and needs NO email verification** — safe precisely because a stranger who signs up sees nothing and stores nothing. The C2 defect is that `apps/web/actions/auth/signup.ts:135` calls `getDefaultOrganizationId()` and inserts `organizationMembers role:"member"` → today every internet stranger becomes a member of the owner's team org. Fix = create the user with NO org membership.
   Telegram notification on a new request: raised, **not confirmed by the owner** — do not build it until asked.
2. **AI spend is privileged.** Only **admin/owner** can trigger paid AI *analysis* (transcript, summary, generation). A free user cannot spend AI money.
3. **AI chat is available to free users AND to anonymous visitors arriving via a share link** — but **rate-limited (owner chose option B)**: a per-video / per-client daily cap so guest chat cannot drain the Gemini budget. Not unlimited (C rejected), not admin-only (A rejected). Rationale: guests seeing the product is a growth channel, the cap keeps the bill bounded.
   **ALREADY BUILT** — `apps/web/lib/ai-chat-limit.ts` `DAILY_CHAT_LIMIT = 20`, DB-backed (`ai_chat_usage` table, unique on videoId+clientId+dateUtc, migration `0036`), so it survives restarts. Keyed by userId when signed in, else a cookie, else `guest_ip:<ip>`. Kept at **20** (status quo, live-verified); owner never asked to lower it to 10 — do not change the number without asking.
   ⚠️ **KNOWN BYPASS, not yet fixed:** the IP is read as `x-forwarded-for.split(",")[0]` — the LEFTMOST hop, which a caller can spoof. Repo-wide convention (`password.ts`, `helpers.ts`, `api/utils.ts` do the same). Fixing it means taking the proxy-appended hop instead, but **Coolify's proxy behaviour is unverified and is NOT in this repo** — must be tested live against data365.duckdns.org before changing. Do not guess.

5. **AI spend gate — a hole was found and closed this session.** `apps/web/app/api/videos/[videoId]/retry-ai/route.ts` had NO `canUseAI` check: any signed-in video owner could POST to it and trigger paid Gemini generation. It has zero callers in the web UI (orphaned duplicate of `generate` with `reprocess:true`) but was a live reachable route. Now gated with the same `canUseAI` + `AI_ACCESS_DENIED_CODE` as generate/continue-paid/translate. Note `canUseAI` = global `users.isAdmin` ONLY; org-level "owner" role grants no AI spend (verified: all 14 `role === "owner"` sites are org-scoped and cannot escalate to platform admin).
4. Domain purchase is still open; email sending is NOT configured (`.env` has no mail provider) and decision 1 means it is not on the critical path.

## ⚠️ Don't re-chase (proven false alarms / parked)
- **Video "stuck" in MY heavy-probing browser = self-poisoning** (connection-pool exhaustion), NOT a delivery bug. Test ONE clean tab. `fetch` of result.mp4 → 206; it plays for real users. [[feedback_clean_env_before_live_bug]]
- **Embed #310** was a stale build — resolved.
- **CDN Worker** (`ustoz-media-cdn.data365.workers.dev`) is LIVE but DEACTIVATED; app falls back to R2 presigned (working, 5/5 206). Re-activation needs the in-browser-only hang diagnosed first — recipe in the archive + `docs/DEPLOY_SECRETS.md`.


---
# ===== LIVE ENVIRONMENT (verified 2026-07-20 — trust RUNBOOK.md over this) =====

⚠️ **This block was WRONG until 2026-07-20** — it still named Railway URLs and a Railway MySQL long after the Contabo/Coolify migration. A new session reading it would have probed a dead host. Corrected against `docs/RUNBOOK.md` (itself re-verified 2026-07-17/18). **If these disagree, RUNBOOK wins.**

- **Live site:** https://data365.duckdns.org — liveness = `/api/health` returns `"status":"ok"` with `db:"ok"`, `storage:"ok"`.
- **Server:** Contabo VPS, `data365.duckdns.org` → **169.58.86.149** (the old `169.58.12.255` is dead). SSH `-i ~/.ssh/hetzner_ustoz root@169.58.86.149`. **Coolify is no longer the deploy path** — the live shape is `/opt/data365/src-<sha>.tar` → `docker build` on the host → switch the image tag in `/opt/data365/docker-compose.app.yml` (written up in `docs/plans/2026-08-18-wave1-SPEC.md`; `docs/RUNBOOK.md` predates it).
- **DB:** MySQL in the `data365-db` container. Not reachable directly from the dev machine, but READABLE over SSH (used 2026-08-18): `docker exec data365-db sh -c "mysql -uroot -p\$MYSQL_ROOT_PASSWORD capdb -e '<sql>'"`. **User `mysql` is rejected — it must be `root`.** String literals fight three layers of quoting; comparing on a `0x<hex>` id avoids it. Authed-page QA still cannot run locally.
- **Storage:** Cloudflare R2. **Backups:** R2 `db-backups/`, the authoritative series is `capdb-*.sql.gz` written by the VPS cron `/root/backup-db.sh` (source in `deploy/server/`). The GitHub `db-backup.yml` series (`data365-*.sql.gz`) points at the deleted Railway DB — ignore it.
- **Repo:** GitHub `mirkomilovabrorwork-dot/ustoz-github`. Work branch **`qa-fixes`**; scheduled jobs only run from **`main`** (GitHub only schedules from the default branch).
- **Deployed:** container `data365-web` running image **`data365-web:f917459`** since 2026-08-18 12:17 CEST (wave 1). Rollback = one tag change; `/opt/data365/docker-compose.app.yml.bak-f917459` holds the previous file. `NEXT_PUBLIC_USD_TO_UZS=12000` is a BUILD-TIME var baked into the image.
- **`ELEVENLABS_API_KEY` is NOT set on prod** (verified by `printenv`) — the "Timestampni aniqlashtirish" button therefore cannot work.
- **GATE = ROOT `pnpm typecheck` + BOM-check changed files** (the `-F @cap/web` typecheck is a no-op false-green).
- **Node not on PATH:** `$env:Path = "C:\Program Files\nodejs;" + $env:Path`. Windows has no `zip` CLI → `Compress-Archive`.
- **Deploy rule:** do NOT push / deploy / force-checkout without explicit owner approval.
- **NEVER commit** (temp, untracked): `apps/web/scripts/_qa-import.ts`, `import-real-video.ts`.

## 🙋 OWNER-PHYSICAL (only he can do)
1. **Extension v0.5.0 install + 2-person Meet run** — the full script is in the "NEXT SESSION" block above and in `docs/OWNER_QA_SCRIPT.md`. This is the open one.
2. **Top up Gemini billing** at https://ai.studio/projects — every AI feature on prod is down until this happens (he said credit is being bought 2026-07-21).
3. **Add GitHub repo secret `CRON_SECRET`** (value in `docs/DEPLOY_SECRETS.md`) → Settings → Secrets → Actions. Until then the recover cron skips safely.
4. Chrome Web Store publish (later; $5 dev account).
5. Optional, only if he picks the paid timing path: supply an **ElevenLabs API key** → set in Coolify → redeploy.

---
# ===== HISTORY =====

Everything before 2026-07-20 — 30+ session handoffs, the Codex QA runs, the Fable heart audits, the per-commit fix logs — lives in **`docs/STATE_ARCHIVE_2026-07-20.md`** (the full 416 KB file, verbatim, nothing deleted). Older still: `STATE_ARCHIVE.md`, `STATE_ARCHIVE_2026-06-23.md`.

Why it was moved (2026-07-20): STATE.md had grown to **416 KB / 1895 lines** — too large for a session to read, so the resume guarantee it exists to serve was already broken in practice, and a stale env block at the bottom was actively feeding new sessions false facts. Rule for keeping it that way: **STATE.md holds the live point + binding decisions only.** When a session's handoff is superseded, move it to the archive in the same commit — do not stack it here.

---
## ⚠️ GATE HYGIENE — read before quoting "typecheck 0" as evidence (found 2026-08-04)

`pnpm typecheck` runs `tsc -b`, which is INCREMENTAL. With warm `*.tsbuildinfo` files it reports every package "up to date", finishes in **~6.7s** and exits 0 **having type-checked nothing**. Goalkeeper's spec-review measured this; I had quoted that exit code as evidence four times the same night.

**Use `pnpm exec tsc -b --force` whenever the result is being used as PROOF** (before a commit claim, before a deploy, in any report to the owner). Measured 2026-08-04: forced run = **84s, exit 0, no errors** — so the tree really is clean, but the fast green had not shown that.

Record the DURATION next to the result. A gate that suddenly runs far faster than the work it claims to do has stopped doing it, and a time is falsifiable where "exit 0" is not.

Same class, runtime half: `apps/web/.next/standalone/apps/web/lib/audio-extract.ts` still holds the OLD `-pipe:1`. Harmless because the Docker build recompiles from source (proven: the deployed image is new AND the served `/theme-script.js` contains the fix), but never treat a local `.next` output as evidence of what production runs.

---
## DECISIONS (owner one-tap answers - auto-appended; a decided question is never re-asked)
- 2026-08-11 [Sekin rejim] "Sekin" rejim pul sarflashi mumkinmi? -> **imkon qadar bepuldan foydalanadi u tugasa qaytguncha pullikdan foydalanadi**
- 2026-08-11 [Yo'nalish] Bu qismni qanday yakunlaymiz? -> **o╩╗ylab qaror qil, sifatli bo╩╗lsin eng muhimi**
- 2026-08-11 [Qayerda] "Oldi-berdi" tahlili qayerda ko'rinsin? -> **Ikkalasida ham**
- 2026-08-11 [Aralash valyuta] Qarzni bir valyutada berib, boshqasida qaytarsangiz ΓÇö tizim nima qilsin? -> **Alohida ko'rsatsin (tavsiya)**
- 2026-08-11 [Valyutalar] Qaysi valyutalar kerak? -> **so'm (UZS) dollar (USD) rubl (RUB) yuqoridagi 3ta asosiy lekin quyida boshqa davlat valyutalari tanlash imkoni ham bor m...**
- 2026-08-11 [Hisobot] Umumiy hisobotda jami summa qanday ko'rinsin? -> **Har valyuta alohida qator**
- 2026-08-12 [Tahlil tiklash] Osilib qolgan tahlilni avtomatik tiklash yoqilsinmi? -> **Ha, yoqing**
- 2026-08-12 [Savat] Savatni avtomatik bo'shatish yoqilsinmi? -> **Ha, yoqing (tavsiya)**
- 2026-08-13 [Yo'l] AI tahlil ishlashi uchun qaysi yo'lni tanlaymiz? -> **openrouter gemini kalitiku baribir bu**
- 2026-08-13 [Qaror] Shuni bilgan holda, nima qilay? -> **VTT ni ham openrouter bilan qilish imkoni bordir**
- 2026-08-18 [Tuzatish] Tuzatishni hozir boshlaymizmi? (NIMA: serverga ┬½qutqaruvchi┬╗ qo'shamiz ΓÇö har 5 daqiqada tekshiradi, fayl yuklangan-u tahlil boshlanmagan bo'lsa, o'zi boshla... -> **Xafa qilib tuzat, muammo bo'lmasin boshqa. Telefonda ham, kompyuterda ham.**
- 2026-08-18 [Eski 4 ta] Muzlab qolgan 4 ta eski videoni (18/30-iyul) nima qilay? (NIMA: ular hech qachon tahlil qilinmagan, ro'yxatda ┬½processing┬╗ bo'lib turibdi. NEGA: qoldirsak, ch... -> **O'chirib tashla**
- 2026-08-18 [Tuzatish] Buni qanday tuzatay? (Nima: yuklash va ishlov paytida aniq foiz ko'rsatish. Nega: hozir foydalanuvchi qotib qolgan deb o'ylab, xuddi shu faylni qayta yuklaydi Γ... -> **Ikkalasini to'liq (tavsiya)**
- 2026-08-18 [Fayl hajmi] Shunday katta fayllarni tez-tez yuklaysizmi? (Nima: bugungi fayl 1.22 GB edi. Nega muhim: agar bu odatiy bo'lsa, yuklashdan OLDIN faylni brauzerda kichraytirish... -> **Ha, tez-tez katta bo'ladi**
- 2026-08-18 [Bo'sh yozuv] O'sha bo'sh qolgan yozuvni o'chiraymi? (Nima: 12:24 dagi ikkinchi urinish ΓÇö ichida video yo'q, faqat bo'sh karta. Nega: dashboardda buzuq karta bo'lib turadi ... -> **Ha, o'chir**
- 2026-08-18 [Video kerakmi] Yuklagan yig'ilishlaringizni keyin KO'RASIZmi, yoki faqat tahlil (matn, xulosa, AI savol-javob) kerakmi? (Nima: bu ovozgina yuborish tugmasini qo'shish-qo'shmas... -> **video kerak kerak bo'lmasa audio qilinadi keyin**
- 2026-08-18 [Deploy] Mustaqil tekshiruv toza chiqsa, bugungi tuzatishni serverga chiqaraveraymi? (Nima: hozir tayyor kod kompyuterimda turibdi, serverda emas. Nega: chiqarmasak siz ... -> **Ha, tekshiruv toza bo'lsa chiqar**
- 2026-08-18 [Chat tuzatish] AI chatni qanday tuzatay? (Nima: chat javob berishdan oldin videoning matnini bir yo'la juda katta bo'lak qilib Google'ga yuboryapti va bepul limitga urilyapti.... -> **Menda pullik kalit bor, olib ulan**
- 2026-08-22 [Xavfsizlik] Zip ichida ichki hujjatlar bor: 9 ta faylda 32 joyda serveringiz IP manzili (169.58.86.149), SSH ulanish buyrug'i va ichki hisobotlar yozilgan. NEGA muhim: kodn... -> **Tozalangan zip tayyorla (tavsiya)**
- 2026-08-22 [Ishga tushirish] Loyihaning eng yuqori papkasida README yo'q ΓÇö qabul qiluvchi kodni ochsa, 'buni qanday ishga tushiraman' degan savolda qoladi. NEGA muhim: birinchi kunini yo'... -> **Ha, qo'sh (tavsiya)**
- 2026-09-06 [Push] GitHub'ga push qilaymi? NIMA: kompyuteringizdagi kod 19-avgustdan beri GitHub'ga yuborilmagan ΓÇö 10 ta commit faqat shu noutbukda. NEGA: noutbuk buzilsa yoki o... -> **Ha, push qil (tavsiya)**
- 2026-09-10 [Navbat] Bugun jiddiy nosozlik topdim: yuklangan audio fayllarning ~15% i jimgina ishlanmay qolyapti (bugun 12 tadan 2 tasi; 09-05 dagi "Platforma_taqdimoti" ham shu ΓÇö... -> **Ikkalasi parallel**
- 2026-09-10 [2 ta yozuv] Bugun ishlanmay qolgan 2 ta yozuv serverda turgan (124 MB va 166 MB). Ularni hozir majburan ishga tushirsam, transcript chiqadi, lekin ~12 000 so'm pullik AI ke... -> **Yo'q, tegmang**
- 2026-09-10 [Tanlov joyi] "Only transcript" va "Full AI analysis" tanlovi qayerda chiqsin? -> **Video sahifasida (tavsiya)**
- 2026-09-10 [Fayl turi] Refined (tozalangan) matnni yuklab olish qaysi fayl turida bo'lsin? -> **Ikkalasi ham**
- 2026-09-10 [Navbat] Bir vaqtda ko'p fayl yuklanganda AI tahlil qanday ishlasin? -> **kop fayl yuklangani bilan ai tahlil alohida qilinadiku bitta bitta**
- 2026-09-10 [Tanlov] Ko'p fayl yuklaganda "Only transcript / Full AI" tanlovi qanday bo'lsin? -> **[No preference]**
- 2026-09-10 [Chegara] Bir marta nechta fayl yuklashga ruxsat bo'lsin? -> **20 ta gacha (tavsiya)**
- 2026-09-25 [Himoya] Kelajakda yuklangan yozuv jim yo'qolib qolmasligi uchun tizim har bir fayl oxirigacha ishlanganini belgilab qo'yadigan qilaymi? AI puli ketmaydi. -> **Ha, qil (Tavsiya)**
- 2026-09-25 [4 audio] Matni yarmida uzilib qolgan 4 ta uzun audioni qayta ishlash taxminan $5 turadi, hisobda esa $4.99 bor. Nima qilamiz? -> **Agar hammasi 1ta audio bo╩╗lsa 1tasini qil va qolganini o╩╗chir, agar bir xil bo╩╗lmasa shunchaki tuzat keyin o╩╗zimiz k...**
- 2026-09-25 [GLM] Sozlamalarda arzon modellar GLM nomiga bog'langan, shu sababli yordamchi agentlar xato berib to'xtayapti. Bu bog'lamani olib tashlaymi? -> **Olib tashla (Tavsiya)**
- 2026-09-25 [Rejim] Ultra-tezkor rejim 14 kundan beri yoqilgan. Hali kerakmi? -> **Normal rejim**
- 2026-09-25 [AI chegara] data365 da oylik AI chegarasi $11.63 qilib qo'yilgan, bu oy esa $11.66 ishlatilgan. Shuning uchun hozir hech bir yangi yozuv matnga o'girilmaydi va 4 ta audioni... -> **100$ga ko╩╗tar**
- 2026-09-25 [Balans] Admin uchun bosh sahifaning tepasida "AI hisobi: $2.52 qoldi" ko'rinib tursinmi? $1 dan tushsa, u qizil ogohlantirishga aylanadi. -> **Yo'q**
- 2026-09-25 [Ko'rinish] Men shunday tushundim: yozuv sahifasida har doim sabab va keyingi qadam yoziladi. Masalan: "AI hisobida pul tugadi ΓÇö to'ldirilgach o'zi davom etadi", "Oylik A... -> **Ha, shunday**
- 2026-09-25 [/clear tayyormi] Holat: meniki hammasi commit+push+qayd etilgan, /clear uchun xavfsiz. Yolg'iz to'siq ΓÇö boshqa sessiyaning tugallanmagan upload-ishining 9 ta fayli (yozilmagan... -> **boshqa appda claude muammoni aniqladi muammo limitda ekan 10$da ekan, shuni 100$ga ko'tar degandim opusga tekshir va dep...**
- 2026-09-26 [Audio limiti] Bitta audio uchun pul limiti qancha bo'lsin? (Hozir $20, 3 soatlik audio ~$1 turadi) -> **gap puldamas gap tizim wastega yo'l qo'ymasin yani to'xtab qolgan joyidan davom etsin lekin to'liq qayta qilish yo'q**

