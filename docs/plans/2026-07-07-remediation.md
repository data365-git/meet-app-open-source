# Remediation plan — operational skeleton (grill session 2026-07-07)

Source: docs/audits/SENIOR_AUDIT_2026-07-07.md. Decisions locked with the owner
one-by-one; this file is the running record.

## Decisions (locked)

**D0. Share links + AI chat stay PUBLIC by default.** Owner product call —
audit finding #5 closed as as-designed. Link secrecy (33^15 ids) is the gate.

**D1. Jobs: free fix now, worker later.**
- NOW (option C): recover-cron upgraded from "mark ERROR" to AUTO-RETRY —
  a stale PROCESSING job is re-kicked (transcription resumes from the saved
  partial checkpoint, so no re-billing). $0.
- LATER (option A, logged as backlog): dedicated Railway worker service +
  DB-backed job queue; removes the deploy-kills-jobs class entirely.
  (~$5-10/mo + ~2-3 days.) Trigger word from owner when ready.

**D2. CI: FULL gate (option A).**
- ci.yml runs vitest (unit) in addition to typecheck+lint.
- Railway deploy must WAIT for CI green (check-gated). Red CI = no deploy.

**D3. Storage integrity: 3a+3b now, 3c later.**
- 3a NOW: multipart complete's HEAD-verify failure BLOCKS completion
  (currently it only logs — the NoSuchKey birthplace).
- 3b NOW: nightly reconciliation cron (DB video rows ↔ S3 objects).
  Orphans are marked ERROR + surfaced to the owner. NOTHING is auto-deleted.
- 3c LATER (backlog, pairs with D1-A): import path gets multipart+resume by
  reusing the recorder uploader.

**D4. AI eval: both, now.**
- 4a: golden-set eval — start with 2 videos picked by the assistant (28-min
  business + 10-min quick), owner adds 1-2 number-heavy ones later. Retention
  harness (_audit-refined.mjs) becomes the scorer; run on every prompt/model
  change. ~$0.05-0.3 per eval run.
- 4b: summary/refine calls get the same model-fallback list transcription
  already has (currently a Google preview-model retirement would brick
  summaries instantly).

**D5. Login fix: all 3 parts together (security-critical, gated).**
- mysql.createPool (auto-reconnect) replaces the memoized single connection.
- authorize() distinguishes DB failure ("system error, retry") from a real
  wrong password — no more lying 401s.
- Brute-force throttle on credentials login: ~10 consecutive failures per
  ip/email → 5-min lockout (currently unlimited attempts).
- Ship gate: tsc/build/tests + LIVE login-loop test against prod.

**D6. Extension: 6a only.**
- 6a NOW: fix SW-eviction tail loss — persist the pending sub-5MB buffer
  (chrome.storage.local/IndexedDB) so an evicted service worker no longer
  silently drops the recording tail; MIN_VIABLE_BYTES counts durable bytes.
- 6b DECLINED (owner re-confirmed): stays zip-distributed, no Chrome Web
  Store. Consequence accepted: every extension fix requires users to
  manually re-download + reinstall the zip.

**D7. Backups + alerting: both, $0 stack.**
- 7a: nightly GitHub-cron mysqldump → existing R2 bucket, 30-day retention;
  restore drill performed once to PROVE recovery works.
- 7b: Telegram alert bot (owner creates via BotFather, ~2 min) pinged on
  exactly 3 events: health check down · job dead after auto-retry ·
  reconciliation found a broken video. No other noise.

**D8. Rate limiting: minimal — reprocess only.**
- Re-analysis capped at 3/hour per video. No other endpoint limited
  (internal team + $-caps + new cost-confirm dialog cover the rest).

## Execution order (all $0, dependency-driven)

**Wave 1 — quick wins:** D2 CI gate · D3a verify-block · D4b summary
model fallback · D8 reprocess limiter.
**Wave 2 — recovery loop:** D1-C recover-cron auto-retry · D3b nightly
reconciliation · D5 login fix (security-gated, live login-loop test).
**Wave 3:** D7a backup cron + restore drill · D7b Telegram alerts (needs
owner's BotFather token) · D6a extension buffer persist (zip rebuild +
owner reinstall) · D4a golden-set eval.

**Backlog (deliberately later):** D1-A worker service · D3c import
multipart · import-flow UX shortening (picker-first button, agreed
2026-07-07) · audio-video isAudio backfill (awaiting owner confirming
which video is the audio test).

Ownership: D5 login + D4b generate-ai fallback = main-session work
(security/correctness-critical); the rest is spec'd to subagents with
main-session diff review. Every wave ships behind the new CI gate.
