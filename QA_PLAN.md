# QA Plan — cap-v2 (Ustoz) — RUN 6 (Contabo prod deploy, data365.duckdns.org)

> History: RUN 1 full pass · RUN 2 dark-mode/UI · RUN 3 core pipeline · RUN 4 live Playwright (Railway) · RUN 5 laptop/Tailscale deploy. **RUN 6 (this)** = QA of the NEW **Contabo production deploy** at `https://data365.duckdns.org` (Coolify Docker, migrated MySQL 84 videos, R2). Scope per owner: Step 0→3 full technique-driven human-expert test + independent-oracle pass, then Step 5 Layer 9 → QA_POLISH.md. **Proof run — Step 4 SKIPPED: touch no code, no fixes, no deploy/commit.**

## Project
- **Name:** cap-v2 (Ustoz) — Cap fork, self-hosted meeting recorder + AI analysis. record/import → R2 → share `/s/[videoId]` → Gemini transcript/summary/tasks/chapters + RAG chat.
- **Platform:** Web (Next.js 16.2.1 App Router, React 19), pnpm/turbo monorepo. Evidence: root `package.json` `"name":"cap-v2"`; `apps/web/package.json` `next 16.2.1`, `react 19.2.4`; App Router tree `apps/web/app/**` (route groups `(org)`, `s`, `embed`, `admin`, `api`). Plus `apps/browser-extension` (MV3, NOT headless-testable). No `android/` → pure Web/PWA.
- **Target environment:** **LIVE PRODUCTION** — `https://data365.duckdns.org` (Contabo VPS, Coolify Docker, migrated MySQL 84 videos, R2 storage, Let's-Encrypt SSL). Health verified THIS run via Browser pane `/api/health` → `{status:ok, checks:{db:ok, storage:ok}}`.
- **Tooling:** Built-in Browser pane (`mcp__Claude_Browser__*`) — live UI drive, desktop + mobile viewport, console/network capture. Playwright available (`apps/web/e2e/`) but cannot forge prod auth. Lint = biome.
- **Run / build / test:** dev `pnpm dev:web` · build `pnpm --filter @cap/web build` · unit `pnpm --filter @cap/web test` (vitest) · e2e `pnpm --filter @cap/web exec playwright test` (:3001) · lint `pnpm exec biome lint`. This run drives the **live** deploy, not a local build.
- **Hardening tools:** biome ✅ · Vitest + Playwright ✅ · CI `.github/workflows/` ✅ (biome red pre-existing) · OpenTelemetry wired · Sentry/Crashlytics ❌ · Lighthouse/axe/pa11y ❌.

## Safety adaptation (LIVE PRODUCTION target — stricter than a staging run)
- Target is the REAL server the IT team will use ⇒ **zero writes**: no login attempts that could lock accounts, no delete, no replace-with-audio confirm, no triggering AI generation/spend, no messages/invites, no billing, no deploy/commit/push.
- **No dev-auth bypass** — forbidden against prod; Google OAuth/credentials cannot be forged headlessly.

## COVERAGE PRE-FLIGHT (honest — set before the run)
**CAN test (anonymous, read-only, prod-safe):**
- Root `/` redirect · `/login` (render, form, a11y, Google btn) · `/signup` render · legal `/privacy` `/terms` · **`/s/[videoId]` share page** — core meeting-view: player, AI tabs (Xulosa/Vazifalar/Transkript/Matn), chat UI, dock/slim-bar behavior, T4b owner-gating leak-check · `/embed/[videoId]` · 404/not-found · light+dark · mobile+desktop viewport · console/network per route.

**CANNOT test → marked `Unverified`, NOT claimed as passing:**
- Every login-required flow (dashboard, caps CRUD, record, import, meetings, settings, members, admin) — no forgeable prod auth + unsafe.
- Destructive/paid actions (delete recording, replace-with-audio confirm, new AI analysis, invites, billing) — Safety-forbidden on prod.
- Real recorder capture (getDisplayMedia, upload) — device-only.
- WebView/OAuth-popup specifics — real-device only.

## Status
Step 0 ✅ · Step 1 ✅ · Step 2 ✅ · Step 3 ✅ (2 ❌ F6/F9, 1 ⚠️ F8, oracle-reconciled) · Step 4 ⏭ SKIPPED (proof run, owner) · Step 5 ✅ Layer 9 only → QA_POLISH.md (7 polish tasks)

## The 6 steps (this run: 0→1→2→3, then Step 5 Layer 9)
- Step 1 — Map flows + gaps → QA_FLOWS.md
- Step 2 — Smoke gate → QA_SMOKE.md
- Step 3 — Full QA execution (+ independent-oracle pass) → QA_REPORT.md
- Step 4 — SKIPPED (no fixes this run)
- Step 5 — Layer 9 usability/friction + Supermodel visual → QA_POLISH.md

## Regression memory
- `QA_REGRESSION.md` does NOT exist at repo root → no prior fixed-bug rows to drive first. Prior QA_REPORT.md exists (RUN 5) but no regression ledger was kept.

## Non-disruptive rules
Headless Browser pane only; screenshots ≤1800px via Read; select by aria-label/text; test data only; **prod ⇒ no writes/payments/messages/deletes/AI-runs/deploys/commits.**

## Hand-off contract
Each step: (1) reads QA_PLAN.md first; (2) does its work; (3) writes its output file; (4) updates the Status line. Files are the source of truth.
