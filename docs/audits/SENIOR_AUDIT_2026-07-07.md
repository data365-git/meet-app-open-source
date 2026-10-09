# data365 — Senior Critical Audit (2026-07-07)

Full-system review: not just "is the code correct" but "were smart choices made,
and are there clearly better paths". Evidence gathered by 4 parallel read-only
investigations (architecture/reliability, media pipeline, AI pipeline,
security/QA) plus live production measurements from this session.

## Verdict in one paragraph

The **authorization, crypto and per-feature logic are solid** — consistently
server-side ownership checks, proper password hashing, session revocation,
fail-loud translation. What is **junior-level is the operational skeleton**:
every long job runs fire-and-forget inside the web container and dies on every
deploy; nothing gates deploys; product quality (AI output) is unmeasured;
storage integrity is verified but failures are only logged. Most production
incidents this project has suffered (frozen videos, 45× re-billed retries,
NoSuchKey playback errors, flaky login) trace back to these four systemic
gaps — not to feature bugs.

---

## 🔴 Critical (systemic — cause of most past incidents)

### 1. No durable job engine — and ironically, one is installed but DISABLED
- `workflow@4.2.0-beta.73` (Vercel durable workflow engine) is in
  package.json and `next.config.mjs` imports it — but `withWorkflow` is never
  applied ("Workflow plugin disabled" comment). All transcription/AI runs via
  `after()` fire-and-forget in the web container.
- `"use workflow"` / `"use step"` directives in workflows/transcribe.ts are
  decorative — no engine executes them as checkpoints.
- recover-cron only flips stale jobs to ERROR after 60-90 min; it never
  retries. Recovery = user manually re-clicks.
- **Consequence chain already paid for:** deploy-killed jobs (07-04 incident),
  Batch/Arzon removal (E1), 45×-transcription token waste (E2), "deploy fear".
- **Smart choice?** No — this is THE structural flaw. The checkpoint-resume
  work (fc659f1) is a good patch but treats the symptom.
- **Better path:** either (a) actually enable the installed workflow engine,
  or (b) a second Railway worker service polling a DB job table (jobs survive
  restarts; web stays responsive). (b) also fixes #7.

### 2. Nothing gates production — every push deploys, CI runs no tests
- ci.yml runs typecheck + biome only. 83 unit-test files exist; **none run in
  CI**. e2e can't run in CI (needs pre-started server).
- Railway auto-deploys on push **independent of CI outcome** — a red CI still
  deploys.
- **Better path:** run vitest in ci.yml; gate Railway on the CI check (Railway
  "wait for CI" or branch protection); deploys currently also kill in-flight
  jobs (#1 compounds).

### 3. Storage integrity: verified, then ignored — the NoSuchKey root
- multipart.ts:471-484: after S3 multipart complete, a HEAD-object verify
  runs — **on failure it only logs and proceeds** to mark the video uploaded.
  This is the exact birthplace of "video exists in DB, file missing in S3" →
  "Ijro etiladigan video manbasi topilmadi".
- No reconciliation job exists (DB rows ↔ S3 objects never cross-checked).
  Orphan marking is client-side best-effort only (dies with the tab).
- Import path is **single-shot XHR** (3 whole-file attempts) while the
  recorder path has proper multipart+resume — large mobile imports are
  fragile by design; UI says "any size".
- **Better path:** fail the completion when HEAD-verify fails; nightly
  reconciliation cron; reuse the existing multipart uploader for imports.

### 4. The product's heart (AI output quality) is unmeasured
- No eval harness, no golden transcripts, no WER sampling, prompts unversioned
  (quality history lives in code comments). Coverage metrics check "cues span
  the timeline", never "are the words/numbers right".
- Primary models are **hardcoded preview builds** (`gemini-3-flash-preview`)
  across 7+ files; transcription has a 3-model fallback but **summary/refine
  has none** — a Google deprecation bricks summaries instantly (they already
  retired gemini-2.0-flash once, noted in code).
- No vendor abstraction at all — Gemini response shapes parsed inline
  everywhere; switching vendors = touching every call site.
- **Smart choice?** Gemini-only for speed-to-market: defensible. No eval + no
  fallback + preview-as-primary: not defensible for the flagship feature.
- **Better path:** (a) golden-set eval (3-5 reference videos + the retention
  harness `_audit-refined.mjs` built this session, run on every prompt/model
  change); (b) fallback model list for callAiApi like transcription has;
  (c) a thin `callLLM()` adapter as the single seam.

---

## 🟠 Serious

5. **Share links public by default** (`CAP_VIDEOS_DEFAULT_PUBLIC=true`).
   Anyone with the link views the video. Directly tensions the product's
   privacy positioning ("videos belong to the owner"). IDs are unguessable
   (33^15), so exposure = link leakage, not enumeration. → Product decision:
   flip default to private or make it an org setting.
6. **Login has zero brute-force protection** (no throttle/lockout in
   authorize()) — ironically the video-password flow HAS one. Plus the known
   no-pool DB client (E9) masking DB errors as "wrong password" (fix already
   diagnosed, awaiting go). → pool + throttle + distinguish DB-error.
7. **One container does everything** — web serving + ffmpeg + AI loops. Heavy
   extraction degrades all users; crash takes traffic AND jobs down. → worker
   split (same move as #1b).
8. **Extension distribution + tail-loss**: sideloaded zip = no auto-update
   (every fix requires manual re-install — already bitten twice); MV3 SW
   eviction silently loses the unflushed sub-5MB tail of a recording, and
   MIN_VIABLE_BYTES counts bytes that may not have been durably uploaded.
   → Chrome Web Store + persist the pending buffer (storage.local/IndexedDB).
9. **No backups verified, no alerting**: no repo evidence of DB backup
   config; errors are console-only (OTel→Axiom exists but only if
   AXIOM_TOKEN is set — unverified in prod; no Sentry/paging). A silent
   nightly failure would be discovered by users.
10. **No rate limiting on expensive endpoints** (generate/upload/transcribe).
    The $-budget cap bounds total spend but not burst/CPU abuse;
    reprocess:true bypasses the already-running short-circuit.

## 🟡 Improvements (right-sized, not urgent)

11. ffmpeg-wasm: loads the ENTIRE file into wasm memory (mobile OOM near the
    100MB gate); core fetched from unpkg CDN (corporate networks break it);
    non-MP4 files re-encode even when untrimmed. → raise skip-conditions,
    bundle core locally.
12. Embeddings in MySQL with JS cosine scan — actually a **smart-enough
    choice at current scale**; revisit only past ~10⁵ chunks. But: stale
    embedding-model indexes are reused forever (no model-match check).
13. Prompts/thresholds: 8 inline prompts, hand-tuned magic numbers
    (MIN_CHUNK_COVERAGE=0.5 etc.) from single-video anecdotes — fine to keep,
    but version them and pin via the golden-set eval (#4a).
14. In-memory rate limiter (video password) breaks on multi-instance/restart;
    loom.ts hostname check is `includes("loom.com")` → tighten to suffix
    match. Both small.
15. `test-gemini-key` bypasses withCostGuard (tiny cost, zero record).
16. Boot-time auto-migration races if replicas ever >1 (benign-error list
    won't cover all codes).

## What was done RIGHT (credit where due)

- Authorization layer: consistently server-side, no client-trusted org/video
  ids found across the 5 most sensitive mutations. Best part of the codebase.
- Crypto: PBKDF2-100k video passwords, bcrypt logins, AES-256-GCM for stored
  third-party credentials, session revocation via authSessionVersion.
- Translation pipeline: reuses the base summary (no re-billing per language)
  with strict count-validation that fails loud instead of dropping content.
- Transcription chunking: speaker-roster threading across chunks,
  best-of-N retry scoring, gap-fill — sophisticated, if heuristic.
- Checkpoint-resume on retry (fc659f1) and the cost guard with per-video caps.

## Recommended attack order

1. **Job engine / worker split** (#1 + #7) — everything else stands on it.
2. **CI gate + tests in CI** (#2) — cheap, immediately stops deploy-roulette.
3. **Storage verify-fail + reconciliation cron + multipart import** (#3).
4. **AI eval golden-set + summary model fallback** (#4) — protects the heart.
5. **Login pool + throttle** (#6, already diagnosed).
6. **Public-by-default decision** (#5 — 1-line change, but owner product call).
7. Then the 🟡 list opportunistically.

*Method note: findings 1-16 each carry file:line evidence in the four scout
reports (session transcripts); live measurements (refined retention, 1024px
breakpoint repro, folder-orphan sweep) were done against production data.*
