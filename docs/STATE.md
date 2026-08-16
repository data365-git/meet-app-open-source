# Ustoz (data365) — STATE

_Trigger words: "ustoz", "cap", "cap-v2", "data365". Source of truth for resume._
<!-- KEEP THIS LINE IN THE TOP 10 LINES. The state-pointer hook reads the quoted
     phrases from the first 10 lines of this file to route the owner's word
     "ustoz" to THIS project. A top-block rewrite on 2026-08-04 dropped it and
     the routing silently broke — restore it in every future rewrite. -->

## 🚨 ROOT CAUSE OF ALL UPLOAD FAILURES — FOUND AND FIXED 2026-08-14 ~06:30

**Every video upload since the cutover was dying at ZERO bytes, and the cause was one missing setting: the new R2 bucket had no CORS policy.** Cloudflare said it in its own words when a browser-style preflight was simulated against a presigned PUT: `403 … <Message>CORS not configured for this bucket</Message>`.

- **Why it was missed:** the bucket `meetapp` was created BY HAND in the dashboard during the migration. A bucket's CORS policy does not travel with its objects, so copying 142 objects moved the data and left the browser-write permission behind. Server-side reads and writes (the app's own transcription, the nightly backup, the object copy) all worked throughout, which is exactly why every earlier check looked green — **only the BROWSER is subject to CORS.**
- **The victims, both previously misdiagnosed:** `r5m2y8jxhatkmef` ("IMG_1400", 08-12 21:54) and `4a951226qwjhbz9` (08-14 06:05). Both `singlepart`, both `uploaded 0 / total 0`, both `phase error`. The 08-12 one had been recorded here as an isolated failed upload; it was not isolated, it was the first symptom.
- **Fixed by the owner** (the app's R2 token is `Object Read & Write`, so `put_bucket_cors` returns AccessDenied — this genuinely required the dashboard). Policy applied: origin `https://data365.duckdns.org`, methods GET/PUT/POST/HEAD/DELETE, all headers, `ETag`/`Content-Length`/`Content-Type` exposed, max-age 3600.
- **VERIFIED, not assumed:** preflight now returns **HTTP 204** with `access-control-allow-origin: https://data365.duckdns.org`, and a real cross-origin presigned PUT stored **4096 bytes** (HTTP 200) which was then deleted. The upload path works at the storage layer.
- **⚠️ CARRY THIS INTO ANY FUTURE STORAGE MOVE:** copying objects is not migrating a bucket. Bucket-level configuration — CORS above all, plus lifecycle rules and public-access settings — must be checked explicitly, and the only honest check is a simulated BROWSER preflight, because every server-side probe passes without it.
- **Second, smaller finding from the same log sweep:** `Failed to find Server Action … might be from an older or newer deployment`. A page left open across a deploy fires actions that no longer exist. Harmless once reloaded, but it means a deploy should be followed by telling the owner to hard-refresh.
- **STILL OPEN (owner-visible):** the share page for a failed upload shows the player's generic *"This recording could not be found — please contact your admin"*, which is advice the owner cannot act on. He asked for it to say the upload was interrupted and to re-upload. The correct copy ALREADY EXISTS (`progressUploadInterrupted` in `messages/uz.json`) but is not what the player renders for this state — `StorageMissingOverlay` is chosen from `metadata.storageMissing` alone and cannot tell "never arrived" from "vanished later". Fix shape agreed with him: flag the incomplete-upload case when the reconcile cron sets `storageMissing`, and give the overlay the re-upload copy for it.

## ▶ STOPPING POINT — 2026-08-16 ~20:00 — SHIPPED AND LIVE-VERIFIED

**Production now runs `data365-web:7e26ca9`.** The final blind review returned **SHIP** — the first clean verdict on this stack.

**Live-verified after the switch, not assumed:** `/api/health` 200 `db:ok storage:ok` · `/api/cron/poll-batch-jobs` 200 · `/api/cron/recover-stale-ai-jobs` 200 (`retried:0`) · `/login` 200 · a share page 200 · `data365dashboard.uz` still answering. The only log lines matching "error" are the pre-existing `ER_DUP_FIELDNAME` migration notice the code itself labels benign — checked, not assumed. **Rollback is one tag change:** `7029a39`, `1d85710`, `7d3ecd4`, `5c9a52d` are all still on the host.

**What shipped:** `67826b7` (an "AI tahlil" press made while the video is still processing is recorded and honoured when processing finishes, with the 30-min cron as backstop) · `198d65a` (cost panel parts add up to the total) · `44b5236` (one-shot marker, claim compare-and-swap, no recovery-budget refund) · `7e26ca9` (split `isRetry` from `reclaimProcessing`; keep the order when the start failed).

**NOT verified live, stated plainly:** the cost panel renders client-side, so its corrected figures (950 + 924 = 1 874 on `kc45xjnar36v9gg`) were confirmed by the DB numbers and a RED-verified pin, not by a rendered page. One page load by the owner settles it.

**Two non-blocking notes the final review left, worth a follow-up commit:** (1) `app/api/cron/recover-stale-ai-jobs/route.ts:373-374` — the comment claims all three no-code refusals leave the row at NULL, but a launch failure happens AFTER the claim and this caller passes `isRetry=true`, so the rollback is skipped and the row stays PROCESSING (recovered by the stale arm; nobody loses a press, but the comment is wrong in a file whose safety story is carried by its comments); (2) the source-scan pin in `__tests__/integration/pending-ai-request.test.ts` uses `src.match` and so is position-dependent — harden with `matchAll` plus "exactly one 5-arg call exists".

**THE HONEST RECORD OF THIS STACK: four build rounds, four blind reviews, three DO-NOT-SHIP verdicts, every one a real defect** — a standing order that would have launched paid work nobody requested, a claim race that could double-bill one video, and a one-shot marker consumed by refusals that started nothing. Green gates caught none of them; the one defect the SUITE did catch was the main session patching the wrong call site. Nothing here ships on green gates alone.

## ▶ STOPPING POINT — 2026-08-16 ~15:00 (READ FIRST; the 08-14 block below is now history)

**Production is HEALTHY and everything the owner reported today is resolved or in flight.** Live image `data365-web:7029a39`, `/api/health` `db:ok storage:ok`.

**WHAT HAPPENED TODAY, in order:**
1. **"AI tahlil qotib qolibdi"** — two fresh uploads (`kc45xjnar36v9gg` 1h15m, `qnr1fnx2nezwvv2` 1h44m) sat with `transcriptionStatus NULL` for 25 min. **Diagnosed from production, not guessed:** he pressed the button at `14:15:16`, but `[process-video] Optimized video for …` only finished at `14:16:17` — one minute LATER. `transcribeVideo` refused because the upload row was still in an in-progress phase and returned `{success:true, "Video upload is still in progress"}`; the route reads only `result.success`, so it answered **`{"started":true}`** — 16 bytes, confirmed in the nginx log — and **nothing recorded the request, so nothing ever started it.** A silent, permanent no-op.
2. **Both videos rescued by hand** (marked PROCESSING with stale markers → `/api/cron/recover-stale-ai-jobs`, which re-kicked 2). **Both now COMPLETE** with full summaries (32 956 and 38 254 chars) — and they finished **on OpenRouter** (`openrouter/google/gemini-3-flash-preview` rows in `ai_usage_events`), which is the first production proof that the paid continuation works on real client recordings.
3. **Cost panel showed 903 + 903 against a total of 1 935** — the parts summed to less than the whole. **Cause found and fixed:** `actions/billing/get-monthly-spend.ts` rounded EACH operation to a whole cent, and one cent is ~129 so'm. His video: transcription 7.3643c and summary 7.1592c both rounded DOWN to 7 (903 so'm) while the total 14.5235c rounded UP to 15 (1 935 so'm). Rounding now happens once, in `formatUzs`. After the fix: **950 + 924 = 1 874**, exact.

**BOTH FIXES ARE NOW COMMITTED on `qa-fixes`, gates green, NOT deployed:**
- **`67826b7`** — never lose an "AI tahlil" press made during processing. The refusal now carries a machine-readable `code: "UPLOAD_IN_PROGRESS"`; the route records `aiGenerationRequestedAt` (server-side `JSON_SET`) and answers `{queued:true}` instead of lying with `{started:true}`; `process-video` starts the pending request after it deletes the upload row; and `recover-stale-ai-jobs` rescues a pending request whose status is still NULL. Test drives the REAL route → transcribeVideo → processVideoWorkflow → cron against one shared row; **RED-verified** (3 of 4 cases fail with the fix stashed). Gates: tsc 0 · **1418 passed / 26 skipped** · real build 0.
- **`198d65a`** — the cost panel's parts now add up to its total (see item 3 above). Source-scan pin RED-verified.

**⚠️ THE AUTHOR'S OWN DISCLOSED WEAK SPOTS on `67826b7` — hand these to the reviewer, do not re-derive them:** (1) the DB fake interprets `JSON_SET`/predicate text itself, so a real MySQL divergence would not be caught — nothing ran against live MySQL; (2) a residual millisecond race — the marker is written AFTER the refusal, so if processing completes in that window the marker is redeemed only by the 30-min cron (chosen deliberately to keep duplicate-start risk at zero); (3) **`app/api/videos/[videoId]/retry-transcription/route.ts` has the SAME shape and was left alone** — it can now branch on `result.code`; (4) the new cron query has no age gate and no attempt counter, so a permanently-refusing video is retried every 30 min forever (each attempt is cheap — it returns before the budget check and before any AI call — but unbounded).

**NEXT ACTION:** (1) **blind non-author review of `67826b7`**, aimed at those four disclosed spots plus the usual question in this area — can any path now start a DUPLICATE job, or spend while free is available; (2) if SHIP, build + deploy both commits together (`git archive <sha>` → `/opt/data365/app-<sha>` → `docker build -f apps/web/Dockerfile -t data365-web:<sha> .`, bump the tag in `/opt/data365/docker-compose.app.yml`, `docker compose … up -d` — **never a bare `docker run`**, it skips the `data365_default` network); (3) verify live and tell him. Rollback stays one tag change: `1d85710`, `7d3ecd4`, `5c9a52d`, `7029a39` are all on the host.

**MEASURED, DECIDED, NOT YET BUILT:** `gemini-3.7-flash` transcribes measurably BETTER than the current model on the same three 3-min chunks — coverage 2m54s vs 2m27s mean, and it sometimes resolves real speaker names. It is reachable on the FREE Google key today (its own separate 20/day allowance, so adding it also RAISES free capacity), but **blocked on OpenRouter** by the account's strict data policy — every other Gemini model is blocked there too, so the paid leg must stay on `gemini-3-flash-preview` unless the owner relaxes privacy. Proposal put to him and NOT yet answered: put 3.7 at the FRONT of the free transcription chain. Also unanswered: whether to delete the two dead upload rows (`r5m2y8jxhatkmef`, `4a951226qwjhbz9`).

**STILL OPEN (agreed with him, not built):** a failed upload shows the player's generic *"This recording could not be found — contact your admin"*. He asked for *"xatolik bo'lgani bilinsin, qayta yuklang desin"*. The Uzbek copy already exists (`progressUploadInterrupted`); the gap is that `StorageMissingOverlay` is chosen from `metadata.storageMissing` alone and cannot tell "never arrived" from "vanished later". Also waiting: the 10-minute chunk change (`docs/chunk-size-measurement.md`) — same transcript for a QUARTER of the free requests. Do it AFTER the pending-request fix ships, never bundled.

## ▶ THE STOPPING POINT — 2026-08-14 ~02:50 (read this first, then the incident block below)

**GOAL of this stream, in his words:** *"ai tahlil bu ishini to'liq hal qilib qo'y yana shikoyat eshitish hohlamayman"* — AI analysis must simply work, with no daily ceiling, so the team stops complaining. Report to him on Telegram when it lands (his chat id is the single entry in `~/.claude/channels/telegram/access.json`).

**WHERE IT IS RIGHT NOW:**
- **Production is UP and AI analysis WORKS** on `1d85710` — but on a stopgap: the paid key slot holds the FREE key, so the ~20-requests/day ceiling still applies (≈ one recording a day). See the incident block below.
- **The real fix is committed and NOT deployed: `7630159` → `197cb2a` on `qa-fixes`.** Gates re-run by the main session at `197cb2a`: **tsc 0 · 1416 passed / 26 skipped · real `next build` 0.** (IDE diagnostics during the agents' edits looked alarming twice and were stale both times — a clean `tsc -b --force` is the truth.)
- **Round 18 happened exactly like the previous 13:** the first blind review of `7630159` returned **DO-NOT-SHIP** with 8 findings, the worst of which silently dropped **the end of a meeting** from the transcript in the ordinary free-tier configuration. `197cb2a` fixes findings 1-7 (finding 8 — `poll-batch-jobs` needing a paid Gemini key — was left out of scope deliberately: legacy Batch admin, no spend impact, and production has a Gemini key).
- **A SECOND blind review of `197cb2a` was in flight when this was written.** Do not deploy until it returns. Its result is the only thing standing between here and the deploy.

**THE NEXT ACTION, in order:**
1. Read the second review. If **SHIP** → bump the image tag in `/opt/data365/docker-compose.app.yml` to `197cb2a` and `docker compose -f /opt/data365/docker-compose.app.yml up -d`. **Never a bare `docker run`** — that skips the `data365_default` network and produced a live `db:error` tonight.
2. The image for `7630159` is already built on the host, so a build for `197cb2a` will be fast off the layer cache. Source ships as `git archive <sha>` → `/opt/data365/app-<sha>` → `docker build -f apps/web/Dockerfile -t data365-web:<sha> .`
3. `OPENROUTER_API_KEY` is ALREADY written into `/opt/data365/app.env` (backup `app.env.bak-or-*`). Nothing else is needed for the paid path.
4. Verify live: `/api/health` 200 `db:ok storage:ok`, a share page 200, and `/api/cron/poll-batch-jobs` 200. Then **run one real AI analysis** and confirm it completes past the free ceiling — that is the only proof that matters for his complaint.
5. Tell him on Telegram.
- **Rollback is one tag change:** `1d85710`, `7d3ecd4`, `5c9a52d` are all still on the host.

**MEASURED AND WAITING (not started, do not lose):** the free tier counts REQUESTS, not tokens, so `LONG_AUDIO_CHUNK_DURATION_SEC = 3 * 60` spends ~20 free requests on one 1-hour recording. A live A/B on the same 10 minutes showed **a 10-minute chunk returns the same transcript content** (1 224-1 233 words across all three arms) for a **quarter of the requests**. Full numbers, method and the latency ceiling are in the `docs/chunk-size-measurement.md`; the owner approved testing it. Do this AFTER the OpenRouter deploy, never bundled with it.

## 🌙 AUTONOMOUS RUN — 2026-08-14 ~00:30, owner asleep

**His order, verbatim:** *"ai tahlil bu ishini to'liq hal qilib qo'y yana shikoyat eshitish hohlamayman / men esa uhlayman bajargach aytib qo'y telegram bot orqali."* So: finish the AI-analysis fix end to end and report to him on Telegram (his chat id is the single entry in `~/.claude/channels/telegram/access.json`).

**Why the stopgap is not enough:** the paid slot currently holds the FREE key, so the daily ~20-request ceiling still applies — about one recording a day, and then the complaints return. The real fix is `7630159`, which routes the PAID leg through OpenRouter (unlimited by quota, bounded only by credit).

**State at the time of writing:**
- `7630159` gates re-run by the main session: **tsc 0 · 1398 passed / 26 skipped · real `next build` 0.** (The IDE diagnostics that looked alarming were stale mid-edit snapshots; a clean `tsc -b --force` is 0.)
- **Blind non-author review IN FLIGHT** with a falsifiable bar — the only thing that has ever caught defects in this area; green gates have caught 0 of ~20.
- Server prepared but NOT switched: `OPENROUTER_API_KEY` written into `/opt/data365/app.env` (backup `app.env.bak-or-*`), source of `7630159` unpacked to `/opt/data365/app-7630159`, image building to `data365-web:7630159` (log `/opt/data365/build-7630159.log`). **Production still runs `1d85710`.**
- **Deploy ONLY if the review returns SHIP.** Restart with `docker compose -f /opt/data365/docker-compose.app.yml up -d` after bumping the image tag in that file — never a bare `docker run` (that is what caused the brief `db:error` below).
- Rollback stays one tag change: `1d85710`, `7d3ecd4`, `5c9a52d` are all still on the host.

## 🚨 PRODUCTION INCIDENT — FIXED 2026-08-14 ~00:15 (read before anything else)

**The team reported "AI tahlil ishlamayapti". It was a real, total outage of the AI feature, and it had been down since the 2026-08-12 cutover.** Diagnosed live, not guessed.

- **Cause:** the whole AI feature is gated on `hasPaidGeminiKey()` — `lib/generate-ai.ts:57` refuses with *"No Gemini API key configured"*, and `app/s/[videoId]/page.tsx:553-555` sets both `transcriptionGenerationAvailable` and `aiProviderAvailable` from it. The new server had **only `GEMINI_API_KEY_FREE`**; the paid slot was empty, so the gate was shut and the free key could never be reached. Confirming evidence from the database: `ai_usage_events` has **282 calls on 08-11 and ZERO on 08-12/13** — the feature stopped the day of the migration.
- **Fix applied:** `GEMINI_API_KEY` added to `/opt/data365/app.env` (backup written alongside as `app.env.bak-<date>`), container recreated. **Proof: `/api/cron/poll-batch-jobs` returned HTTP 200 `{"success":true,…}` where it had been returning 500 `{"error":"No paid GEMINI_API_KEY configured"}`**; `recover-stale-ai-jobs` 200; `/api/health` `db:ok storage:ok`; a public share page 200.
- **⚠️ SELF-INFLICTED WOBBLE, recorded so it is not repeated:** the first restart used a bare `docker run`, which put the container on the default bridge instead of `data365_default`. `DATABASE_URL` addresses the DB by container name (`data365-db:3306`), so health went to `503 db:error` for about a minute. **Always restart via `docker compose -f /opt/data365/docker-compose.app.yml up -d`, never a hand-rolled `docker run`.**
- **⚠️ THIS IS A STOPGAP, AND ITS LIMIT MUST BE STATED:** the value placed in the paid slot is the SAME free-tier key. So the gate opens and analysis runs, but the daily ceiling is still ~20 requests per model — **roughly one 1-hour recording per day**, after which analysis fails again. It also means `ai_usage_events` will now record ESTIMATED costs for calls that actually bill $0, so the spend panel overstates until the real paid path lands. The genuine fix is the OpenRouter work below.

## ▶ NEXT STEP — READ THIS FIRST (2026-08-12)

**GOAL:** data365 is LIVE on the team's own Contabo server (`169.58.86.149`, `https://data365.duckdns.org`) and must stay boringly reliable — the analysis just works, spends the free allowance first, and restarts itself when something stalls.

**WHERE IT STOPPED (2026-08-13, latest — OpenRouter provider decision):** the owner supplied `sk-or-v1-…` believing it was a paid Gemini key. It is **OpenRouter**, not Google. Every AI call here hits `generativelanguage.googleapis.com` with a Google-format key (`AQ.Ab8…`), so putting it in `GEMINI_API_KEY` would 401 the whole AI path. He asked whether VTT could run through OpenRouter too, was shown both routes, and **chose Route B**.
- **Route A — OpenRouter's `/api/v1/audio/transcriptions` (Whisper/STT): REJECTED.** It has no speaker diarization, and this app's prompt (`gemini-transcribe.ts` ~L810) requires `Spiker 1/2` labels plus Uzbek-Latin and code-switch preservation. Weak Uzbek on top. A downgrade, not a swap.
- **Route B — the SAME Gemini model reached VIA OpenRouter `/api/v1/chat/completions` with `input_audio` base64: CHOSEN.** Same model + same prompt ⇒ same quality. Sizing checked, not assumed: `audio-extract.ts` cuts mono 24 kHz mp3 @ **64 kbps** ≈ 480 KB/min, so a 10-min chunk ≈ 4.8 MB → base64 ≈ 6.4 MB, well under OpenRouter's **25 MB** cap.
- **PHASE 0 IS DONE AND ROUTE B PASSED — measured 2026-08-13, not assumed.** Three real 3-min chunks (the app's true `LONG_AUDIO_CHUNK_DURATION_SEC`, cut with `audio-extract.ts`'s exact ffmpeg args) were pushed through BOTH arms at **production-identical settings** (`temperature 0.1`, thinking/reasoning OFF — `gemini-transcribe.ts:1167` sets `thinkingBudget: 0`, so any probe leaving thinking on is NOT a baseline):

  | chunk | Google (today's prod) | OpenRouter |
  |---|---|---|
  | 1 | 2m21s | 2m35s |
  | 2 | 2m04s | 2m26s |
  | 3 | 2m56s | 2m18s |

  All six runs HTTP 200, `finish_reason: stop`, `Spiker 1/2` labels and Uzbek Latin intact, latency **10–17 s** — far inside the 60 s upstream timeout that was the blocking unknown. Mean coverage 2m27s vs 2m26s: **parity**. Cost, measured from `usage.cost`: **$0.0129 per 3-min chunk ⇒ ≈ $0.26 (~3 300 so'm) for a 1-hour meeting** on the paid path (0 when the free allowance covers it).
- **Two findings worth keeping, both of which would have produced a wrong verdict:** (1) with reasoning left ON, OpenRouter returned a *fuller* transcript (3m00s of 3m00s) and even resolved a real speaker NAME ("Muzaffar") — so the first, alarming truncation reading was **my probe's misconfiguration, not an OpenRouter defect**; (2) both arms stop at ~80 % of a chunk under production settings, which is **pre-existing behaviour the workflow's gap-fill already absorbs** — it is not a regression introduced by this move. A cue-count of 0 in an early run was likewise a probe regex expecting `HH:MM:SS` against `MM:SS` output.
- **Verdict: transcription may move to OpenRouter.** The owner's acceptance line governs: same behaviour, same transcript quality as today, only the key now coming from OpenRouter.
- **Phase 1a is independent of that measurement and low-risk:** `translate-ai.ts`, the AI chat route and `generate-ai.ts` text generation can move to OpenRouter now, with Google as fallback. New `lib/openrouter-key.ts` must mirror the `gemini-paid-key.ts` contract (same gate, same source-scan pin). **OpenRouter is paid-only ⇒ it counts as a PAID call under the free-first invariant and sits exactly where paid Gemini sits today — after the free chain. Do not bypass that gate.**
- **STOPPED HERE ON THE OWNER'S WORD ("state yangilab to'xta").** Nothing was written to the repo; the only artefact is a scratchpad probe script (`…\scratchpad\probe-keys.mjs`), unrun.
- **🔴 SECURITY, before any deploy:** the OpenRouter key was pasted into chat and now lives in a transcript. **Rotate it on openrouter.ai first**; the new value goes only into server env, never a committed file. Then verify no OpenRouter error body can carry it into logs — round 7 deliberately made upload-leg errors echo response bodies.

**WHERE IT STOPPED (2026-08-12):** the AI speed-mode choice ("tez"/"arzon") is REMOVED — one behaviour now: try free first with a bounded probe, continue on paid immediately when free is exhausted, never wait. Stack `56e1372` → `caa5409` → `251e97f` on `qa-fixes`, **committed but NOT pushed and NOT deployed.** Production still runs `5c9a52d`. Gates re-run by the main session at HEAD: `tsc -b --force` 0 · web suite **1343 passed / 26 skipped** · real `next build` 0 · against production 39 files, **+670 / −1397**.

**ROUNDS 4-13 — the AI money/liveness stack. Full round-by-round log moved to `docs/STATE_ARCHIVE.md` (compressed 2026-08-13).** Honest tally: 13 build rounds, 13 blind reviews, ~20 real defects — **green gates caught none of them**, and nearly every defect was created by the previous round's fix. Lessons are in the brain: `feedback_unasserted_rule_is_not_a_rule` (four shapes) and `reference_software_design_ousterhout` (a field whose type you cannot name in one word is two fields wearing one name).
- **What protects the MONEY now:** ONE capability gate (`lib/gemini-paid-key.ts`) owns the paid credential and hands it out only against an explicit classified fact; `isBrokenFreeKeyError` matches ONLY the permanent auth family (401/403, or 400 *with* an auth token); `Symbol.for`-tagged "unusable model output" errors are excluded from BOTH the auth and the quota classifier before any regex runs. There is no failure counter — the classifier, not a threshold, is the protection.
- **What protects the SHARE PAGE:** `lib/ai-error-message.ts` (sanitizer) + `lib/processing-error.ts` (allowlist — persists the MATCHED TOKEN, never the input, so a presigned URL cannot ride along) + `processing-failure-message.ts` (token → localized key). Measured on production: **0 rows anywhere carry a URL or credential**, so this work is preventive, not remedial.
- **The test shape that finally worked — copy it:** drive the REAL code path with a stubbed `fetch`. Every earlier pin asserted strings authored at the test boundary, which is exactly why ~1350 green tests could not see a live hole.

**DEPLOY STATE:** production runs **`1d85710`** (reviewed, live-verified, clean). Committed locally but NOT deployed: `96b3723` → `712d8f9` → `07ed752` → `7a7546b` (gates at `7a7546b`: tsc 0 · 1382 passed / 26 skipped · real `next build` 0). Rollback images still on the host: `5c9a52d`, `7d3ecd4`, `1d85710`.

**OWNER-VISIBLE, still open:** `r5m2y8jxhatkmef` ("IMG_1400", 2026-08-12) failed at byte 0 and recorded nothing — he must re-upload it. That silence is exactly what rounds 10-13 fixed for future failures.

**BLOCKERS / OWNER-ONLY:** a real record→upload→appears-on-site run with the browser extension (needs a logged-in browser, which no session can do) · the new server's root password still needs rotating, it passed through chat · **the OpenRouter key was pasted into chat and must be rotated on openrouter.ai before this deploy.** (The old "paid Gemini key missing" blocker is CLOSED — the paid path moves to OpenRouter.)

---

## 📐 STANDING PROJECT RULE (TRIAL, opened 2026-08-10) — I keep ClickUp current, he never does

**The rule:** when I finish something, I move its ClickUp card and comment the diagnosis plus how he can check it. He should never drag a card to record work I did. Board: list "Meeting app" `901819987518`; columns `shkafda` → `jarayonda` → `tekshirishda` → `tamom`. My job stops at `tekshirishda` with the evidence; only he closes a card that needs his eyes.

**NET-BENEFIT LINE (what this must earn, or it dies):** he gets one glanceable board of what is waiting on him without asking me, and I stop re-explaining status in chat. Cost is a few API writes per finished item — near zero. **TRIAL:** if he does not actually open and use these cards within about a month, this is dead weight and the retro kills it.

**ONE-TRUTH, and an honest correction to how it was first stated.** `docs/STATE.md` is the source for STATUS; ClickUp is a one-direction VIEW of it. I already bent that on the day it was written — I read the eight `tekshirishda` cards and folded them into the owner list below, which is ClickUp → board.
- Keeping the strict rule as-is would be wrong, because **he files real requests as ClickUp cards himself** — `86eyjtx4p` ("AI tahlil jarayoni sahifa yangilangandan keyin yo'qolib ketmasin") is his own card, and ignoring it would have meant ignoring the owner.
- So the working rule is narrower and survives contact: **STATUS flows one way (board → ClickUp) and ClickUp status is never authoritative back.** But a card the OWNER authored is genuine input: pull it into the board ONCE, and from that moment the board owns it. The twin trap is two places claiming to know the state — not one place receiving a request.
- **This narrowing was reviewed and APPROVED by HQ the same day and is now the charter's own wording, with `86eyjtx4p` cited as the case that forced it.** Do not "restore" the strict form later thinking it was a shortcut — the strict form would have made the rule outrank the owner.

## 📋 THE OWNER'S LIST — hand him ONE at a time, in this order (agreed 2026-08-10)

He asked for his ClickUp checks to be MERGED INTO this list, not for his other duties to be pushed into ClickUp — I had it backwards once; do not repeat it. He works through them by saying "keyingisi"; give exactly one, wait, then the next.

Verification checks, from the ClickUp "tekshirishda" column (list `901819987518`):
1. `86eyk4cj0` AI chat — every timestamp clickable
2. `86eyjtx4p` AI analysis progress survives a page reload (his own card)
3. `86eyh74gk` transcript downloads under the recording's title
4. `86eyh74fk` an uploaded file's name becomes the recording's title
5. `86eyh749y` bulk "keep audio only"
6. `86eyh7493` MP3 download
7. `86eyh4v8w` drag-and-drop into folders
8. `86eyh4v7p` "Move to folder" button

Duties that live only here:
9. **A real 2-person Meet recording, judged BY EAR** — the launch gate no rig can close.
10. **Forward `MIGRATION_CLIENT_MESSAGE.md` to the client** — unblocks the whole migration.
11. **The team reinstalls extension 0.5.9** — one message from him.

## 🔴 OPEN NOW — 2026-08-13: the cron workflow has been RED every 30 min since the cutover

The owner forwarded the GitHub failure mail ("Run failed: Recover stale AI jobs"). Diagnosed from the run logs, not guessed:

- **Break point is exact: last green 2026-08-12 09:38 UTC, first red 10:56 UTC — the cutover hour.** Nothing regressed in the code; the app moved to a host without a paid Gemini key.
- **The failing step is only the third one, `Ping poll-batch-jobs` → HTTP 500 `{"error":"No paid GEMINI_API_KEY configured"}`.** Health is 200 (`db:ok storage:ok`) and `recover-stale-ai-jobs` is 200 in the very same run — the site itself is healthy.
- **Cause = OUTSTANDING ITEM #1 below, not a new defect.** `getPaidGeminiKey()` reads `GEMINI_API_KEY`; the team's key is free-tier, so the paid slot is empty and the capability gate refuses. Product consequence, stated plainly: AI analysis dies after the daily free allowance (~20 requests/model ≈ one short recording), and the discounted Batch route cannot run at all.
- **Nothing is stuck behind it.** The last green poll returned `{"pending":0}`, so no Batch job was in flight at cutover; the 500 is a refusal to start, not lost work.
- **Second red, unrelated and older: `Nightly DB backup` has failed every night since ≥2026-08-07** — `mysqldump: Lost connection … reading initial communication packet`. A GitHub runner cannot reach the DB because the DB is not public, and it must stay that way. **Backups are fine:** the server's own 22:00 cron ran last night (`/var/log/db-backup.log` mtime 2026-08-12 22:00:32) and uploaded `db-backups/capdb-2026-08-12.sql.gz` (7.7 MB) to R2. The GitHub workflow is a duplicate that can never work.
- **Alarm fatigue is the real risk:** 2 red mails per day for known, benign states train him to ignore the channel that also carries `uptime-alert`.

**⚠️ THIS BLOCK IS UNCOMMITTED, and deliberately so — ANOTHER SESSION WAS ACTIVELY EDITING THIS TREE while it was written (2026-08-13 ~10:50).** `apps/web/lib/gemini-paid-key.ts` and `transcribe.ts` changed under me minutes apart, `ai-speed-mode.ts` + `ai-job-control.ts` are staged as deleted, and `.claude/gate.cmd` is red mid-refactor — the normal state of work in flight, not damage. The done-gate correctly refused a commit, and I did not touch a line of that refactor. **Whoever owns it: commit this block with your work once the gate is green** (the text is also saved at `scratchpad/ustoz-cron-noise-fix.md` in case a STATE rewrite drops it). `git stash@{0}` holds a `goalkeeper round10 library-kind-column blocked attempt`.

**He approved the noise cleanup on Telegram ("2 ha"). HALF OF IT IS DONE:**

- ✅ **`Nightly DB backup` workflow is `disabled_manually`** (verified via `gh workflow list --all`). The server's own 22:00 backup is untouched and is the real one.
- ❌ **The `Recover stale AI jobs` fix could NOT be applied — the sandbox classifier refused every write to this repo's `main`** (Contents-API PUT twice, then `gh workflow disable` twice). Not a git problem and not a permissions problem on GitHub's side; it needs the owner to approve the action once in a terminal, or it disappears on its own the moment a paid key exists. **The prepared patch is in `scratchpad/ustoz-cron-noise-fix.md`** — the `poll-batch-jobs` step skips ONLY the body `No paid GEMINI_API_KEY configured`, every other non-200 still fails.
- ⚠️ **If that workflow is ever disabled instead of patched, remember what it alone does: it is the ONLY caller of `poll-batch-jobs`.** Health is covered by `uptime-alert` (every 15 min) and recovery by the server's own cron (`/var/log/app-cron.log`, 46 successful runs), so nothing else is lost — but with a paid key present and this workflow off, Batch results would never be collected.

**Two more findings from the same sweep, neither urgent, both worth a decision later:**
1. **`DB restore check` (Mondays 05:00 UTC, last green 2026-08-10) reads the R2 secrets stored in this REPO — the OLD account's** (set 2026-07-07) — while the server now backs up to the team's NEW bucket `meetapp`. It downloads the newest dump in that bucket, fails if it is `> 3 days` old, and otherwise restores it into a throwaway MySQL. Both outcomes are now wrong: if the old host still runs its own backup cron the check stays GREEN while verifying an abandoned database, and if it does not, **2026-08-17 brings a red "the nightly backup has stopped running" about a backup that is in fact running nightly** — in the other bucket. Fixing it means putting the new R2 credentials into the repo secrets; they are the team's keys, so it is the owner's call, and the alternative is to pause this workflow until then.
2. **`TELEGRAM_ALERT_CHAT_ID` is not set** (visible as empty in every workflow log), so the DOWN alert in `uptime-alert` can never actually reach Telegram — the owner only learns of an outage from GitHub's own failure mail. Setting it needs the alert bot to have been started by him at least once.

**Still waiting on the owner:** where the PAID Gemini key comes from — the team (a ready-to-forward Uzbek message is written at `scratchpad/gemini-paid-key-request-uz.md`), his own key temporarily, or leave the product free-only and accept ~one recording a day.

## 🎯 GOAL CHANGED BY THE OWNER 2026-08-10 — Railway is DEAD, it is the team's own Contabo server

**The new goal:** move Data365 onto **the team's existing Contabo VPS** (they already have one),
not onto a Railway project the client would have to create. The owner redirected mid-session.

**The question he asked, answered with the vendor's own words:** "can we just hand ownership over
without redeploying?" — **No.** Contabo transfers *"the entire account as a whole; it is not
possible to transfer a single instance"*, and only with a signed Transfer-of-Contract from both
parties ([source](https://help.contabo.com/en/support/solutions/articles/103000269442-can-i-transfer-my-account-to-someone-else-)).
Our account holds other things, so that door is closed — and it does not matter, because the team
already has their own server. A redeploy is unavoidable; the consolation is that the stack is
identical (Coolify + Docker + MySQL), so this is a copy, not a rebuild.

**His four decisions, settled — do not re-litigate:**
1. **Videos → the team's own Cloudflare R2.** 0.49 GB moves; they own it afterwards.
2. **Domain `data365.duckdns.org` stays.** Consequence, and it is large: **the team does NOT
   reinstall the browser extension** (the extension reads a configurable `apiBaseUrl` with
   `DEFAULT_API_BASE_URL`, checked in `apps/browser-extension/src/shared/config`), and **every
   share link already handed out keeps working**. Honest caveat recorded in the requirements doc:
   the name is still OUR DuckDNS record, so full independence would later mean their own domain.
3. **Gemini key → theirs**, so AI spend follows the product.
4. **Their server probably already runs other projects** (his words, not measured) — so a
   read-only inspection comes before anything is installed.

**DELIVERABLES BUILT THIS SESSION (his ask: one HTML for the human, one file for the server):**
- [`docs/migration/data365-kochirish.html`](migration/data365-kochirish.html) — self-contained
  Uzbek guide for the team member: 4 steps, saved checkboxes, copy buttons, light+dark.
  **Live-verified in the Browser pane** at desktop dark and mobile light, zero console errors.
- [`docs/migration/01-server-check.sh`](migration/01-server-check.sh) — **read-only** server
  inspector. Installs nothing, deletes nothing, stops nothing; prints a copy-paste report
  (OS, cores, RAM, disk, Docker, Coolify, ports 80/443, outbound reachability, public IP).
- [`docs/MIGRATION_CLIENT_MESSAGE.md`](MIGRATION_CLIENT_MESSAGE.md) — rewritten cover note that
  ships those two files. **The old Railway text was wrong and is gone.**
- [`docs/MIGRATION_REQUIREMENTS.md`](MIGRATION_REQUIREMENTS.md) — rewritten for Contabo. The old
  "Railway bills by usage, the invoice may spike" warning is DELETED (Contabo is a flat monthly
  fee) and replaced with the two real risks: a shared server, and AI spend moving to them.

**WHY THE INSTALLER SCRIPT WAS DELIBERATELY NOT WRITTEN YET.** We have never seen their server.
An untested migration script is worse than none because it invites being trusted — the same rule
that stopped the Railway copy-script. Phase 1 (inspect) is safe to run today and needs no
decisions; phase 2 (install) gets written against the report it returns.

**PRUNED as part of this re-baseline:** the 2026-08-07 OWNER TODO "forward
`MIGRATION_CLIENT_MESSAGE.md`" is superseded — the message it pointed at described Railway. The
duty survives in new wording (send the HTML + the check script), and its original age is carried
below so it does not reset.

**OWNER TODO (since 2026-08-07)** — ONE action: send the two files above to the team member.
WHAT HE WILL SEE: they run one command and send back a short report, and at that moment we can
write the real installer. VALVE: if they push back on owning the Cloudflare/Gemini accounts, say
so — the current server can simply stay, nothing breaks.

**Parked, NOT in the tree, do not deploy it blind:** `docs/parked/migration-runner-skip-benign.patch`
(+ its test, `.parked`). A ~150-line rewrite of the DB migration runner so a benign duplicate-column
error skips one migration instead of silently aborting the whole run (the 2026-08-05 `0038` incident).
It was reverted on purpose: its RED-first proof was vacuous (the old code failed the new tests for
the wrong reason — a missing fixture journal, not the defect), it drops drizzle's wrapping
transaction, and it would land in the exact deploy we can least afford to break — a fresh DB on
their server has no duplicate errors, so the defect it fixes does not even apply to that path.
Pick it up AFTER the migration, with a blind non-author review and a genuine RED test.

---

## ▶▶ THE SPEED-MODE CHOICE IS GONE — one behaviour (2026-08-12, owner's decision)

**His words:** *"fast yoki arzon degan modlar yo'q… AI tahlil deganda shunchaki tahlil qiladi, birinchi bepul limitdan foydalanadi, ko'p kutmaydi, tugagandan so'ng tezlikka o'tadi."* One path now: try FREE first (bounded probe), and on quota exhaustion or timeout continue on PAID immediately. No chooser, no waiting, no queue.

**Before this, what was actually still live** — checked in code, because the earlier rounds only removed the WAITING machinery, not the modes: the chooser still rendered `aiModeFast`/`aiModeCheap`, and `workflows/transcribe.ts` still branched on `aiSpeedMode === "cheap"` — including `:1224`, where cheap ran chunks **serially**. That serial branch was the "slow" the owner was rejecting.

**`56e1372` — 36 files, +276 / −1387, i.e. it removes about 5x what it adds.** Deleted: the UI chooser AND the confirm step it hosted, the "continue on paid" button + route + `lib/ai-job-control.ts`, `lib/ai-speed-mode.ts`, all `aiSpeedMode`/`speedModeOverride` plumbing in both phases, the serial-for-cheap concurrency, the cheap/fast stale-threshold split (one 60-min since-progress window now), org-settings `aiSpeedMode`, and the related locale keys and status-API fields. **Gates re-run by the main session: tsc 0 · web suite 1334 passed / 26 skipped · real `next build` 0.** NOT deployed — blind non-author review in flight.

**THE FIRST BLIND REVIEW OF `56e1372` RETURNED DO-NOT-SHIP, on a regression the change itself created.** With the modes gone, any non-quota free failure rethrows — so a REVOKED or invalid `GEMINI_API_KEY_FREE` (a 400/403, which `isQuotaLikeAiError` correctly does NOT treat as exhaustion) failed every chunk 4×, the cron re-kicked twice, then terminal ERROR, and the user's Retry re-ran the identical path forever. At `5c9a52d` this was invisible because the default mode was `fast`, which fell through to paid on ANY free failure — and the same commit had deleted both escape hatches (the manual "continue on paid" button/route and `lib/ai-job-control.ts`). Net: 100% of analyses would fail until someone edited a server env var. **The review also confirmed the money invariant is the cleanest it has ever been** — every paid-key acquisition goes through the gate, no direct env read survives anywhere incl. `scripts/`, the owner's personal key passes the same gate, classification is right in BOTH directions, and `BudgetExceededError` cannot be misread as exhaustion.

**`caa5409` fixes it without reopening the old defect:** `lib/free-tier-health.ts` counts genuine (non-quota, non-deadline) free failures per job; ONE such error still rethrows and never bills, and only after **3 consecutive** for the same video is the free key classified unusable for that job. Also fixed: `freeAttempted` was a hardcoded LITERAL at the transcription paid call site (the exact shape that regressed three times) — now computed, with the missing assertion added so both phases are pinned. While wiring it Fable found and fixed a real bug in its own fix: the classification rethrow sat inside the probe's `try` and was re-caught by its own `catch`, double-counting the streak.

**⭐ TWO OWNER DECISIONS, 2026-08-12 — do not re-litigate:**
- **Gap-fill may spend money, but only when the gap matters** — his words: *"agar muhim narsa bo'lsa ha pul sarflansin."* Implemented in `251e97f` as a measurement, not a guess: `measureSpeechSeconds()` runs the extractor's own silencedetect pass on each gap span, and only a span with **≥ 60 s of detected speech** may go paid; below that it is free-only and a failure stays a recorded gap. An unmeasurable span counts as worthy — silence must PROVE it is trivial.
- **No confirmation on re-analysis.** But read what he actually said, because it is a requirement rather than an answer: *"Nega qayta analiz? Agar analiz qotib qolsa, o'zi ishga tushadigan qildik-ku… server o'zi yana uni yurgizib yuborishi kerak."* **A stalled job must restart itself with no human action.** That chain runs through the machinery this very refactor rewrote, so it was made an explicit verification target rather than an assumption.

**Author-claimed and currently under independent check (do NOT report as proven until the final review lands):** the restart chain end to end — claim stamps both markers before launch · a 5-min `setInterval` heartbeat re-stamps `aiProgressAt` independent of any await and dies with the process · the cron selects `PROCESSING` rows older than one 60-min since-progress window with a `''` COALESCE arm so marker-less rows stay visible · live jobs are protected twice · re-kick never passes status through NULL · bounded at 2 retries then visible ERROR + ops alert. Disclosed caveat, pre-existing and NOT a regression: generation liveness is start-time-based, not heartbeat-based, so a legitimately >60-min generation stage could be re-kicked mid-run.

**Stack: `56e1372` → `caa5409` → `251e97f`. Gates re-run by the main session at HEAD: tsc 0 · web suite 1343 passed / 26 skipped · real `next build` 0. Against production: 39 files, +670 / −1397 — still removes about 2x what it adds.** NOT pushed, NOT deployed.

**⚠️ MEASURED CORRECTION TO THE EXPECTATION, told to the owner rather than let him assume it:** removing the modes buys SPEED and SIMPLICITY, **not money**. Prod ledger on the new server, free vs paid calls per day — 11 Aug: 44 free / 238 paid ($1.99) · 10 Aug: 48 / 75 ($0.63) · 9 Aug: 43 / 54 ($0.34). **The free allowance is already fully consumed every single day** (2 models × 20/day ≈ 40, plus retries), so there is no unused free capacity for a smarter mode to capture.

**⭐ THE ONLY REAL MONEY LEVER LEFT, and it is untested: `LONG_AUDIO_CHUNK_DURATION_SEC = 3 * 60`.** The free tier counts REQUESTS (`generate_content_free_tier_requests, limit: 20`, verbatim from Google), not tokens — so a 68-minute recording becomes ~23 requests and exhausts the daily free allowance on ONE video, while each request carries only ~5,150 input tokens against a context near 1M. At ~20-minute chunks the same recording is ~4-5 requests and several videos a day would fit inside the free tier. **Not changed, because it is unverified against QUALITY** — timestamp accuracy, speaker separation, and the gap/partial-recovery machinery all assume small chunks. Needs a measured A/B on one real recording (3-min vs 15-min vs 20-min, comparing cue drift and word accuracy) before any change.

---

## ▶▶ MIGRATION TO THE TEAM'S OWN CONTABO SERVER — IN FLIGHT (2026-08-12)

**The owner handed over full authority and the new server's credentials.** New host: `169.58.86.149`, Ubuntu 22.04, 4 vCPU, 8 GB RAM, 97 GB disk (93 free). Password login was used ONCE to install our key (`~/.ssh/hetzner_ustoz`); everything since is key-based, and the root password must still be rotated because it passed through chat.

**⚠️ THE SERVER IS NOT EMPTY — this is the load-bearing fact for anyone continuing.** It already serves the team's live `data365dashboard.uz` via nginx, with two PM2 apps (`kampaniyalar-api` on 4000, `kampaniyalar-web` on 3000). The owner chose SIDE-BY-SIDE: their site must not stop for a second. So we do NOT install Coolify (it would seize 80/443). Our app runs as a plain container on `127.0.0.1:3100` and the EXISTING nginx proxies `data365.duckdns.org` to it. Verified after adding our site: their host still answers 301, ours answers 502 (correct — our app is not up yet), and `nginx -t` passed before every reload.

**Owner's four decisions (do not re-litigate):** side-by-side · videos stay in Cloudflare R2 (team's own account) · team's own Gemini key · keep the domain `data365.duckdns.org` so already-shared links keep working.

**Done and PROVEN so far:**
- Key auth installed; 4 GB swap added (the box had none, and ffmpeg encoding is memory-hungry).
- Docker + compose installed. Their PM2 apps re-checked after the install: still online.
- MySQL 8 container on `127.0.0.1:3307` only, passwords generated on the server (`/opt/data365/.db.env`, chmod 600). **First attempt crash-looped** — `mysql:8` now resolves to 8.4, which REMOVED `default-authentication-plugin`; the old host runs 8.4.10 without that flag. Fixed by dropping the flag and wiping the half-initialised data dir.
- **Database migrated and verified by recount on BOTH hosts: videos 22 · users 3 · orgs 1 · comments 3 · tables 38 — identical.**
- App source shipped as `git archive` of the exact deployed commit `5c9a52d` (no git credentials ever left this machine); image building on the server.
- `app.env` assembled: 20 settings carried verbatim from the old host — **`DATABASE_ENCRYPTION_KEY` is among them and MUST stay byte-identical or every saved user API key becomes undecryptable** — plus the new R2 credentials and a new `DATABASE_URL`. Coolify-specific vars dropped.

**R2: the accounts are DIFFERENT, so the videos really do have to move.** Old account `f2efd485…` bucket `ustoz-videos`; new account `936c337e…` bucket **`meetapp`** (the owner named it that). Measured before starting: **142 objects, 5.06 GB, largest single object 908 MB** — the `0.49 GB` in `MIGRATION_REQUIREMENTS.md` is stale by 10x and should be corrected. The copy runs ON the new server (datacenter link, not a home connection), is resumable (an object already present at identical size is skipped), never writes to the source, and finishes by RE-LISTING the destination to prove object count and byte totals match. The owner asked whether Cloudflare's own Super Slurper would be easier — a fair question; it is the better tool for bulk, but it needs him in the dashboard pasting the old account's keys, whereas this needs nothing from him. Super Slurper stays the fallback if the copy stalls.
- The R2 token he created is **Object Read & Write**, so it deliberately CANNOT create buckets — he created `meetapp` by hand. Write/read/delete were probed live before the copy started.

**✅ THE NEW SERVER IS FULLY RUNNING AND PROVEN (2026-08-12), everything except the DNS click:**
- App container `data365-web:5c9a52d` on `127.0.0.1:3100`; `/api/health` → **`db:ok storage:ok`** (so it reached BOTH the migrated database and the new bucket).
- Through the existing nginx with a `Host:` header: login page **200**, health **200**, home **307** (the anonymous redirect, as expected). Their `data365dashboard.uz` still answers **301** — unaffected, re-checked after every change.
- **Videos: 142 objects / 5,308,214,016 bytes on BOTH sides — missing 0, size mismatch 0, failed 0.** One large object timed out on the first pass; the script's resume skipped the other 141 and fetched only that one.
- **End-to-end proof that storage really moved:** `/api/playlist?videoType=mp4` on the new host redirects to `936c337e….r2.cloudflarestorage.com/meetapp/…/result.mp4` — the NEW account and bucket — and a ranged request returned **HTTP 206, `video/mp4`, 1 MB**. A real video streams from the new storage.
- certbot already installed, so TLS is one command once DNS points here. Disk after everything: 19 GB used of 97 GB.

**🧹 STORAGE CLEANED, and the owner's suspicion was right.** He asked why 142 objects existed when the site shows far fewer recordings. Measured rather than assumed: the bucket held THREE different kinds of thing — video files under two owner prefixes (`25s3fqp7e7vc5p0` 102, `khc8kfjxtw7s7fk` 7), **30 daily database backups under `db-backups/` (126 MB)**, and a few site assets (`organizations/`, `users/`) plus one `_deploytest` stray. My first pass mis-parsed the backups as "orphan video folders" — corrected by dumping the real key shapes before touching anything.
- **41 objects / 1.44 GB belonged to videos deleted from the site** (20 video folders; the DB holds 14 soft-deleted rows, the rest were hard-deleted). Removed at his explicit instruction ("saytda borlarigina qolsin").
- **Deliberately KEPT and stated rather than silently removed: the `db-backups/` daily dumps.** Deleting backups on migration day is the wrong trade; they are 126 MB.
- After: **101 objects / 3.62 GB**, keep-set verified intact by re-listing.
- **Then every one of the 22 live videos was requested end-to-end through the new host: 22 playable, 0 problems.** Nothing was deleted from the OLD bucket, so any of this is recoverable.

**✅✅ CUTOVER DONE 2026-08-12 — the owner switched the duckdns IP and the site is LIVE on the team's server.**
- DNS resolves `data365.duckdns.org` → `169.58.86.149`. TLS issued by certbot (`--redirect`, so HTTP forwards to HTTPS).
- From the public internet: `/api/health` **200** with valid TLS and `db:ok storage:ok`; `/login` **200**; a share page **200**.
- **Final proof, all 22 live videos requested over public HTTPS — share page AND a ranged media fetch each: 22 ok, 0 problems.**
- Nightly DB backup ported (`/root/backup-db.sh`, container names re-pointed to `data365-db` / `data365-web`), test run uploaded `db-backups/capdb-2026-08-12.sql.gz` to the new bucket, cron installed at 22:00 with the same 30-day retention.
- `data365dashboard.uz` still answers throughout — it was never interrupted.

**⚠️ ~~FINDING WORTH ACTING ON: nothing appears to call the app's own `/api/cron/*` routes.~~ RETRACTED 2026-08-13 — IT WAS FALSE, and it was hedged as needing verification for exactly this reason.** The missing caller was never *on* either host: **GitHub Actions has been calling both routes every 30 min since 2026-07-14** (`.github/workflows/recover-cron.yml`, repointed to `data365.duckdns.org` in `c950625`; the repo secret `CRON_SECRET` has existed since 2026-07-01). Proof, from the last green run before cutover (`31583843043`, 2026-08-12 09:38 UTC): `recover-stale-ai-jobs` → **HTTP 200** `{"retried":0,"gaveUp":0,"skippedForBatch":0,…}` and `poll-batch-jobs` → **HTTP 200** `{"pending":0,"succeeded":0,…}`. So the recovery + batch-collector machinery HAS run in production all along — the app simply does not log those hits, which is what made the old-log search look conclusive. **The `purge-trashed-videos` half of the finding still stands** (no workflow scheduled it until `e2459aa` on main), and that alone explains the 1.44 GB of orphans. General lesson: an absent log line is not an absent caller — check every scheduler, including the ones outside the box.

**🧩 BROWSER EXTENSION: NO REINSTALL NEEDED — verified, not assumed.** Because the domain never changed, the extension keeps working:
- The served package at `/365-extension.zip` is **200, application/zip, 543,806 bytes, manifest version 0.5.9** — the current build; its baked-in server URL is `https://data365.duckdns.org` and `externally_connectable` still lists exactly that host, so page→extension sign-in is intact.
- Every endpoint it calls answers correctly on the new host: `/api/desktop/video/create`, `/api/upload/multipart/{initiate,presign-part}`, `/api/upload/recording-complete` all **401** (present and demanding auth — not 404, not 502); `/api/extension/me` 401; `/api/extension/mint-key` 405 for GET (it is POST-only).
- `host_permissions: https://*/*` means the new R2 endpoint (`936c337e….r2.cloudflarestorage.com`) is reachable for presigned multipart uploads without a manifest change.
- **NOT verified and it needs a human: an actual record → upload → appears-on-site run.** That requires a logged-in browser, which is the one thing this session cannot do.

**🔎 WHY THE DELETED VIDEOS' FILES WERE STILL IN STORAGE — answered with evidence, and it is a real defect, not a design choice.** Deleting a video soft-deletes it into a trash; `app/api/cron/purge-trashed-videos` is meant to permanently erase anything trashed more than **7 days** ago (`TRASH_RETENTION_MS`), storage FIRST then the row, reusing the same ownership-checked `permanentlyDelete` the user-facing route uses. The code is correct. **Nothing ever called it.** Three independent confirmations: the old root crontab held ONLY the DB backup; **Coolify's `scheduled_tasks` table has 0 rows**; and 48h of old app logs show zero `/api/cron/` hits. So the trash was never emptied — that is the 1.44 GB. (**Corrected 2026-08-13:** the trailing claim "the same missing trigger is why the stale-job recovery never ran either" was WRONG — GitHub Actions was calling the recovery and batch routes every 30 min since 2026-07-14; see the retraction above. Only the purge had no caller.)

**✅ BOTH CRONS NOW WIRED, at the owner's explicit yes to each.** `/root/run-cron.sh <route>` reads `CRON_SECRET` from the running container at call time (so rotating the secret needs no edit) and calls the route over localhost. Schedule: `recover-stale-ai-jobs` every 30 min, `purge-trashed-videos` at 03:15, DB backup at 22:00. **Both were run once by hand first and reported cleanly:** purge `{purged:0, remaining:0, cutoff:2026-08-05}` — the 14 soft-deleted rows are newer than the 7-day window and will age out on their own; recovery `{retried:0, gaveUp:0}` — nothing stale. Note the recovery cron had never run in production before today, so watch its first days.

**STILL OUTSTANDING:**
1. **The PAID Gemini key.** The key he supplied is the FREE one (tested live: HTTP 200 on both `gemini-3.5-flash` and `gemini-3-flash-preview`). Until a paid key exists, cheap mode has no paid fallback, so analysis stops after the daily free allowance (~20 requests per model per day ≈ one short recording).
2. **TLS.** Certbot cannot issue until DNS points here (HTTP-01), so the cert is a cutover-time step.
3. **The cutover itself is the owner's one click:** change the IP on `duckdns.org` to `169.58.86.149`. Nothing is deleted from the old server; if anything looks wrong he points the IP back and the old host answers again immediately.

---


> _Older round logs and dated narrative moved to `docs/STATE_ARCHIVE.md` on 2026-08-13 to keep this board loadable. Nothing was deleted._

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
- **Server:** Contabo VPS managed by **Coolify** (UI at `http://<CONTABO_IP>:8000`). NOT Railway — Railway is gone.
- **DB:** MySQL inside Coolify. **Not reachable from the dev machine** (`connect ETIMEDOUT` from outside, measured 2026-07-20) — so local QA of authed pages is impossible; QA on the live site instead.
- **Storage:** Cloudflare R2. **Backups:** R2 `db-backups/`, the authoritative series is `capdb-*.sql.gz` written by the VPS cron `/root/backup-db.sh` (source in `deploy/server/`). The GitHub `db-backup.yml` series (`data365-*.sql.gz`) points at the deleted Railway DB — ignore it.
- **Repo:** GitHub `mirkomilovabrorwork-dot/ustoz-github`. Work branch **`qa-fixes`**; scheduled jobs only run from **`main`** (GitHub only schedules from the default branch).
- **Deployed:** commit `4cc00ca` (extension v0.5.0), Coolify deployment `ojy2hnhrpsp9noaxyvr2k2ow`. `NEXT_PUBLIC_USD_TO_UZS=12000` is a BUILD-TIME var and is baked into the deployed image.
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
