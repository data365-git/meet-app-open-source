# FIX PLAN — Ustoz (execution of QA_REPORT.md)

**Goal:** fix all 51 confirmed bugs. Security + engine first (survive Phase-1 redesign); old dashboard/CapCard UI cosmetics LAST (that UI is replaced in Phase 1).

**Labor model (2026-06-20):** Claude 5-hour limit is low → **Codex CLI is the primary fixer** (`codex exec`), separate quota. Claude (General) = plan, run gates, commit, review. Sonnet for light edits only.

**Resumability protocol (NON-NEGOTIABLE — so a mid-way cutoff never leaves broken state):**
1. Work on branch `qa-fixes` (never commit fixes straight to the main branch).
2. ONE cluster at a time. Codex applies that cluster's fixes only.
3. After each cluster: run gate `pnpm -F @cap/web typecheck` (and a build/lint spot-check) → must stay green.
4. `git commit` that cluster as a single commit (message: `fix(qa): C<n> <name> [F.. N.. L..]`).
5. Tick the cluster below + update docs/STATE.md.
6. Never leave the tree with a failing typecheck between commits.

**Execution order (priority):**

| # | Cluster | Bugs | Primary files | Architectural? | Status |
|---|---|---|---|---|---|
| 0 | C14 ffmpeg prereq | L1 | (env: ffmpeg installed via winget) — restart dev server w/ refreshed PATH, retry transcription to verify | no | ☐ |
| 1 | C1 S3/storage access & **public bucket** | N002, N004, N016, N018, N020, F-storage | `apps/web/instrumentation.node.ts`, `app/api/thumbnail/route.ts`, `app/api/video/preview/route.ts`, `app/api/storage/object/route.ts`, `ImageUploads/index.ts` | **yes** (access model) | ☐ |
| 2 | C2 AI endpoints auth/IDOR/rate-limit | F001, F022, F023, F025, (B1) | `app/api/video/ai/chat/route.ts`, `app/api/video/ai/route.ts`, `app/api/video/transcribe/status/route.ts` | no | ☐ |
| 3 | C12 Admin data exposure + C3 analytics auth | N005, N007, N008 | `actions/admin/access.ts`, `app/api/analytics/route.ts`, `app/api/analytics/track/route.ts` | no | ☐ |
| 4 | C6 Loom SSRF + gate | N009, N010, N011 | `packages/web-backend/src/Loom/*`, `app/api/tools/loom-download/route.ts` | no | ☐ |
| 5 | C9 video metadata/policy | N012, N015, N017, F008 | `web-backend/src/Videos/VideosPolicy.ts`, `app/api/video/metadata/route.ts`, `Spaces/SpacesRepo.ts`, `actions/videos/new-comment.ts` | no | ☐ |
| 6 | C13 S3 bucket cross-tenant + misc | N013, F011, F018, L4, L5 | `S3Buckets/S3BucketsRepo.ts`, auth redirect targets, misc routes | no | ☐ |
| 7 | C4 auth/session/invite/OTP | F003, F004, F010, F012, F013, F033, F-OTP | `actions/auth/*`, `actions/organization/*`, `actions/admin/access.ts`, `packages/database/auth/*` | C5/C33 part **yes** (two invite tables) | ☐ |
| 8 | C7 API-key model | N006 | `packages/web-backend/src/Auth.ts` (+ call sites) | **yes** (hash+prefix+revoke) | ☐ |
| 9 | C8 upload reliability | F006, F020, F021 | extension `upload.ts`, `useWebRecorder.ts`, `utils/upload-target.ts` | no | ☐ |
| 10 | C11 billing/Stripe | N003, N014, N019 | `plans.ts`, `app/api/settings/billing/*`, `app/api/cron/developer-storage/route.ts` | no (confirm tiers w/ owner) | ☐ |
| 11 | C10 dashboard/CapCard UI (Phase-1 replace) | F007, F016, L2 | `dashboard/Contexts.tsx`, `Layout/AuthContext.tsx`, `VideoThumbnail.tsx`, devtools config | no | ☐ (optional/last) |

**Notes:**
- Architectural clusters (C1 access model, C7 API-key, C5 invite tables): smaller surgical fix first (e.g. C1 = make bucket private + presign reads); deeper redesign only if owner confirms.
- C11 billing: ask owner whether paid tiers are even used in self-hosted before investing.
- Refuted findings (F005 CORS, etc.) — see QA_REPORT.md appendix; do NOT re-investigate.
- After all clusters: full `pnpm -F @cap/web build` + `biome check --write` (format) + re-run smoke + update QA_REPORT status → Step 5 hardening.
