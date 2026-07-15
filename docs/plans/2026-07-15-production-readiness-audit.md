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

## GATE-1 REVIEW FOLDED (Fable, approve-with-additions) — 20 MUST-ADDS
All mandatory before execution. Handbook alignment: swap G-DevOps/Release framing to include
handbook gates **Product** (droppable for an internal tool — state so) and **Bus-factor/RUNBOOK**
(NOT droppable — one-owner hand-patched VPS). Every agent pins to the DEPLOYED commit `f2e64a6`,
returns command+output evidence (never prose), and I spot-check ≥1 evidence item per gate.

G1 Security: (1) LITERAL cross-org IDOR test — user A/org A vs user B/org B, hit B's video/folder/
share/member IDs as A, expect 403/404 on every type. (2) Share-link surface: `/s/<id>` entropy/
guessability, password brute-force rate-limit, expiry/revocation actually kills the link, and
whether R2 video/thumbnail URLs are SIGNED/expiring vs permanently public (public bucket = bypass).
(3) Secrets grep with NAMED patterns (sk_/AKIA/service_role/mysql:// + actual CRON_SECRET/admin pwd/
Gemini/ElevenLabs shapes) over built bundle + git history. (4) Prompt-injection: transcripts are
third-party input — delimited as data in Gemini prompts, AI output rendered escaped (no
dangerouslySetInnerHTML), pipeline has no tool access. (5) Pin `/security-review` to `f2e64a6`, note
delta to `7c77b2a`. (6) `pnpm audit` 0 crit/high; no routable /test|/debug|/api/dev; DB/Redis ports
not publicly reachable (external scan). + session-cookie httpOnly/Secure/SameSite.

G2 Legal/Privacy: (7) LLM data-processing — Gemini/ElevenLabs tier no-training/zero-retention +
processor inventory (Gemini, ElevenLabs, Contabo, R2, duckdns). (8) Retention+deletion as FACTS:
delete a test video → R2 objects actually gone? documented policy + working delete = PASS. (9) MOVE
duckdns Safe-Browsing OUT of Legal floor → G7/G5 launch blocker (real domain, not just a review req).

G3 Data-loss: (10) TESTED restore — restore freshest R2 dump into a scratch DB container + sanity
query (untested backup = doesn't exist). (11) Recordings live ONLY in R2 (DB dump doesn't cover them)
— verify bucket versioning/deletion-protection; state plainly recordings have no 2nd copy (3-2-1).
(12) VPS disk-full path — current disk %, 80% alert, log rotation.

G4 Correctness (method fix): (13) DEDICATED non-admin test user + test org for agents (NOT the leaked
admin pwd); enumerate agent-verifiable vs owner-gated items. (14) Live-prod write-safety: test-prefixed
artifacts confined to the test org + cleanup, no destructive ops on non-test resources.

G6/G7 Perf/DevOps: (15) COST CONTROL (absent before): Gemini billing caps/alerts, per-account/day
quota on paid AI endpoints (uncapped paid endpoint = attacker spends your money), bounded cron retries.
(16) Self-hosted ops floor: container restart:always + starts-on-reboot (docker inspect), TLS cert
auto-renewal + next expiry, OS patch cadence. (17) Alert TEST-FIRE: once TELEGRAM chat-id set, fire it
once → reaches phone; an external pinger hits /api/health from outside Contabo. (18) RUNBOOK/BUS-FACTOR
GATE (real gate, FAIL if absent): RUNBOOK.md with copy-paste rollback, DB-restore, rotate-each-secret.

G8 Release: (19) Extension distribution — published SHA-256 next to the zip + update procedure;
verify the LIVE `/365-extension.zip` version (gate says only device-tested reaches team).

Execution: (20) assign OWNERS to G2, G5, G8 (currently nobody) — an agent can check /terms 404,
processor inventory, public-page mobile/dark walk; owner walks auth-gated + billing console + domain.

Scorecard supports `FAIL — owner accepted` for non-floor gates only (a floor can NEVER carry it).
Top-3 verdict-critical must-adds: #13 (G4 auth = else QA is theater), #1 (cross-org IDOR = else
multi-tenant claim unproven), #10 (tested restore = else data-loss floor passes on paperwork).

## Two Fable gates (owner directive)
1. Fable approves THIS plan (coverage, method, no missed gate) BEFORE execution.
2. Fable approves the RESULTS + the ready/not-ready verdict AFTER execution.
