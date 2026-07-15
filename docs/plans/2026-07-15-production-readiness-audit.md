# Production-readiness audit — data365 (Contabo live)

Goal: a defensible YES/NO on "is data365 production-ready for the owner's IT team?",
with evidence per gate. Method: Production Handbook 8-gate model + qa-6-step for the
correctness gate. Precedence when gates conflict: Security > Legal > Data-loss >
Correctness > UX > Performance > Style > Speed (a floor failure = NOT ready, no override).

Live target: `https://data365.duckdns.org` (Contabo). Current prod image = `f2e64a6`
(the 11-bug fix batch). NOT yet on prod: `7c77b2a` (cron guard), `4ab9a46` (extension v0.3.2).

## Verdict rule
Ready = every gate PASS **and** every owner-floor cleared. Any Security/Legal/Data-loss
floor open ⇒ NOT ready (report it, don't soften). Owner-gated items that only the owner
can do are called out explicitly — the audit reports them as blockers, it cannot clear them.

## Gates & what to verify (evidence required, not assertions)

### G1 — Security (FLOOR)
- 🔴 KNOWN BLOCKER: admin password was cleartext in docs + git HISTORY; not rotated.
  Owner must rotate in the live app. Audit verifies: `git log -S` for any remaining
  secrets in tracked files; `.env`/secrets not committed; auth guards on admin routes.
- Authn/z: session handling, admin-only route protection, CRON_SECRET on cron endpoints,
  share-link password paths, org permission checks. Run `/security-review` on the branch.
- Headers/CORS, rate-limiting on auth, no secrets in client bundles / logs.

### G2 — Legal / Privacy (FLOOR)
- 🟡 KNOWN: duckdns domain triggers Chrome "Dangerous site" (Safe-Browsing). Blocks trust.
- Privacy: recordings contain meeting audio/video of third parties — consent notice?
  data retention? Terms/Privacy pages exist and load (STATE notes a stale `/terms` 404).

### G3 — Data-loss / Reliability (FLOOR)
- Verify the nightly DB backup cron actually ran recently (R2 `db-backups/` has a fresh dump);
  restore path is documented. Confirm additive-only DB migrations. Multipart upload
  resilience (partial-save on interruption). Confirm no data-loss path in the recorder.

### G4 — Correctness / QA (run qa-6-step on the live build)
- Full user-flow QA of every screen as a new user: auth, dashboard, record→upload→process,
  AI analysis, share page + players, settings, org/members, i18n (uz/ru/en).
- Regression check the 11 just-fixed bugs are actually fixed on live `f2e64a6`.
- Recorder core (owner-gated device test — headless can't do getDisplayMedia/Meet):
  extension v0.3.2 confirm-then-start, mute→recover, tab-close→continue, one-click screen;
  AND the never-verified guaranteed-client-audio on a real 2-person Meet.

### G5 — UX
- Mobile + light/dark walk of every screen; empty/loading/error states; one primary action
  per screen; no AI-slop. Owner phone-walk for the auth-gated dashboard.

### G6 — Performance
- `/api/health` latency; share-page + player load on mobile; AI pipeline ETA sanity;
  no obvious N+1 / unbounded queries on the hot paths; bundle size of the share page.

### G7 — DevOps / Observability
- Deploy + ROLLBACK path proven (how to revert a bad image fast); `/api/health` monitored;
  🟡 KNOWN: Telegram down-alert needs `TELEGRAM_ALERT_CHAT_ID`. Log retention; error surfacing.

### G8 — Release hygiene
- Deploy the two pending commits (`7c77b2a`, `4ab9a46`) only AFTER their gates
  (cron: harmless/dormant; extension: owner device-test). Version/zip integrity.

## Execution shape (after Fable approves THIS plan)
Parallel read-only audit agents, one per technical gate (G1,G3,G6,G7 code/infra) + a
qa-6-step pass for G4, each returning PASS/FAIL + evidence. I verify findings, compile a
scored scorecard. Owner-gated items (password, device tests, phone-walk, duckdns) listed as
blockers. Then Fable reviews the RESULTS + verdict. Ready only when floors + owner-items clear.

## Two Fable gates (owner directive)
1. Fable approves THIS plan (coverage, method, no missed gate) BEFORE execution.
2. Fable approves the RESULTS + the ready/not-ready verdict AFTER execution.
