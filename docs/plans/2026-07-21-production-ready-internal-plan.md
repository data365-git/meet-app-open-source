# Production-Ready (Internal IT Team) — plan + decision map

_Created 2026-07-21 (overnight autonomous run, owner asleep). Source of WHY + the live plan._

## GOAL (owner's words)
Make Ustoz **production-ready for the owner's own IT team to use daily** (internal). The #1 requirement: a Google Meet meeting must NEVER fail to record, and the recording must contain the OTHER participants' voices.

## DECISIONS (grill, 2026-07-21) — BINDING for this run
- **D1 — Scope = INTERNAL IT team, not public.** (Re-confirms the 2026-07-18 binding decision.) Domain stays free duckdns; email not needed; no public self-serve flow. → EXCLUDE from scope: SEO, public onboarding, email, external-scale/load, marketing.
- **D2 — Overnight workflow the owner asked for:** ① write a PLAN → **Fable reviews the plan** → ② BUILD → ③ my review → **Fable reviews the review** → ④ DEPLOY (authorized after the full review chain passes) → ⑤ morning report. Anything risky/unverifiable → HOLD + report, do not deploy.
- **D3 — Do ALL 3 small cost/security fixes** (see Track A).
- **D4 — Requester "we'll contact you" screen + pending-requests dashboard = SKIP** (not needed for internal; owner adds members directly).

## HONEST LIMIT
"Fully production-ready by morning" is NOT fully machine-achievable: the final gate is the owner's real 2-person Meet test on a real device — no machine can do it. This run gets everything a machine can + reviewed, and leaves a crisp morning list. No false "done".

## BUDGET
Owner is on a $20 plan — focused high-value work only, stop when the safe work is done; do not grind to fill hours. Audit is READ-ONLY, no paid Gemini calls.

---
## TRACK A — the 3 decided small fixes (decision-free, ready to spec)
- **A1 — retry-transcription guard.** `apps/web/app/api/videos/[videoId]/retry-transcription/route.ts` has no "already has a transcript — confirm the paid re-run?" check. Add a guard: when a COMPLETE transcript exists, require an explicit confirm/force flag before re-spending. Verifiable: unit test. Blast-radius: check all callers of this route (web UI + any SDK) so the confirm flag is threaded, not a silent 400.
- **A2 — cost-accounting model literal.** `apps/web/workflows/transcribe.ts:~841` passes a hardcoded `model: "gemini-3-flash-preview"` to `withCostGuard`, but the call can silently fall back to another model → mispriced/under-reported spend. Report the ACTUAL model used. Verifiable: unit test with a mocked fallback.
- **A3 — guest-chat IP backstop.** `apps/web/lib/ai-chat-limit.ts` caps guest chat per-cookie only (bypassable by clearing cookies). Add an IP/account backstop. ⚠️ Blast-radius: the `x-forwarded-for` leftmost-hop is spoofable AND Coolify's proxy hop is unverified — must be validated against the live proxy before trusting any IP; if unverifiable, keep the cookie cap + add a conservative additional signal, don't regress. Flag if it needs live-proxy verification.

## TRACK B — production-readiness audit findings (to be filled from the 2 audit agents)
_(Two READ-ONLY audit agents running: one backend/security/data/reliability, one recording-pipeline/extension/UX. Their ranked punch-lists land here. Only DECISION-FREE, verifiable-without-owner-QA, safe fixes get built this run; product-decisions and device-QA items go to the morning list.)_

### From backend security/data/reliability audit (DONE)
**C1 (BLOCKER, data-safety, decision-free, unit-verifiable) — account self-deletion can crash mid-flight and get PERMANENTLY stuck after storage is already purged.** `apps/web/actions/account/delete-account.ts:104-134` final `db().transaction()` has NO try/catch (the video-purge step above it does). `ai_usage_events.orgId` FK is `ON DELETE no action` (`schema.ts:1577-1581`), and `remove-member.ts:69-97` never deletes a removed member's `ai_usage_events`. Scenario: owner removes member B (B's ai_usage rows linger) → org is sole-member → owner deletes own account → videos/storage purged (irreversible, succeeds) → `DELETE organizations` fails FK → txn rolls back but storage already gone → generic 500, every retry re-fails → owner permanently can't delete, data partly gone. FIX: wrap final txn in try/catch (mirror the block above) AND delete `ai_usage_events` by orgId for sole-member orgs before the org row. Verify: unit test. Effort S.
**C2 (BLOCKER→needs 1 product micro-decision) — Trash has NO restore path** despite the 7-day "so it can be restored" promise. No restore action/UI exists anywhere (grepped). The server action is decision-free (`UPDATE videos SET deletedAt=NULL WHERE id=? AND ownerId=?`, mirror permanentlyDelete's ownership check); only WHERE the restore button/Trash view lives is a product call. → MORNING for UI placement; can pre-build the server action.
**C3 (should-fix) — `storageMissing` flag set by reconcile cron but surfaced to the user NOWHERE** → silent broken player instead of "recording unavailable, contact admin". `reconcile-storage/route.ts:95-103` sets it, no reader. Decision-free: surface a truthful message. Verify: code/dev.
**C4 (should-fix, decision-free) — 2 routes missing authz:** `api/video/domain-info/route.ts:7-102` (no auth at all — any videoId returns its org's custom-domain+verification; reuse `canView`/`getByIdForViewing`); `api/settings/billing/guest-checkout/route.ts:5-44` (no `priceId` allowlist vs `ALL_STRIPE_PLAN_PRICE_IDS` — low relevance internal, cheap fix). Verify: unit/curl.
**C5 (should-fix, cleanup) — migration hygiene:** delete the 6 DEAD orphan `.sql` files (`0008`, `0026`-`0030` "seconds" — confirmed NOT in `_journal.json`, content re-captured in 0031, zero prod impact) so they aren't mistaken for pending work; fix the dead `db:check-integrity` reference in `packages/database/package.json:14` (points at a non-existent script). Safe.
**C6 (MORNING/owner) — GitHub nightly `db-backup.yml` fails every night** — but it's a KNOWN DEAD DECOY (targets the deleted Railway DB; the REAL backup is the VPS cron `/root/backup-db.sh`, indirectly confirmed fresh via `db-restore-check` green 2026-07-20). RUNBOOK §7 fix: disable this workflow's schedule + delete the stale object; set `TELEGRAM_ALERT_CHAT_ID` (owner 30s). ⚠️ editing `.github/workflows/*` needs the `workflow` PAT scope to push — attempt, else flag.
**C7 (MORNING/owner-confirm) — 2 crons wired but never scheduled:** `finalize-stale-desktop-segments` (matters ONLY if the Tauri desktop client is used internally — CONFIRM with owner) and `developer-storage` (SDK billing — out of internal scope). If desktop is used, add a curl step to `recover-cron.yml`.
_Backend already-solid (do NOT redo): signup→no-org, admin approval gating (approveRequest always role member), video permanentlyDelete path + trash purge reuse, all 6 crons' timingSafeEqual auth, recover-stale-ai-jobs (live-running), /api/health, client/server secret separation, ~35-route authz sweep all gated, no hardcoded secrets, no destructive migrations. Nice-to-have (defer): orphaned storageIntegrations creds on org-delete (documented-accepted), stale DEPLOY_SECRETS.md/.env Railway creds (gitignored, housekeeping)._

### From recording/extension/UX audit (DONE) — verified against current source + live prod
**B1 (CRITICAL BLOCKER, security, decision-free, curl-verifiable) — CORS reflects ANY origin with credentials. ROOT CAUSE CONFIRMED by me (I curl-verified prod, escalating the audit's finding).** The audit said "cap.so trusted"; the REAL hole is worse: `apps/web/utils/helpers.ts:18-26` `getHeaders(origin)` returns `"Access-Control-Allow-Origin": origin || "*"` **+ `Access-Control-Allow-Credentials: "true"`** — it echoes the caller's origin unconditionally. LIVE-VERIFIED on prod: `curl -H "Origin: https://evil.example.com" .../api/thumbnail` → `ACAO: https://evil.example.com` + `ACAC: true`. With `sameSite:"none"` session cookies, ANY website a logged-in member visits can make credentialed reads against every route that uses `getHeaders()`. There are THREE CORS mechanisms in the tree — (1) `utils/cors.ts getCorsHeaders()` = a PROPER allowlist (returns `"null"` for disallowed — this one is fine but its allowlist still lists cap.so/cap.link, remove those), (2) `utils/helpers.ts getHeaders()` = the BROKEN reflect-any, (3) `app/api/utils.ts:133 corsMiddleware = cors({...})` hono — UNCHECKED, audit it too. FIX (decision-free): make `getHeaders()` use a strict allowlist scoped to data365's own domain(s) + desktop `tauri`/`localhost` (mirror `cors.ts`'s pattern: echo only if allow-listed, else no ACAO / `"null"`); drop cap.so/cap.link everywhere; verify the hono `corsMiddleware` origin option isn't permissive. ALSO `apps/web/proxy.ts:43-50` hardcodes `frame-ancestors https://cap.so` on `/login` (every other route = `'self'`, curl-confirmed) → `'self'`. BLAST-RADIUS: enumerate which API routes call `getHeaders()` vs `getCorsHeaders()`; some may legitimately need the desktop origin — keep `tauri://localhost`. Verify by re-curl: evil origin must NOT be reflected, legit still works. Effort S–M. **This is the #1 item.**
**B2 (BLOCKER, reliability, decision-free, vitest-verifiable) — mic-permission hang on the FALLBACK recorder paths.** `inpage-recorder.ts` has `MIC_ACQUIRE_TIMEOUT_MS=8000`+`withTimeout()`; the Ctrl+Shift+9 fallback (`recorder/recorder-page.ts:572,577,586`) and `offscreen/recorder.ts:117,157,164` have NONE — an unanswered Chrome mic prompt hangs `startRecording()` forever. The exact bug fixed in one twin, live in the other two (the duplicated-recorder-machinery debt biting). FIX: port the same withTimeout pattern (reuse). Verify: extension vitest, mock getUserMedia that never resolves, assert start completes within ~8s. Effort S.
**B3 (should-fix, UX, decision-free) — `/dashboard/meetings` has no loading state → blank white screen.** Parent `dashboard/loading.tsx` returns `null`; `meetings/` has no `loading.tsx` (sibling `caps/loading.tsx` has a skeleton). FIX: adapt caps skeleton. Verify: needs authed view (code-absence is the evidence) — or a local dev run. Effort S.
**B4 (should-fix, decision-free i18n + minor product call) — 3 copy-pasted error boundaries are 100% English AND render raw `{error.stack}` in a visible `<pre>` to the user.** `dashboard/error.tsx`, `caps/error.tsx`, `meetings/error.tsx` (twins — fix all 3). FIX: translate via next-intl; consider hiding the raw stack (low risk internal, but unpolished). Verify: trigger a client error in browser pane. Effort S–M.
_Already-solid (verified, do NOT redo): Meet tab reload/close recovery, source-swap rebuild, Entire-Screen gate, upload retry/dead-letter + 2s buffer persist, crash recovery, shared RECORDER_ERROR handling, extension i18n in recorder path, share page mobile/dark clean. Can't verify (owner device): 2-person Meet on v0.5.1._

## SYNTHESIS — BUILD TONIGHT (decision-free, safe, verifiable WITHOUT owner QA), ordered by severity
1. **B1 — CORS reflect-any-origin** (CRITICAL). helpers.ts `getHeaders` → strict allowlist; cors.ts drop cap.so/cap.link; proxy.ts /login → `'self'`; check hono `corsMiddleware`. Verify: curl (evil origin NOT reflected; desktop/self still work).
2. **C1 — delete-account crash** (BLOCKER). try/catch + purge `ai_usage_events` for sole-member org first. Verify: unit test reproducing the FK stuck-state.
3. **B2 — mic-timeout on fallback recorder paths** (BLOCKER). Port `withTimeout`/`MIC_ACQUIRE_TIMEOUT_MS` to recorder-page.ts + offscreen/recorder.ts. Verify: extension vitest (getUserMedia never resolves → start completes ≤8s).
4. **A1 — retry-transcription guard.** Confirm-before-paid-re-run. Blast-radius: thread the confirm flag through callers, not a silent 400. Verify: unit test.
5. **A2 — cost-accounting model literal.** Report the ACTUAL model to withCostGuard. Verify: unit test w/ mocked fallback. (Same file as A2's neighbour transcribe.ts — build A1+A2 in one stream to avoid conflict.)
6. **A3 — guest-chat IP backstop.** ⚠️ x-forwarded-for hop is unverified on Coolify → do the SAFE part (keep cookie cap + add a conservative additional signal); HOLD any hop-specific IP trust pending a live-proxy check, don't regress. Verify: unit test of the logic.
7. **C3 — surface `storageMissing`** truthful message. Verify: code/dev.
8. **C4 — authz: video/domain-info (add canView) + guest-checkout (priceId allowlist).** Verify: unit/curl.
9. **B3 — /dashboard/meetings loading skeleton** (adapt caps/loading.tsx). Verify: dev/code.
10. **B4 — 3 error-boundary twins: i18n + stop leaking raw `{error.stack}`.** Verify: browser/dev.
11. **C5 — migration cleanup:** delete 6 dead orphan .sql + fix dead `db:check-integrity` reference. Safe.

Build rule: each fix on its own file-set (mostly disjoint), each with a test that FAILS when broken, each gated (typecheck + relevant vitest, BOM/CRLF-clean). Extension changes → rebuild zip once at the end. Anything that turns out risky/unverifiable → HOLD + morning list (like the free-probe precedent), do NOT ship blind.

## MORNING LIST (owner — machine cannot finish these)
- ⛔ **The 2-person real Meet test on a real device, current v0.5.1 build** — the final production gate. No machine can do it.
- **C2 — Trash restore: WHERE should the restore button/Trash view live?** (server action can be pre-built; UI placement is your call.)
- **C7 — Is the Tauri DESKTOP recorder client actually used by the team?** (if yes, its stuck-upload cron needs scheduling.)
- **C6 — set `TELEGRAM_ALERT_CHAT_ID`** (30s: message @userinfobot) so backup/ops failures actually alert; + disable the dead `db-backup.yml` (I'll attempt the workflow edit if the push token allows).
- Deferred nice-to-haves: dashboard `<title>` i18n app-wide pass, recorder a11y, orphaned-creds cleanup, stale DEPLOY_SECRETS/.env housekeeping.

## FABLE PLAN-REVIEW (DONE) — VERDICT: OK TO BUILD; corrections folded (all spec-level, no owner input)
- **B1:** custom-domain fear is a NON-issue (share-page fetches are relative → same-origin; CORS never applies). `getHeaders` (helpers.ts) has 2 callers (thumbnail, comment/delete), no cross-origin caller → strict allowlist safe, and DROP `credentials:true` for the wildcard case is fine. `utils/cors.ts getCorsHeaders/getOptionsHeaders` are DEAD (delete them), but its `allowedOrigins` array is LIVE via `lib/server.ts:162 HttpApiBuilder.middlewareCors({ allowedOrigins, credentials:true })` — drop cap.so/cap.link THERE (that's the real prod change; curl-verify an Effect-API route). Hono `app/api/utils.ts:138` allows any `chrome-extension://` with credentials — accepted-risk for dev installs, WRITE IT DOWN in a comment, don't skip.
- **C1:** complete — `ai_usage_events_org_fk` is the ONLY organizations FK (schema+migrations checked). Delete by-orgId inside the txn before the org row.
- **A2:** 3 files — add optional `modelUsed` to `GeminiTranscribeResult` (`gemini-transcribe.ts`), and `ai-cost-guard.ts` must prefer `result.modelUsed ?? options.model` at BOTH `:300` (priceForMicros) and `:316` (recorded row).
- **A1:** retry-transcription has ZERO callers (dead upstream route) — add the guard cheaply, don't hunt for UI.
- **C4:** domain-info route is DEAD (zero callers) — DELETE it (simpler than wiring canView). guest-checkout priceId allowlist stays (5-line hardening).
- **B4+C3 collision:** both edit `messages/{en,ru,uz}.json` → ONE stream. B4: render `error.stack` only when NOT production (keep `digest`). C3 surface = share-page player area.
- **B2:** bump extension **0.5.1 → 0.5.2** so the owner's morning Meet test provably tests the rebuilt zip. (offscreen `:117` is the display stream = no prompt; the mic calls are the real hang — wrapping both is harmless.)
- **A3:** make concrete — per-VIDEO daily total guest cap (key by videoId alone in existing `ai_chat_usage`, spoof-proof, no IP trust); chat already has org budget caps so it's cost-bounded regardless. If not clean → morning.

## BUILD STREAMS (file-disjoint → parallel; each: implement + failing→passing test + targeted vitest ONLY, no `tsc -b`, no commit; I run the central gate + review + commit)
- S1 CORS(B1): helpers.ts, cors.ts, lib/server.ts, proxy.ts, api/utils.ts(comment)
- S2 delete-account(C1): actions/account/delete-account.ts
- S3 mic-timeout(B2): extension recorder-page.ts, offscreen/recorder.ts
- S4 transcription-cost(A1+A2): retry-transcription route, gemini-transcribe.ts, ai-cost-guard.ts, workflows/transcribe.ts
- S5 guest-chat(A3): lib/ai-chat-limit.ts
- S6 UX-i18n(B3+B4+C3): meetings/loading.tsx(new), 3 error.tsx, share player, messages/{en,ru,uz}.json
- S7 authz+cleanup(C4+C5): delete domain-info route, guest-checkout allowlist, delete 6 orphan .sql, fix db:check-integrity ref

## PIPELINE STATUS
- [x] Grill decisions captured
- [x] Audit complete (both agents) → plan filled + synthesized
- [x] Fable plan-review → OK TO BUILD, corrections folded
- [x] Build (7 disjoint streams) — DONE, committed `59962bc..77962f1` (7 commits). Notes: A3 = helper only, chat-route wiring deferred (already cost-bounded); C4 domain-info route DELETED (dead); C5 6 orphan .sql + dead script removed; extension bumped 0.5.2.
- [x] Central gate — GREEN: root typecheck exit 0, extension tsc = only the 2 known pre-existing MessageBase errors, extension vitest 135/135, web vitest 1181 passed / 0 failed. (Fixed 2 test-only typecheck issues centrally: getHeaders return type → Record<string,string>; cost-guard test mock spread; removed a stale `.next/types` entry for the deleted route.) My review of the critical CORS + delete-account diffs: correct.
- [x] Fable review-of-review → **VERDICT SHIP**, no blocker/regression. It re-ran all gates itself (root pass, ext 135/135, web 1181/0-fail), unzipped the extension artifact to confirm the compiled timeout code ships, and scripted a full migration journal↔dir reconciliation (clean). Nits (non-blocking, deferred): `proxy.ts:13-15 mainOrigins` still lists cap.so/cap.link — DEAD entries (custom-domain routing skip, can never match on self-hosted; NOT a CORS/trust grant), safe to prune later; other cap.so literals in next.config.mjs/sitemap are pre-existing upstream leftovers.
- [~] Deploy — IN PROGRESS. Pushed `d150c49` to `qa-fixes`, Coolify deployment `pwas79rn68icrfjral91xa91`, ~30 min build. A background poll will verify: image tag = `d150c49`, `/api/health` ok, extension zip `0.5.2`, and the B1 CORS proof (evil origin → NO ACAO; `data365.duckdns.org` origin still echoed).
- [ ] Morning report + STATE

## MORNING LIST (owner) — refined after the full run
- ⛔ **The 2-person real Meet test on a real device, extension v0.5.2** (install from data365.duckdns.org/dashboard/extension AFTER the deploy lands) — the final production gate; press **"Hozir yozish"**, pick Entire Screen, talk 2 min with one other person, Stop → must appear under Meetings, remote voice audible, transcript/summary generates (credit is back).
- **C2 — Trash restore: where should the restore button / Trash view live?** (dashboard tab vs quick-action) — decide, then I build the (decision-free) server action + that UI.
- **C7 — Is the Tauri DESKTOP recorder client actually used by the team?** If yes, its stuck-upload cron needs scheduling.
- **C6 — set `TELEGRAM_ALERT_CHAT_ID`** (30s via @userinfobot) so backup/ops failures alert; the dead `db-backup.yml` workflow can be disabled (needs a `workflow`-scoped push).
- A3 chat-route wiring (deferred, low-urgency — cost already bounded); proxy.ts cap.so dead-entry prune; dashboard `<title>` i18n app-wide pass; recorder a11y — all deferred nice-to-haves.

## PROVABLE ONLY IN PRODUCTION (the background poll handles B1; note the rest)
- B1 CORS re-curl on the live build (in the poll). C1 assumes prod carries `ai_usage_events_org_fk` (harmless if absent). One real-Chrome mic-prompt sanity start (device-only). Behavioral: worst-case mic wait is now 8+8=16s before recording proceeds mic-less on the chosen-device path (intentional, same as the inpage twin).
