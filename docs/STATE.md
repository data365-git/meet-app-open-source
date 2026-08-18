# Ustoz (data365) — STATE

_Trigger words: "ustoz", "cap", "cap-v2", "data365". Source of truth for resume._
<!-- KEEP THIS LINE IN THE TOP 10 LINES. The state-pointer hook reads the quoted
     phrases from the first 10 lines of this file to route the owner's word
     "ustoz" to THIS project. A top-block rewrite on 2026-08-04 dropped it and
     the routing silently broke — restore it in every future rewrite. -->

## GOAL — what "done" looks like
data365 runs on the team's own Contabo server (`https://data365.duckdns.org`) and is **boringly reliable**: uploads finish, AI analysis simply works, the system restarts what stalls, and the owner stops hearing complaints from the team. He is a non-programmer — every screen must say what is happening in a number he can act on.

## ▶ RESUME HERE — 2026-08-18 ~17:40

**LIVE COMPLAINT BEING FIXED:** *"upload bo'layotganda foiz ko'rsatmayapti — yuklanyaptimi yo qotib qoldimi bilib bo'lmayapti."* He chose the FULL fix (both layers). Design + metric: **`docs/plans/2026-08-18-upload-progress-SCOPE.md`**.

**PROVED IN THE PRODUCTION DB TODAY — this is not a UI nicety.** At 12:14:45 he uploaded a **1.22 GB** file; by 12:23:30 it had moved **64 MB** (~128 KB/s ≈ 1 Mbit/s → a true finish ~2h40m away). He deleted it at 12:24:12 and re-uploaded **the same file 5 seconds later**; that second attempt sent **zero bytes** and sat stranded for two hours (soft-deleted on his instruction 2026-08-18, recoverable 7 days). The upload was never frozen — it was genuinely going to take three hours, and nothing on screen could say so. **Consequence: a percentage alone is not enough; speed + time-remaining is the number that lets him decide.**

**UNCOMMITTED IN THE TREE (branch `qa-fixes`, nothing pushed, nothing deployed):**
- **Change A — upload percentage.** `UploadPlaceholderCard.tsx` prints `Uploading 47%` and gives the no-progress phases an indeterminate spinner instead of a ring frozen at 0. Test `__tests__/unit/upload-placeholder-percent.test.ts`, 5 assertions, 2 mutation-checked.
- **Change B — server-stage progress.** ffmpeg's `time=` parsed off the already-piped stderr → throttled `JSON_SET` of `metadata.processingStage|processingPercent|processingUpdatedAt` → `/api/video/ai` → `CapCard` + `ShareVideo`. 8 files + 2 test files, all mutation-checked. **Carrier is `videos.metadata`, NOT `video_uploads` — wave 1 deletes that row as its first workflow step, which is also why the card showed nothing at all during remux.**
- **Change A2 — speed + time remaining (in flight).** Rolling-window speed, `520 MB / 1.22 GB · ~2 soat 10 daqiqa qoldi`.
- **Gate, verified by the main session, not taken on an agent's word:** `pnpm tsc -b --force` clean; `pnpm test:web` **175 files / 1482 tests passed**, 26 skipped.

**✅ WAVE 1 IS WORKING — measured 2026-08-18 ~18:30, without needing the owner.** A phone upload landed at 13:03:49 (after the 12:17 deploy) and the container logged `[process-video] Optimized video for q15gmkfa9dvhexh: 116783866 bytes, duration=5304.55` — **the optimize step SUCCEEDING, which had never once happened before** (prior record in this container: 0 successes, 3 failures, each after the 55-minute timeout). An 88-minute video was done ~51s after its row was created (`videos.updatedAt` 13:04:40). **Honest caveat: not a like-for-like comparison** — the file is small (111 MB, ~176 kbps phone video) and the 2h03m baseline came from a larger case; `videoUploads` is deleted by then so the exact `multipart/complete → processingStartedAt` pair is gone. Treat as strong evidence, not the metric. Do NOT keep telling a fresh session wave 1 is unmeasured.

**🔴 SEPARATE LIVE DEFECT, owner-reported 2026-08-18 ~18:00: AI CHAT DIES ON ANY VIDEO WHOSE INDEX IS NOT BUILT.** Full evidence + metric: **`docs/plans/2026-08-18-ai-chat-429-SCOPE.md`**. Reproduced anonymously against prod: `2e466nedt9f8kgp` returns one SSE frame, `Gemini batchEmbedContents failed: 429 RESOURCE_EXHAUSTED`; `dmz6gk93rjnb9kn` (index already built) answers correctly. **Three facts that kill the obvious fixes:** `GEMINI_API_KEY === GEMINI_API_KEY_FREE` is literally TRUE in the container (there is no paid key, only the same free key in both slots) · no user row carries a personal `geminiApiKey` · OpenRouter serves 413 models and **0 embedding models**, and its `/v1/embeddings` 404s, so embeddings cannot leave Google — while OpenRouter is ALREADY wired into the chat's answer-writing half (`chat/route.ts:467-472`). It is a per-MINUTE limit, not an exhausted account: a single `embedContent` on the same key returns 200 seconds after the failure. Cause is `BATCH_SIZE = 100` documents in one `batchEmbedContents` (`lib/gemini-embed.ts:3`) against an 8s retry ceiling (`lib/gemini-retry.ts:52`). Fix in flight: smaller batches + pacing + honour the 429's own `retryDelay`.

**▶ COMMITTED as `35f8001` on `qa-fixes` (not pushed, NOT yet deployed) — 2026-08-18 ~18:55.** Contains Change A (upload percentage), A2 (speed + time remaining, 8s rolling window), B (server-stage progress via `videos.metadata`), the five blind-review fixes, the sixth defect the main session found while reviewing those fixes, and the AI-chat 429 fix (32-per-request batches, paced, halving to a floor of 4, honouring the 429's own `retryDelay` opt-in so `gemini-batch-transcribe` is untouched).
**Gates run BY THE MAIN SESSION, not taken on an agent's word:** `pnpm tsc -b --force` clean · `pnpm test:web` **178 files / 1516 tests passed**, 26 skipped, exit 0 · every new test mutation-checked.
**The sixth defect is the one worth remembering:** the fix for "share page polls forever" added `return !aiRequestPending` as the fall-through, which is TRUE mid-transcription — `isAiRequestPending` returns false the moment `transcriptionStatus` is truthy, and `app/api/videos/[videoId]/generate/route.ts:107` deliberately leaves `aiGenerationStatus` unset until generation starts. The poll would have stopped in the middle of transcription and frozen the "Bo'lak N/M" line until a manual reload. Guarded by `if (d.transcriptionStatus === "PROCESSING") return false;` and mutation-tested. **A fix reviewed only by its author is how that class of defect ships.**
**KNOWN, not hidden:** `upload-cap-button-fast-path.test.ts` failed once in four full-suite runs and passes 5/5 in isolation — a pre-existing race in that file, recorded not fixed. Cosmetic and out of scope: the optimize percentage restarts near 0 when a copy times out and the compress fallback begins.
**CRLF discipline paid off again:** three agents flipped LF files to CRLF, inflating the diff from 1394 real lines to 3087. Normalised back before committing. Always compare `git diff --shortstat` against `git diff --ignore-cr-at-eol --shortstat` before a commit here.

**⏸ STOPPING POINT — 2026-08-18 ~22:30. Two commits ready, NOTHING DEPLOYED, one step left: a third blind review, then the tag switch.**
`35f8001` (the feature) + **`5217819`** (the three second-review fixes: the transcription→generation handoff freeze, the unclamped `retryDelay`, the "saving" heartbeat). Gates run BY THE MAIN SESSION on `5217819`: `pnpm tsc -b --force` exit 0 · `pnpm test:web` **178 files / 1519 tests, exit 0** · all three mutation-checked · no CRLF churn (151 == 151).
**TO RESUME:** (1) spawn ONE fresh non-author `judge` on `git diff 35f8001..5217819` — it is a THIRD round of behaviour changes and the last two rounds each broke something adjacent; (2) if clean, deploy = `ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149`, `cp /opt/data365/docker-compose.app.yml{,.bak-5217819}`, build `data365-web:5217819` the same way `35f8001` was built (`/opt/data365/app-35f8001` is already there as the template), switch the one `image:` line, `docker compose -f docker-compose.app.yml up -d`; (3) live-verify M1 — `curl -X POST https://data365.duckdns.org/api/video/ai/chat -d '{"videoId":"2e466nedt9f8kgp","messages":[{"role":"user","content":"Bu yigilish nima haqida?"}]}'` must stream `{"token":…}` and ZERO `{"error":…}`; today it returns exactly one 429 error frame.
**Why it was not deployed tonight (owner told, 22:00):** the owner's approval was conditional on a clean review and the review said do not ship. Three rounds, three times a fix broke something adjacent — shipping the third round unreviewed would repeat the same mistake a third time.

**🔴 THE SECOND BLIND REVIEW SAID "DO NOT SHIP" — `35f8001` IS COMMITTED BUT MUST NOT BE DEPLOYED AS-IS (2026-08-18 ~22:00).** The owner's deploy approval was conditional on a clean review; the condition FAILED, so nothing was switched. The image `data365-web:35f8001` IS built and waiting on the host (`/opt/data365/app-35f8001`, build exit 0) — building changes nothing live; the switch is the one `image:` line in `/opt/data365/docker-compose.app.yml`.
Three findings, being fixed now:
1. **BLOCKING — the poll dies in the transcription→generation handoff.** `use-ai-status.ts` returns terminal for `{transcriptionStatus:"COMPLETE", aiGenerationStatus:null, hasContent:false, aiRequestPending:false, processingStage:null}`, and the pipeline manufactures exactly that state on EVERY run: `transcribe.ts:1980` writes COMPLETE, then two more workflow steps run before `generate-ai.ts:120-128` writes `aiGenerationStatus:"QUEUED"`. A 4s poll landing in that window stops for good and `ShareVideo.tsx:289-294` burns its one-shot `router.refresh()` — the summary generates invisibly and the page is frozen until a manual reload. **My own "sixth defect" guard only covered `"PROCESSING"`, so it moved the freeze two steps later rather than removing it — and the test I wrote hard-codes the broken expectation (`processing-overlay-findings.test.ts:163-166`).** Discriminator for the fix: `metadata.aiGenerationRequestedAt` (predicate at `lib/ai-generation-request.ts:32`) — COMPLETE with no AI content is terminal ONLY when AI was never requested.
2. `gemini-retry.ts:70-72` — the honored `retryDelay` REPLACES the backoff unclamped; `maxDelayMs` bounds only the exponential base, so a `"retryDelay":"35994s"` body sleeps for hours inside a chat request.
3. `process-video.ts` + `PROCESSING_STAGE_STALE_MS` — `write("saving", null)` fires once and every later call is suppressed, so a >5-minute save of a 1-2 GB `result.mp4` stales out WHILE RUNNING: the overlay vanishes mid-save. Needs a heartbeat.
**The lesson, for the record:** two blind review rounds, and each one found a defect that the PREVIOUS round's fix had introduced. A fix is new code; it gets its own review. Do not treat "the reviewer's findings are fixed" as "the reviewer approved it".

**IN FLIGHT RIGHT NOW:** second blind non-author review of `35f8001` (the owner's deploy approval is conditional on it being clean), and the host is pre-building `data365-web:35f8001` — building changes nothing live; the switch is the one `image:` line in `/opt/data365/docker-compose.app.yml`.

**NEXT STEP:** finish the blind non-author review of Change B → commit → **ask the owner to approve the deploy** → live-verify. Then M2 (below) on one real upload.

**METRIC — not an opinion.** M1 = the gate above. **M2, still UNMEASURED and not measurable from this machine** (next-auth uses JWT sessions; there is no login credential here): on one real ≥300 MB upload, every 5s sample shows a number and no two changes are >30s apart. The SAME upload also settles wave 1's own unmeasured number (`multipart/complete` → `processingStartedAt`, target <3 min against a 2h03m baseline) — ask for ONE upload, get BOTH.

**OPEN QUESTION OUT WITH RESEARCH:** he says big files are frequent, so "shrink in the browser before uploading" is on the table. `@remotion/webcodecs` is already a dependency and already converts recordings in production (`web-recorder-dialog/recording-conversion.ts:111`). **Do not build it until the throughput question is answered** — re-encoding a 2-hour video on his low-end laptop may cost more time than the upload it saves.

**CARRIED, NOT CONFIRMED:** the four cards he approved 2026-08-16 (`z92046jw04`, `z92046jvh3`, `z92046jvh4`, `z92046jw05` — upload-into-folder, multi-file move, folder-into-folder, 1-click upload) appear to have been built in the 08-17 range, but that was never confirmed card-by-card on ClickUp. Verify before telling him anything shipped.

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

