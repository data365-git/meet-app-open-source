# LIVE TEST PLAN — Ustoz / data365 (handover to internal IT team)

_Plan by Fable (independent); finalized by the main session as THE production-readiness gate, 2026-07-22._
_Target build: commit **`201165f`** (extension **v0.5.3**, the 2nd-recording remote-voice fix), deploying to **https://data365.duckdns.org**. Run every `[MACHINE]` test ONLY AFTER the deploy lands — precondition: `docker ps` image tag = `201165f`, `/api/health` ok, served zip = **0.5.3**. Testing during the build is invalid._
_This is the FINAL "big check" before the project is called production-ready for the internal IT team. Process: plan → **Fable approves the plan** → agents execute → main-session review → **Fable approves the results** → owner-device gate (O7 + O7b). Also serves handover Phase 2 (`docs/plans/2026-07-22-handover-to-team-plan.md`)._

---

## 0. How to read and run this plan

Every test has:
- **ID** — stable handle (e.g. `G1`, `P3`).
- **TAG** — `[MACHINE]` = a coding agent can run it fully (drive a browser, curl an API, read prod DB via a server-minted session). `[OWNER]` = needs the owner's real device / a real second human / a real Google Meet / phone playback — no headless agent can do it. A few are `[MACHINE+OWNER]` (machine does a proxy, owner confirms the real thing).
- **STEPS** — exact URL / button / command.
- **EXPECTED** — what a pass looks like.
- **BROKEN** — what failure/regression looks like, so the executor files a defect instead of guessing.

**Definition of DONE this plan verifies** (owner's words, H2): (a) post-recording AI results — summary/chapters/action-items/chat — flawless and error-free; (b) meetings captured accurately, no drops, remote voices present; (c) no money waste, no malfunction; (d) transcript timestamp accuracy (free path, ~5–10s); (e) robust across empty/loading/error states, mobile + light/dark.

**Client = the owner's INTERNAL IT team only.** OUT OF SCOPE, do NOT write or run tests for: domain purchase, transactional email, billing/payments/Stripe checkout, multi-tenant hardening, external-customer onboarding, the requester "we'll contact you" sales-lead dashboard, SEO. If a flow only matters to those, skip it.

### 0.1 Hard constraints (bake into every step)

1. **Prod MySQL is NOT reachable from the dev machine** (`connect ETIMEDOUT`, measured repeatedly). You cannot query prod DB directly. Two sanctioned ways in:
   - **Authed web pages** → mint a server-side session (recipe §1.2). Setting the cookie in the built-in Browser pane is blocked by the safety classifier; use `curl -b` + HTML inspection, or have the owner walk the UI.
   - **Reading prod DB** → run `mysql` INSIDE the MySQL container over SSH (recipe §1.3). Read-only SELECTs only.
2. **Cost discipline — QA is READ-ONLY wherever possible.** Verifying AI results means READING already-generated summaries/chapters/chat, NOT triggering new paid Gemini runs. Any step that spends money is tagged **💰 BUDGETED** and must be run **ONCE, never looped**, and only after an explicit owner budget check. The whole timestamp/drift section (Flow T) and the model-eval are the only paid steps; everything else must cost $0.
3. **No unsafe real-world actions.** No real account deletion on a real user, no real payments, no *destructive* DB writes on prod (never UPDATE/DELETE an existing prod row). Never type the owner's password anywhere.
   - **SANCTIONED QA WRITES (the ONLY writes allowed).** A few tests (A2 disposable signup, M-DEL disposable user+recording, C3 seed `ai_chat_usage` row, G7 guest comment) legitimately need QA-owned throwaway rows. Rule: create ONLY brand-new QA-owned rows (never touch real users' data), record every id/key you create in the evidence file, and DELETE them in the SAME session. This supersedes the "create no QA data / SELECTs only" wording where a test explicitly calls for it; everywhere else stays read-only.
4. **Never claim "done" without a LIVE check** on the deployed build. Screenshot / capture the HTTP response as evidence. Dev-clean ≠ prod-clean.

### 0.2 Budget gate (must pass before ANY 💰 step)

Before running a 💰 step, STOP and confirm with the owner in one line: which video, how many paid calls, estimated cost. The paid pipeline on a 53-min video is ~$0.19–0.22 per re-transcribe (measured). One re-transcribe of `fm3pz7yref328m7` is the only pre-approved paid QA in this plan, and only per the ladder in Flow T. Do not re-run to "double-check" — the discipline (adopted 2026-07-21) is: never re-run the PAID pipeline to verify a change; use the free key / a cached fixture / a mocked response.

---

## 1. Environment, access recipes, and evidence (read before Phase 2)

### 1.1 Liveness (run first, every session) `[MACHINE]`
```
curl -s https://data365.duckdns.org/api/health
```
EXPECTED: `{"status":"ok","checks":{"db":"ok","storage":"ok"}, ...}`. If not ok, the app is down — STOP, this is an outage (RUNBOOK §3), not a test failure.
Confirmed live 2026-07-22: `status ok, db ok, storage ok`.

### 1.2 Server-minted session for authed pages `[MACHINE]`
Full recipe: `docs/qa/SESSION_INJECTION_NOTES.md`. Summary:
```bash
C=$(ssh -i ~/.ssh/hetzner_ustoz root@169.58.12.255 "docker ps --format '{{.Names}}' | grep '^pokroz' | head -1")   # app container name CHANGES per deploy
# copy docs/qa/mint-jwe.js into the container, then:
docker exec $C node /tmp/mint-jwe.js '{"id":"qa0pool0loop000","email":"qa.pool.loop@data365-test.uz","name":"QA Pool","isAdmin":false,"sessionVersion":0}'
# -> prints a JWE. Then:
curl -b "next-auth.session-token=<jwe>" https://data365.duckdns.org/dashboard/caps
```
- **`sessionVersion` MUST equal the DB `users.authSessionVersion` for that user.** For `qa0pool0loop000` it is **0** (not 1); a wrong value silently 307s to /login and looks like "auth broken".
- The existing prod test user `qa0pool0loop000` is **isAdmin 0** — use it as the **non-admin member** subject. To test an **admin** view, mint with `"isAdmin":true` and one of the admin user ids (`25s3fqp7e7vc5p0` admin@ustoz.uz). Do NOT mint the owner's personal account.
- ⚠️ A real user row must exist for pages to render (server components hit the DB). Do not invent ids.
- **Cleanup:** delete the mint script from container `/tmp` (`-u root`) and host afterwards. Create no QA users/videos/sessions on prod.

### 1.3 Read-only prod DB (for evidence) `[MACHINE]`
RUNBOOK §3b. The MySQL container name is FIXED (`fot1zbunh8jld7l4k67h2zp4`); password is already in its env:
```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.12.255 'docker exec fot1zbunh8jld7l4k67h2zp4 sh -c "mysql -umysql -p\$MYSQL_PASSWORD capdb -e \"<SELECT ...>\" 2>/dev/null"'
```
Use for: reading `ai_usage_events` (cost accounting), `videos.transcriptionStatus`, `ai_chat_usage`, confirming a signup created NO `organizationMembers` row. **SELECTs only. Never UPDATE/DELETE on prod.**

### 1.4 The drift rig (timestamp accuracy) `[MACHINE, read-only]`
`scripts/measure-transcript-drift.mjs` + `scripts/drift-fetch.mjs` run INSIDE the app container (they need ffmpeg + GEMINI key + R2 creds that live there). They READ result.mp4 + transcription.vtt, cut 20s ground-truth clips, transcribe those clips, and locate them in the VTT. **Reading existing VTTs is $0.** Cutting+transcribing the ground-truth clips costs a few cents of Gemini — tag Flow T as 💰. The rig prints `±stderr` and `weakest_match`; **a difference smaller than ~2 SE is not a result** — do not report one.

### 1.5 Evidence rules
- Every `[MACHINE]` test must save proof: the HTTP status + relevant response body/headers, or a Browser-pane screenshot at 375px AND desktop, in both light and dark where UI is involved.
- Put evidence under `docs/qa/run-<date>/` with the test ID in the filename.
- A test with no saved evidence is UNVERIFIED, not passed.

---

# ===================== MACHINE-EXECUTABLE (Phase 2 agents do this) =====================

Ranked so the highest-risk flows run first. Each section names the routes/files an executor needs.

## Flow A — Anonymous / Guest (share page `/s/<id>`)
Route: `apps/web/app/s/[videoId]/page.tsx` + `Share.tsx`. Guests can WATCH + AI CHAT (capped), comment; they CANNOT record or trigger paid AI analysis.

**Pick a real share id first:** query prod DB (`SELECT id FROM videos WHERE deletedAt IS NULL AND transcriptionStatus='COMPLETE' LIMIT 5;`) for a video that HAS a transcript+summary, so the AI tabs are populated. Record the id used in evidence.

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **G1** | `[MACHINE]` | Open `https://data365.duckdns.org/s/<realId>` in the Browser pane (logged OUT / fresh profile). | Page 200; video player renders; tabs present (Transcript / Summary / Chapters / Activity/comments). No login wall. | Blank page, 500, forced login, player missing. |
| **G2** | `[MACHINE]` | With the player loaded, press play; read `read_network_requests` for the media fetch. | Media request returns **206 Partial Content**; video actually plays. | 403/404 on media, infinite spinner, "video unavailable". (One CLEAN tab only — heavy multi-probe poisons the connection pool and fakes a "stuck" bug. [[feedback_clean_env_before_live_bug]]) |
| **G3** | `[MACHINE]` | Read the Summary + Chapters + Transcript tabs of a COMPLETE video. | Each is non-empty, coherent, in the recording's language (uz/ru). Chapters have timestamps that map to points in the video. | Empty tab on a COMPLETE video, English on an uz recording, obviously hallucinated text, "undefined". |
| **G4** | `[MACHINE]` | Resize to **375px** (mobile). Scroll the whole page. | No horizontal overflow; player, tabs, comment box, AI-chat popup all fit within 375px. | Body scrolls sideways; popup wider than viewport; controls clipped. |
| **G5** | `[MACHINE]` | Toggle light and dark (the app `theme` cookie / `resize_window colorScheme`). | Both themes readable — text contrast fine, no invisible-on-invisible, the old `.ai-aura` glow absent. | Dark text on dark bg, broken colors, unstyled flash. |
| **G6** | `[MACHINE]` | Open the AI-chat popup (button "Uchrashuv haqida so'rang…"), send ONE question about the meeting. | Popup opens; a streamed answer returns citing `[mm:ss]` timestamps, in the question's language. (This spends a trivial guest-chat call — allowed, it's the feature under test; do NOT loop it.) | Popup won't open, no response, error toast, wrong language, answer ignores the transcript. |
| **G7** | `[MACHINE]` | Post a comment as guest (if comment box is present for anon). | Comment posts and appears in Activity, OR a clear "sign in to comment" state — whichever the product intends. | Silent failure, 500, comment lost on reload. |
| **G8** | `[MACHINE]` | Confirm the guest CANNOT trigger paid analysis: there is no "Generate/Analyze/Re-transcribe" button visible to an anon viewer; curl `POST /api/videos/<id>/generate` with NO auth cookie. | UI shows no paid-AI control to a guest; the API returns 401/403 (not a Gemini spend). | A visible Generate button for anon, or the API 200s and spends money. |

## Flow B — Auth: login / signup / requester
Files: `actions/auth/signup.ts`, `app/(org)/login`, `app/(org)/signup`, dashboard gate `app/(org)/dashboard/layout.tsx:67` (`organizationSelect.length === 0 && !isAdmin` → `<PendingAccess/>`).

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **A1** | `[MACHINE]` | GET `/login` and `/signup`. | Both 200, render forms (email/password), light+dark, 375px clean. | 404/500, broken form, overflow. Confirmed 200 live 2026-07-22. |
| **A2** | `[MACHINE]` | **Signup creates a Requester with NO org and CANNOT record.** Do NOT use the browser form (no password entry by the agent). Exercise the server action / signup endpoint programmatically with a disposable email, then query prod DB: `SELECT * FROM organizationMembers WHERE userId=<newId>;`. | The new user has **ZERO `organizationMembers` rows** (C2 fix, `signup.ts:120`). No default-org membership was created. | Any `organizationMembers` row for a fresh signup = the C2 regression (every stranger becomes a member). **Cleanup: delete the disposable user row after.** |
| **A3** | `[MACHINE]` | Mint a session for a NO-ORG user (or the disposable signup) and GET `/dashboard`. | Renders `<PendingAccess/>` — the friendly "we'll contact you" screen. It stores nothing and offers no record/upload control. | A dead-end/500, OR the full dashboard (means a requester wrongly became a member). |
| **A4** | `[MACHINE]` | As the NO-ORG user, curl `POST /api/videos/<id>/generate` and the upload-init route. | 403/401 — a requester cannot record or spend AI. | 200 / a usable record path for a no-org user. |
| **A5** | `[MACHINE]` | Mint a session with an empty `name` (or a user whose name is empty) and GET `/dashboard`. | 307 → `/onboarding/welcome` (layout.tsx:33). | Dashboard renders with no name, or a crash. |

## Flow M — Member (full product, authed via §1.2)
Use `qa0pool0loop000` (non-admin member) for member views; mint an admin session for admin-only views. All routes under `app/(org)/dashboard/*`.
⚠️ **Authed dashboard pages canNOT be rendered at 375px/dark in the Browser pane** (a session cookie can't be set there per §1.1; curl doesn't render). So M2/M6 do **HTML-level** checks (structure + empty-state present in the returned HTML); the real 375px+dark *visual* pass on authed pages is deferred to the owner's phone (a `/dashboard` dark walk is added to Flow O). DONE-(e) for authed pages rests there, not on a machine.

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **M1** | `[MACHINE]` | `curl -b <session>` each: `/dashboard`, `/dashboard/caps`, `/dashboard/meetings`, `/dashboard/extension`, `/dashboard/settings/account`, `/dashboard/settings/organization`, `/dashboard/analytics`, `/dashboard/billing/ai-spend`. | Each 200 for the appropriate role. (All previously 200 via session-injection 2026-07-20.) | Any 500 / 307-to-login with a valid session / crash. |
| **M2** | `[MACHINE]` | `/dashboard/caps` (recordings list) and `/dashboard/meetings`. Inspect HTML. | Recordings/meetings list renders; each row shows name + duration + status. Empty account shows a calm empty-state, not a blank white screen. | Blank white (B3 was: meetings had no loading state — verify `meetings/loading.tsx` now exists and a skeleton shows). |
| **M3** | `[MACHINE]` | `/dashboard/extension`: read the download link. | Points to `/365-extension.zip`; the zip downloads (206/200, `application/zip`, ~472 KB) and its `manifest.json` reads **version 0.5.3** (the deployed recording fix). | Missing/broken link, wrong version (still 0.5.2 = deploy didn't land), 404 zip. |
| **M4** | `[MACHINE]` | `/dashboard/billing/ai-spend` as a **non-admin** member (mint non-admin session). | Redirects to `/dashboard` — AI spend is admin/org-settings only (`ai-spend/page.tsx:23`). | Non-admin sees org spend figures. |
| **M5** | `[MACHINE]` | `/dashboard/billing/ai-spend` as an **admin**. | Renders org AI spend (month total, per-video). | 500, empty, or wrong numbers vs `ai_usage_events` SUM. |
| **M6** | `[MACHINE]` | `/dashboard/analytics` as a member. | Renders; empty/loading/populated states all sane at 375px + dark. | Overflow, crash, permanent spinner. |
| **M-DEL** | `[MACHINE, CODE-READ + disposable only]` | **Account deletion cascade — DO NOT delete a real account.** Read `actions/account/delete-account.ts`: confirm (a) it requires the typed phrase **`delete my all data`** (`:29`, rejects anything else `:37`), (b) the final `db().transaction()` is wrapped in try/catch (C1 fix), (c) it purges `ai_usage_events` for sole-member orgs before the org row, and the erasure inventories recordings/storage/transcripts/AI/comments/analytics/API keys — not just the user row. To exercise live, create a **disposable** user + a throwaway recording, then run the delete action for THAT user only, then DB-verify every table is purged. | Phrase gate present; cascade wipes all owned data; no permanent-stuck state on FK failure. | Wrong phrase accepted; storage purged but org-delete FK-fails and every retry re-fails (the C1 stuck-state); any table left with orphan rows for the deleted user. |
| **M7** | `[MACHINE]` | `/dashboard/settings/organization` as admin: read member list / roles. | Renders; roles shown; no crash. | 500, leaks another org's data. |

## Flow P — AI post-processing pipeline (READ existing results, $0)
Files: `workflows/transcribe.ts`, `workflows/generate-ai.ts` (schema: `overview`, `topics`, `nextSteps`, `tasks[{title,assignee,priority,deadline,category}]`, `chapters[{startSec,title,body}]`, `refinedTranscript`). Verify on **already-COMPLETE** videos — never trigger a new run to test. ⚠️ **P1–P4 read results generated by the OLD build** (they are stored) — a green here does NOT prove the pipeline works on the new deploy `201165f`; fresh-pipeline proof comes only from O8 (real meeting) and T1 (the one budgeted re-transcribe). Do not quote a P-green as "pipeline works on the new build".

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **P0 (no survivorship bias)** | `[MACHINE]` | DB: count COMPLETE videos WITH a null/placeholder `aiSummary`, and count `transcriptionStatus='ERROR'` videos, vs total. P1 samples only successes — this measures the miss rate. | Low miss/ERROR rate. | A high proportion of COMPLETE videos with null/placeholder summaries, or many ERROR videos → FAILS DONE-(a) even if the 3 sampled read beautifully. |
| **P1** | `[MACHINE]` | Pick 3 COMPLETE videos (DB: `transcriptionStatus='COMPLETE'` with a non-null `metadata.aiSummary`). For each, open `/s/<id>` and read Summary. | `overview` non-empty, coherent, correct language, not the placeholder "The AI was unable to generate a proper summary". | Empty overview, the failure placeholder, wrong language, hallucinated content unrelated to the audio. |
| **P2** | `[MACHINE]` | Same videos: read **Chapters**. | ≥1 chapter, each with a title + `startSec` that lands on a real point in the video. Titles describe real content. | Zero chapters on a long video, chapters at 0s only, generic filler titles. |
| **P3** | `[MACHINE]` | Same videos: read **action items / tasks** (`aiSummary.tasks`) and nextSteps. | Tasks present where the meeting has them; each has a title; priority/category valid enum values. (Absence is OK if the meeting genuinely had no tasks — judge against the transcript.) | Malformed tasks, `undefined` fields, tasks invented with no transcript basis. |
| **P4** | `[MACHINE]` | Read the **Transcript** tab (raw "Matn") and the refined transcript. | Non-empty, matches the audio language, readable paragraphs; refined chapters mirror `aiSummary.chapters`. | Empty, garbled, wrong language, mojibake in uz/ru script (there is a `restore-russian-script.ts` guard — confirm it's not mangling). |
| **P5** | `[MACHINE]` | DB: `SELECT operation, model, COUNT(*) FROM ai_usage_events WHERE videoId='<id>' GROUP BY 1,2;` for a COMPLETE video. | transcription + summary rows exist; model is `gemini-3-flash-preview` (kept over 3.5-lite for uz accuracy). Each step accounted once, no runaway duplicates. | Dozens of retries for one step (waste), or missing accounting rows (H5 under-reporting). |
| **P6** | `[MACHINE]` | Find a video with `transcriptionStatus='ERROR'` if any exists; open `/s/<id>`. | Share page shows the correct message via `transcription-error-message.ts`: owner sees `aiTranscriptionQuotaFailed` ("recording safe, account needs topping up"), public viewer sees the calm `...Public` variant; a real FAILED (non-quota) shows `aiTranscriptionFailed`. | Generic error, raw stack, or a broken player with no explanation. |
| **P7** | `[MACHINE]` | Confirm the pipeline distinguishes **QUOTA vs FAILED**: read `get-status.ts` returns `transcriptionErrorCode`; DB `videos` carries it. | QUOTA errors are re-kicked by `recover-stale-ai-jobs` with backoff (`quotaRetryNextAt`); FAILED are not looped. | QUOTA treated as terminal (never self-recovers) or FAILED retried forever (waste). |

## Flow C — AI chat + rate limit
Route: `app/api/video/ai/chat/route.ts`. Caps: `DAILY_CHAT_LIMIT=20` per (video, client, dateUtc) in `ai_chat_usage`; `GUEST_VIDEO_DAILY_CHAT_LIMIT=200` per-video across all guests; per-minute limiter 20/60s keyed by `videoId:ip`.

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **C1** | `[MACHINE]` | Guest (no cookie) POST one chat message to a COMPLETE video. | 200 SSE stream; a `Set-Cookie: ai_chat_cid=...` is issued; answer cites timestamps. | 500, no answer, no cookie (would let count reset every request). |
| **C2** | `[MACHINE]` | Member (session cookie) POST one chat message. | 200; usage keyed by `users.id`, NOT counted toward the guest per-video total. | Member counted as guest, or member blocked. |
| **C3** | `[MACHINE, careful]` | **Rate-limit at the cap.** Do NOT spend 21 real Gemini calls. Prefer DB-seed: insert an `ai_chat_usage` row for a throwaway `(videoId, guestClientId, today)` with `requestCount=20`, then send ONE more with that cookie. | The 21st returns **HTTP 429** with `{code:"daily_limit"}` (`isOverDailyChatLimit`, `>20`). | 429 never fires (cost cap broken) or fires too early (<20). **Cleanup: delete the seeded row.** |
| **C4** | `[MACHINE, $0 — pin the target]` | Per-minute burst limiter. To keep it **$0**, burst against a video with **NO transcript** (the transcript-missing guard at `chat/route.ts:319` precedes any paid Gemini call), OR assert via the `isRateLimited` unit test. **Do NOT burst a COMPLETE video** — that spends ~20 real Gemini calls. | 21st request within the 60s window → 429 "Rate limit exceeded". | No throttle → a guest can drain budget in a burst. |
| **C5** | `[MACHINE]` | Chat on a video with NO transcript. | Graceful "transcript is missing/empty" message, `[DONE]`, no crash, no paid call wasted. | 500, hang, or a Gemini call on empty context. |

## Flow K — Cost / no-waste (the "no money burned" guarantee)
Files: `lib/ai-cost-guard.ts` (`withCostGuard`, caps $100/org·mo, $20/video), `lib/permissions/ai-access.ts` (`canUseAI` = `users.isAdmin` only), `retry-transcription/route.ts`, `retry-ai/route.ts`.

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **K1** | `[MACHINE]` | Enumerate every route that can spend paid Gemini and confirm each has the `canUseAI` admin gate. curl each with a NON-admin member session: `POST /api/videos/<id>/generate`, `/continue-paid`, `/retry-ai`, `/api/video/ai/translate`. | All return **403 `ai_access_required`** for a non-admin. (Verified in code: all four gate at the top.) | Any 200 / spend for a non-admin → the AI-spend hole reopened. |
| **K1b** | `[MACHINE]` | `retry-transcription` also spends paid Gemini but is **deliberately NOT `canUseAI`-gated** — it is a member flow guarded by video **OWNERSHIP + confirm** (K2), not admin-only. Probe `POST /api/videos/<id>/retry-transcription` with a **non-owner** member session. | **403** on ownership (the caller doesn't own the video). Confirm this is the intended model (any owner may re-transcribe their own video with confirm), not an ungated spend. | A non-owner can trigger a re-transcribe → cross-account paid spend. |
| **K2** | `[MACHINE]` | **Re-transcribe guard.** curl `POST /api/videos/<id>/retry-transcription` with **no** `{confirm:true}` body. ⚠️ Mint the **video OWNER's** session (a non-owner gets 403 on ownership and never reaches the 409 under test — that would be a confusing non-answer). | **HTTP 409** "already has a transcript … pass confirm to re-run (costs money)" (`retry-transcription/route.ts:52`). Nothing deleted, no spend. | 200 / it deletes the transcript and re-spends without confirm (A1 regression). Do NOT pass confirm:true in QA — that would spend money. |
| **K3** | `[MACHINE]` | **Budget cap is a hard cap.** Code-verify `withCostGuard` throws `BudgetExceededError` at `$100/org·mo` and `$20/video`; DB-check no video's `ai_usage_events` SUM exceeds $20. | Caps enforced; no video over $20; org month under $100. | A video's spend blew past $20 with no stop (runaway). |
| **K4** | `[MACHINE]` | **Quota-exhausted parks gracefully, doesn't burn 30s probes per chunk.** Read `workflows/transcribe.ts` free-probe path + the HELD fix `docs/plans/2026-07-21-free-probe-skip-HELD.md`. Confirm current behavior: once the daily free ~20 is spent, does the code still burn a full `FREE_TRANSCRIBE_PROBE_MS` (30s) probe on every remaining chunk before paid fallback? | Document the ACTUAL behavior. Ideal: quota-exhausted signal is remembered and probing stops for the rest of the run. Known gap (STATE): the skip fix is HELD/unshipped — so today it likely still probes each chunk. **This is a finding to rank, not necessarily a pass.** | If it loops 30s probes × N chunks = latency waste (not $ waste, but malfunction). Flag severity. |
| **K5** | `[MACHINE]` | **Cost-accounting model literal (A2).** Read `withCostGuard` call sites: does the recorded `ai_usage_events.model` reflect the ACTUAL model used, or a hardcoded literal when the call falls back? | Recorded model = actual model (`result.modelUsed ?? options.model`). | Hardcoded model on a fallback → mispriced accounting. Confirm the A2 fix landed. |
| **K6** | `[MACHINE]` | DB sanity: `SELECT billingMonth, SUM(costUsdMicros)/1e6 FROM ai_usage_events GROUP BY 1;` | Monthly totals plausible (July ≈ $5.70 was ~90% one-time dev re-transcribes, per the 2026-07-21 audit — no structural waste). | A month spiking with no explanation → investigate for a loop. |

## Flow E — Error / robustness / security
Files: `utils/helpers.ts` (`getHeaders` CORS), `lib/server.ts` (Effect-API CORS allowlist), `proxy.ts` (frame-ancestors), `next.config.mjs` (security headers), `app/not-found.tsx`.

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **E1 (CORS, the B1 fix)** | `[MACHINE]` | `curl -D - -H "Origin: https://evil.example.com" https://data365.duckdns.org/api/thumbnail` and again with `-H "Origin: https://data365.duckdns.org"`. | Evil origin → **NO `Access-Control-Allow-Origin`**, no `...-Credentials`. Legit origin → `Access-Control-Allow-Origin: https://data365.duckdns.org` + `Access-Control-Allow-Credentials: true`. **CONFIRMED live 2026-07-22** (evil not echoed; legit echoed). | Evil origin reflected back with credentials = the CORS hole reopened (critical). |
| **E2** | `[MACHINE]` | Also probe an Effect-API route and a hono route with the evil Origin (the tree has 3 CORS mechanisms). | None reflect `evil.example.com` with credentials. cap.so/cap.link must NOT be in any live allowlist. | Any of the three echoes a non-allowlisted origin. |
| **E3 (security headers)** | `[MACHINE]` | `curl -D - https://data365.duckdns.org/` (and `/login`). | Present: CSP (`frame-ancestors 'self'`), HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`. `/login` frame-ancestors = `'self'` (the cap.so hardcode was fixed). | Missing headers, or `/login` still `frame-ancestors https://cap.so`. |
| **E4 (unknown route)** | `[MACHINE]` | GET `/dashboard`, `/some/random/path` logged out. | 307 → `/login` for protected; a clean 404/not-found for truly unknown. (`/dashboard` → 307 confirmed live.) | 500, blank, or a protected page rendering logged-out. |
| **E5 (nonexistent share)** | `[MACHINE]` | GET `/s/nonexistentid00`. | A clean "recording not found / unavailable" state. **⚠️ Live 2026-07-22 this returns HTTP 200** — verify the BODY shows a proper not-found UI, not a broken/empty player claiming success. | 200 with a broken player, no message, JS error, or a 500. **Flag if the 200 hides a bad empty state.** |
| **E6 (storageMissing)** | `[MACHINE]` | If a video has `storageMissing` set (reconcile cron), open `/s/<id>`. | A truthful "recording unavailable, contact admin" message (C3 fix), not a silent broken player. | Silent broken player. |
| **E7 (dashboard error boundaries)** | `[MACHINE]` | Trigger a client error on `/dashboard`, `/dashboard/caps`, `/dashboard/meetings` (e.g. force a thrown error in the Browser pane), or read the 3 `error.tsx` twins. | Localized (next-intl) error UI; raw `{error.stack}` shown only when NOT production (B4 fix). | English-only boundary leaking a raw stack to the user in prod. |
| **E8 (empty states)** | `[MACHINE]` | View caps/meetings/analytics for an account with zero recordings. | Calm empty-state copy, no blank screen, no crash. | Blank white, spinner-forever, "undefined". |
| **E9 (guest quota messaging on share)** | `[MACHINE]` | On a share page whose owner's Gemini is quota-exhausted, confirm the public message is the calm variant, owner sees the billing truth. | Audience-correct, 3-language. | Strangers told "account out of money". |
| **E10 (private video blocked for anon)** ⭐ | `[MACHINE]` | DB SELECT a **`public=false`** (non-public) video id. GET `/s/<id>` logged OUT. Then curl that id's API surfaces with NO auth: `POST /api/video/ai/chat`, the transcript + thumbnail endpoints. | Share page does NOT render player/transcript (gate/overlay/not-found), AND the APIs return 401/403 — the page policy alone is not proof, the APIs must enforce it too. | Anon sees an internal meeting's player/transcript/summary, or an API returns its content → internal recordings leak to anyone with a guessed id (critical for an IT-team tool). |
| **E11 (password gate)** | `[MACHINE]` | Find a `videos.password`-protected video if any exists; GET `/s/<id>` anon. | Password overlay shown; transcript/summary content ABSENT from the HTML (not merely CSS-hidden). | Content present in the HTML behind the overlay, or overlay bypassable. |

---

# ===================== 💰 BUDGETED — run ONCE, owner-approved (Phase 2, gated) =====================

## Flow T — Timestamp / transcript drift (free path, target ~5–10s)
**Every step here spends a few cents of Gemini and must pass the §0.2 budget gate first. Run the ladder IN ORDER, ONE re-transcription per step, keep whichever step actually helps.** Source of truth: STATE.md timing block + `docs/plans/2026-07-20-free-timing-ceiling-review.md`. Subject video: `fm3pz7yref328m7` (53 min, loud). Backup of its transcript: `/root/backup-fm3pz7yref328m7-*.vtt` — restore path is proven (`scripts/drift-restore.mjs`).

| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **T0 (calibrate the rig)** | `[MACHINE] 💰(tiny)` | Run the rig against a Scribe VTT whose true error is ~1–2s (the bbzt Scribe VTT) to find the instrument noise floor. | Reported error ≈ the rig's noise floor (~2–5s). Establishes what a "real" difference is. | Rig reports >5s on a known-good VTT → the rig is the limiter, calibrate before trusting any number. |
| **T1 (baseline / verify anchor fix)** | `[MACHINE] 💰 ONE re-transcribe` | Re-transcribe `fm3pz7yref328m7` as-is, then `node scripts/measure-transcript-drift.mjs fm3pz7yref328m7 12 20` (inside container, via drift-fetch). This also verifies the deployed anchor fix `13dfa48`, never measured end-to-end. | Report max/mean/signed drift ±SE. Last known: max 28.6s, mean 10.2s, signed −4.3s. | Systematic backward drift returns (signed ≪ 0), or max ≫ 28.6s. |
| **T2 (3-minute chunks)** | `[MACHINE] 💰 ONE re-transcribe` | Apply `docs/plans/2026-07-20-shorter-chunks-ready-to-apply.md` (two constants: `LONG_AUDIO_CHUNK_DURATION_SEC` 360→180), redeploy or run against the changed pipeline, re-measure. **Also time the run** — 3-at-a-time concurrency means 18 chunks = 6 waves vs 3. | Expected mean 5–7s, max 12–15s (the ≤15s / ~5–10s target). If NOT faster-worse, keep it. | No accuracy gain AND ~2× slower → revert. A difference < 2 SE vs T1 is NOT a result. |
| **T3 (retime port)** | `[MACHINE] 💰 ONE re-transcribe` | Port `warp4.mjs` → `apps/web/lib/vtt-retime.ts` per `docs/plans/recovered-retime-prototype/retime-spec.md` (the only step attacking leftover CURVATURE), re-measure. | Composed with T2, approaches ~3–5s. Keep if it beats T2 by > 2 SE. | No gain over T2 → don't ship the added complexity. |

**Honest caveat to carry:** for the fast multi-speaker CARD UI, even 3s drift lands on the wrong 4s card ~38% of the time (07-08 analysis). If the requirement is "highlighted card always right", no free transcript-side method gets there — only grid-warp or paid Scribe (`ELEVENLABS_API_KEY` is NOT set on prod; enabling is an owner decision, out of the free-path scope).

## Flow N — New Gemini model eval (price + power)
| ID | TAG | STEPS | EXPECTED | BROKEN |
|---|---|---|---|---|
| **N1** | `[MACHINE] 💰 budgeted, once per model** | On a 10-min uz clip, transcribe+summarize with each worthwhile new model, compare price + uz-name/term accuracy vs current `gemini-3-flash-preview`. (3.5-flash-lite already tested 2026-07-22: cheaper/faster but weaker on uz → keep current.) | A keep-or-switch verdict per model, with the accuracy evidence. | Switching to a cheaper model that regresses uz/ru script — do NOT switch on price alone. |

---

# ===================== OWNER-DEVICE ONLY (no machine can do these) =====================

These need a real laptop, a real Google Meet, a real second human/phone, real screen-share, and ears. The full owner script is `docs/OWNER_QA_SCRIPT.md` (Uzbek, one action per step). Machine-checkable PROXIES are noted so the agent proves everything up to the physical boundary.

| ID | TAG | OWNER STEP | MACHINE PROXY (agent does this part) |
|---|---|---|---|
| **O1 — extension install** | `[OWNER]` | data365.duckdns.org/dashboard/extension → download zip → `chrome://extensions` → remove old → Load unpacked → must read **0.5.3**. | Agent verifies the served zip is v0.5.3 and unzips to confirm the compiled in-page recorder ships the 2nd-recording fix (M3). |
| **O2 — ⭐ 3-min solo record** | `[OWNER]` | meet.google.com → instant meeting → "Record now" (or Ctrl+Shift+9) → **Entire Screen** → Share → talk 3 min → Stop → recording appears under Meetings, plays to the end, own voice audible, duration ~3 min. | Agent verifies the upload→Meetings→playback path on an EXISTING recording (G1/G2), and that `finalize`/upload accounting persists `storedBytes` (H5). Cannot do the real getDisplayMedia capture. |
| **O3 — Entire-Screen gate** | `[OWNER]` | Choose a Chrome **Tab** instead of Entire Screen → recording must REFUSE to start, warns to pick the full screen. | Agent verifies the gate exists in `inpage-recorder.ts` by code + extension vitest. |
| **O4 — pause truthfulness** | `[OWNER]` | Record → Pause → count aloud 15s → Resume → Stop → the counted audio is ABSENT and timer froze during pause. | Extension vitest on pause/resume acks. |
| **O5 — network-drop resilience** | `[OWNER]` | Record → kill Wi-Fi mid-record → talk 30s → Stop → close Chrome fully → reconnect → recording self-recovers, includes the offline 30s. | Agent verifies upload retry/dead-letter + 2s buffer persist + crash-recovery in code + vitest; cannot pull a real cable. |
| **O6 — permanent discard** | `[OWNER]` | Short record → Permanently discard → confirm → not in dashboard; popup shows "Deleted" or "Delete queued", never a dead share link. | Agent verifies the discard terminal-state fix (`d15aebf`) by vitest. |
| **O7 — ⭐⭐ #1 REQUIREMENT: remote voice** | `[OWNER]` | 2-person real Meet → the other person says a distinctive phrase ("olma daraxti to'qqiz") → record 2 min via Record now → Entire Screen → Stop → in the recording the OTHER person's phrase is clearly audible. | **No machine proxy exists** — this is THE gate. Agent can only confirm the source-swap/captureStream tapping logic + the −16.6 dB e2e-audio-proof harness ran PASS in dev. Real remote voice on a real call = owner only. |
| **O7b — ⭐ THE 2026-07-22 FIX: second recording on the same call** | `[OWNER]` | After O7's recording, WITHOUT leaving the Meet, press **"Hozir yozish"** and record AGAIN ~1 min while the other person speaks a NEW distinctive phrase. Stop. **BOTH** recordings under Meetings must contain the other person's voice, and the SECOND must start with **NO "Mijoz ovozi olinmadi"** dialog. | **Machine PROOF ALREADY DONE (v0.5.3):** the e2e `PROOF_SECOND` ran **RED (bug reproduced) → GREEN (fixed)** in a real headed browser, plus a unit RED→GREEN and an independent Fable review. This owner run is the real-2-person-call confirmation of that exact fix. |
| **O8 — transcript/summary on a real meeting** | `[OWNER+MACHINE]` | After O7, wait for AI → owner confirms summary/chapters/tasks describe the real conversation, right language. | Agent then reads that video's AI results (Flow P) and DB accounting (P5) as evidence. |

---

## Test index & counts

| Section | Machine | Owner / Owner+Machine | Notes |
|---|---|---|---|
| A Guest | 8 | – | G1–G8 |
| B Auth | 5 | – | A1–A5 |
| M Member | 8 | – | M1–M7 + M-DEL |
| P Pipeline | 7 | – | P1–P7 (read-only) |
| C Chat | 5 | – | C1–C5 |
| K Cost | 6 | – | K1–K6 |
| E Error/security | 9 | – | E1–E9 |
| T Timestamp | 4 | – | 💰 budgeted, once each |
| N Model eval | 1 | – | 💰 budgeted |
| O Owner-device | – | 8 | O1–O8 (O8 = owner+machine) |
| **TOTAL** | **53** | **8** | **61 tests** |

- **Machine-executable: 53** (of which 5 are 💰 budgeted paid runs in T/N — run once, owner-approved; the other 48 are $0 read-only/curl/session-injection).
- **Owner-device only: 8** (O1–O8; O7 is the single non-negotiable #1 gate; O8 pairs with a machine read-back).

## Top 5 highest-risk flows — test FIRST
1. **O7 — remote participant voice in a real 2-person Meet** (owner). The entire product's reason to exist; the only thing no machine can prove; historically the hardest-won fix.
2. **E1/E2 — CORS credentialed-reflection (B1)**. A regression here lets any website read a logged-in member's data. Verify live on every deploy (currently CLOSED — confirmed 2026-07-22).
3. **P1–P4 — AI results correctness on COMPLETE videos** (summary/chapters/tasks/transcript non-empty, right language, not hallucinated). This is DONE-criterion (a); read-only, cheap, high-signal.
4. **K1/K2/K4 — no-money-waste gates** (canUseAI on all paid routes; retry-transcription confirm guard; quota-exhausted doesn't loop probes). DONE-criterion (c); a hole here silently bills the owner.
5. **M-DEL + C1 — account-deletion cascade (C1 stuck-state) and delete-account phrase gate**. Data-safety: a half-purged, permanently-stuck deletion is the worst irreversible failure; verify by code + a disposable user only.

## CORE-readiness VERDICT criteria (Phases 2–3 — what THIS gate decides)
"Core-ready" (recording + AI results + no-waste solid; the internal team can rely on it for daily use) = ALL of:
- **Zero unresolved BLOCKERs** to DONE-criteria (a) AI results, (b) recording + remote voice, (c) no money waste. (Blocker = a real user hits it on a normal path.)
- **The recording fix confirmed:** O7 **and O7b** pass on a real 2-person call — the remote voice is present on BOTH a first AND a second recording of the same call — and E1/E2 (CORS) are still closed.
- **AI results (P1–P4)** non-empty, correct-language, not hallucinated on real COMPLETE videos.
- **No-waste gates (K1–K6)** hold; any latency-waste (K4) is documented and explicitly accepted or fixed.

Timestamp (Flow T) and model-eval (Flow N) are SEPARATE budgeted phases (handover Phases 4–5). They do NOT block CORE-readiness — BUT the owner's full DONE (H2) explicitly includes **(e) timestamp fixed**, so **final handover (Phase 6) additionally requires the Flow T outcome**; this gate alone must NOT be quoted as "H2 fully done". Everything else that isn't a blocker = should/nit → the team's backlog, not a gate.

## What to do with results (Phase 2 → 3)
Produce a single ranked defect list: each defect = ID, severity (blocker/should/nit), evidence path, and the file/route to fix. Blockers to DONE-criteria (a)(b)(c) gate the handover; everything else is a should/nit for the team's backlog. Fixes follow the established chain: plan → Fable plan-review → build → owner review → Fable review-of-review → deploy. The owner-device gate (O7) stays the final human confirmation before "production ready".
