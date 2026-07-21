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

- [pending agent: backend security/data/reliability]

### From recording/extension/UX audit (DONE) — verified against current source + live prod
**B1 (CRITICAL BLOCKER, security, decision-free, curl-verifiable) — CORS reflects ANY origin with credentials. ROOT CAUSE CONFIRMED by me (I curl-verified prod, escalating the audit's finding).** The audit said "cap.so trusted"; the REAL hole is worse: `apps/web/utils/helpers.ts:18-26` `getHeaders(origin)` returns `"Access-Control-Allow-Origin": origin || "*"` **+ `Access-Control-Allow-Credentials: "true"`** — it echoes the caller's origin unconditionally. LIVE-VERIFIED on prod: `curl -H "Origin: https://evil.example.com" .../api/thumbnail` → `ACAO: https://evil.example.com` + `ACAC: true`. With `sameSite:"none"` session cookies, ANY website a logged-in member visits can make credentialed reads against every route that uses `getHeaders()`. There are THREE CORS mechanisms in the tree — (1) `utils/cors.ts getCorsHeaders()` = a PROPER allowlist (returns `"null"` for disallowed — this one is fine but its allowlist still lists cap.so/cap.link, remove those), (2) `utils/helpers.ts getHeaders()` = the BROKEN reflect-any, (3) `app/api/utils.ts:133 corsMiddleware = cors({...})` hono — UNCHECKED, audit it too. FIX (decision-free): make `getHeaders()` use a strict allowlist scoped to data365's own domain(s) + desktop `tauri`/`localhost` (mirror `cors.ts`'s pattern: echo only if allow-listed, else no ACAO / `"null"`); drop cap.so/cap.link everywhere; verify the hono `corsMiddleware` origin option isn't permissive. ALSO `apps/web/proxy.ts:43-50` hardcodes `frame-ancestors https://cap.so` on `/login` (every other route = `'self'`, curl-confirmed) → `'self'`. BLAST-RADIUS: enumerate which API routes call `getHeaders()` vs `getCorsHeaders()`; some may legitimately need the desktop origin — keep `tauri://localhost`. Verify by re-curl: evil origin must NOT be reflected, legit still works. Effort S–M. **This is the #1 item.**
**B2 (BLOCKER, reliability, decision-free, vitest-verifiable) — mic-permission hang on the FALLBACK recorder paths.** `inpage-recorder.ts` has `MIC_ACQUIRE_TIMEOUT_MS=8000`+`withTimeout()`; the Ctrl+Shift+9 fallback (`recorder/recorder-page.ts:572,577,586`) and `offscreen/recorder.ts:117,157,164` have NONE — an unanswered Chrome mic prompt hangs `startRecording()` forever. The exact bug fixed in one twin, live in the other two (the duplicated-recorder-machinery debt biting). FIX: port the same withTimeout pattern (reuse). Verify: extension vitest, mock getUserMedia that never resolves, assert start completes within ~8s. Effort S.
**B3 (should-fix, UX, decision-free) — `/dashboard/meetings` has no loading state → blank white screen.** Parent `dashboard/loading.tsx` returns `null`; `meetings/` has no `loading.tsx` (sibling `caps/loading.tsx` has a skeleton). FIX: adapt caps skeleton. Verify: needs authed view (code-absence is the evidence) — or a local dev run. Effort S.
**B4 (should-fix, decision-free i18n + minor product call) — 3 copy-pasted error boundaries are 100% English AND render raw `{error.stack}` in a visible `<pre>` to the user.** `dashboard/error.tsx`, `caps/error.tsx`, `meetings/error.tsx` (twins — fix all 3). FIX: translate via next-intl; consider hiding the raw stack (low risk internal, but unpolished). Verify: trigger a client error in browser pane. Effort S–M.
_Already-solid (verified, do NOT redo): Meet tab reload/close recovery, source-swap rebuild, Entire-Screen gate, upload retry/dead-letter + 2s buffer persist, crash recovery, shared RECORDER_ERROR handling, extension i18n in recorder path, share page mobile/dark clean. Can't verify (owner device): 2-person Meet on v0.5.1._

## MORNING LIST (things a machine cannot finish — for the owner)
- The 2-person real Meet test on a real device (the final gate).
- Any product decision the audit surfaces.
- (fill as discovered)

## PIPELINE STATUS
- [x] Grill decisions captured
- [ ] Audit complete → plan filled
- [ ] Fable plan-review
- [ ] Build (Track A + safe Track B)
- [ ] My review → Fable review-of-review
- [ ] Deploy + live-verify
- [ ] Morning report + STATE
