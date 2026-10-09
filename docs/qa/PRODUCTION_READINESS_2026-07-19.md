# Production-readiness verification — 2026-07-19 (deploy of `c941a78`)

> ## ✅ DEPLOY HAPPENED AND IS LIVE — measured 2026-07-19 ~01:22
> Owner approved deploy explicitly ("bu uchun deploy shart bo'lsa deploy qil").
> Coolify deployment `dcv3k8qki4333cvupd8ymcun` → status **finished**.
> **Live container image tag = `c941a780e48257bac2386e7598e0f8a37194ace2`** (was `f2e64a6…` for 3 days).
> Verified immediately after, with real curl output:
> - `/api/health` → `{"status":"ok","checks":{"db":"ok","storage":"ok"}}`
> - **Security headers NOW PRESENT on `/login`** (they were absent on the old build — this closes the QA-run-8 Medium):
>   `Strict-Transport-Security: max-age=86400` · `X-Content-Type-Options: nosniff` ·
>   `Referrer-Policy: strict-origin-when-cross-origin` · `X-Frame-Options: SAMEORIGIN` ·
>   `Permissions-Policy: geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), idle-detection=(), browsing-topics=()`
> - `DELETE /api/video/delete-permanent?videoId=nope` (unauth) → **401**
> - `GET /api/cron/purge-trashed-videos` (unauth) → **401** — the new cron route is deployed and gated
> - Old build sanity (before deploy): login page rendered correct Uzbek, private-video page showed the
>   restricted screen with no data leak, zero console errors.
>
> ⚠️ NOT yet re-verified on the NEW build: the full public-surface walk (mobile/dark/UX),
> authenticated screens, and the auto-public behaviour. See "What remains" at the bottom.

Method: owner's 8-gate launch checklist (PRODUCTION_HANDBOOK) cross-checked against
Google SRE launch checklist + industry PRR practice. Every line gets EVIDENCE, not
opinion. Machine-verifiable items run tonight against the LIVE deploy; owner-only
items are named as such; accepted risks are cited to the owner decision that
accepted them.

Legend: ✅ proven · ❌ failed · 🕐 pending · 👤 owner-only · ⚖️ accepted risk (cited)

## Gate 1 — Security
- 🕐 Global security headers live (HSTS, nosniff, Referrer-Policy, Permissions-Policy): `curl -sD- /login`
- 🕐 Unauth access to a private video → restricted page, no data leak (was ✅ on old build; re-verify)
- 🕐 `/api/video/delete-permanent` unauthenticated → 401/403, never 200
- 🕐 New-signup-gets-NO-org (C2): signup page reachable; account-creation itself 👤 (AI may not create accounts — owner confirms the "we'll contact you" screen in the morning)
- 🕐 AI-chat guest daily cap present (DB-backed, migration 0036) — probe route exists & is gated
- ✅ Secrets: `.dockerignore` fixed (`c0a35f0`); repo secret-grep clean at commit time
- ✅ Privileged holes closed & tested: hardcoded admin gate → `users.isAdmin` (`79e01ca`), revoke deletes API keys, retry-ai gated (suite green at `c941a78`)
- ⚖️ Coolify admin ports not firewalled — owner decided: independent check first, panel-first plan pending his approval
- ⚖️ AI-chat IP spoof bypass (leftmost XFF) — Coolify proxy behavior unverified; do not guess (STATE, session i)

## Gate 2 — Correctness
- ✅ Web: tsc 0 · 1073 passed / 26 skipped (run tonight, this tree)
- ✅ Extension: 113 tests, RED-first + sabotage-verified where it mattered
- ✅ Production-path webpack build passed locally (exit 0, full route table)
- ✅ 2 independent audits (36 executed attacks) converge: guarantee holds; 1 proven crack fixed + VERIFIED-FIXED same night
- 🕐 Live smoke of public flows post-deploy (share page render, login page, signup page, /api/health)
- 👤 Authenticated end-to-end (record → dashboard → play to END with audio): OWNER_QA_SCRIPT steps 1–7 — the deploy blockers are steps 1 and 6

## Gate 3 — Recoverability
- ✅ Backup RESTORED once, proven: db-restore-check green (2026-07-17: 38 tables, 4 users, 90 videos)
- 🕐 Last nightly `capdb-*.sql.gz` exists and is fresh (< 48h) — check via server log/bucket
- ✅ Rollback procedure documented + tested pattern (RUNBOOK §4); old image retained by Coolify
- 🕐 Post-deploy health `db:ok, storage:ok`
- 👤 Alerts reach a phone: uptime-alert workflow exists on main — owner should confirm he actually receives a test alert (once, any morning)

## Gate 4 — Performance
- 🕐 Public-page TTFB sane (<2s cold) — measured curl timing ×3
- ✅ Known-good live playback baseline: QA run-8 verified 52:51 video advancing cleanly
- ⚖️ No load test — internal team tool, single VPS, N+2 out of scope by owner's infra decision (free duckdns / single Contabo). Revisit before any wider launch.

## Gate 5 — Privacy / Legal
- ✅ Account deletion = REAL erasure, typed server-side phrase, tenant-safe (built + tested tonight, `16f9ac5`)
- 🕐 7-day Trash purge: route live check (401 unauth) — schedule INERT until merged to main (named honestly; manual curl works)
- 🕐 `/terms` + `/privacy` reachable (known pre-existing 404 debt on /terms — re-check on new build)
- ⚖️ No data export; no mail provider (free-domain decision, session i). Fine for internal team; revisit at wider launch.

## Gate 6 — UX/UI
- 🕐 Mobile viewport + dark mode on public pages (Browser pane, post-deploy)
- ✅ Recorder honest-UI work (pause/discard truth, flash messages) — reviewed + tested
- ⚖️ Known a11y gaps in recorder (focus/live-regions) — logged, not launch-blocking for the internal team (owner may re-prioritize)

## Gate 7 — Product/analytics
- ⚖️ N/A for the internal IT-team tool at this stage (owner's scope); AI usage events exist server-side.

## Gate 8 — Bus factor
- ✅ RUNBOOK (verified-by-running), MIGRATION.md, deploy/server/ in git (`2141b68`)
- 👤 SSH key exists ONLY on this laptop — copy `~/.ssh/hetzner_ustoz` into the password manager (RUNBOOK §7 gap; 2 minutes)
- 👤 db-backup.yml on main is dead (Railway) — disable its schedule + delete stale `data365-*` dump when convenient

## Deploy-specific (this release)
- 🕐 Running container image tag == `c941a78`
- 🕐 Migrations 0036/0037 applied (behavior check: new signup default private→public via env — incognito share-link of a NEW recording 👤 morning)
- 🕐 `CAP_VIDEOS_DEFAULT_PUBLIC=true` in effect (env read in container)
- 🕐 No error storm in container logs in first 10 min

## Gate results after the live deploy (measured, not claimed)
- Gate 1 Security: **mostly GREEN** — headers live ✅, both new endpoints 401 ✅, privileged holes closed + tested ✅. Open: firewall (owner decision), XFF spoof (needs live proxy test).
- Gate 2 Correctness: **GREEN on the machine half** — tsc 0, web 1073, ext 113, webpack prod build, 2 converging audits. Owner device gate = the remaining half.
- Gate 3 Recoverability: **GREEN** — restore proven 2026-07-17, health ok post-deploy, rollback documented (RUNBOOK §4).
- Gates 4–8: unchanged from the assessment above (accepted risks cited to owner decisions).

## What remains (next session — start here)
1. **Public-surface live walk on the NEW build** (no login needed, machine-doable): login, signup, `/s/[videoId]`, `/c/[id]`, `/embed`, `/terms` (known 404 debt — recheck), `/privacy`, 404 page. For each: works? + UX/UI at 375px mobile + dark mode + Uzbek copy consistency + console/network errors.
2. **Authenticated screens** — see `docs/qa/SESSION_INJECTION_NOTES.md` for the researched (and partially blocked) approach. Fastest alternative: the owner is already logged in; he can walk the dashboard in the morning with the checklist.
3. **Owner device gate** — `docs/OWNER_QA_SCRIPT.md` steps 1 and 6 (still the deploy-blockers for declaring the RECORDER production-ready; the web app itself is now live and verified).

## Honest status line
The **web app** is deployed and its machine-verifiable production properties are proven.
The **recorder guarantee** is proven by 2 independent audits + 36 executed attacks, but has
never been exercised on a real device with a real second human — that is the one thing no
amount of machine work can replace, and it is why "production ready" is not yet a true claim.
