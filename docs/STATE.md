# Ustoz (data365) — STATE

_Trigger words: "ustoz", "cap", "cap-v2", "data365". Source of truth for resume._
<!-- KEEP THIS LINE IN THE TOP 10 LINES. The state-pointer hook reads the quoted
     phrases from the first 10 lines of this file to route the owner's word
     "ustoz" to THIS project. A top-block rewrite on 2026-08-04 dropped it and
     the routing silently broke — restore it in every future rewrite. -->

## GOAL — what "done" looks like
data365 runs on the team's own Contabo server (`https://data365.duckdns.org`) and is **boringly reliable**: uploads finish, AI analysis simply works, the system restarts what stalls, and the owner stops hearing complaints from the team. He is a non-programmer — every screen must say what is happening in a number he can act on.

## RESUME HERE - live point 2026-08-31 (data365 AI restored on gemini-3.7-flash)

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

**⚠️ STILL UNPROVEN IN PRODUCTION, stated not hidden.** That chat probe was served by the **FREE** chain (`gemini-3.5-flash`, $0) — it proves the app is healthy, NOT that the paid OpenRouter leg works end-to-end through our own code. Direct API calls with the production key prove the vendor side; the app-path paid call has not run since the deploy. **The one action that settles it: the owner presses "Retry" on `y71wes3p9q32bg4`.** A 121-minute video exhausts the free quota, so generation falls to the paid leg — his summary and the proof arrive together. Until then, treat the paid path as vendor-verified only. Do not write "paid leg verified" on this board without an `openrouter/google/gemini-3.7-flash` row in `ai_usage_events`.

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

