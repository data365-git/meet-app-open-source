# Production-readiness SCORECARD — data365 @ deployed `f2e64a6` (2026-07-15)

Method: 4 read-only evidence-based audit agents (command+output), pinned to the deployed
commit. Precedence: Security > Legal > Data-loss > Correctness > UX > Performance > Style > Speed.
A floor FAIL ⇒ NOT ready, no override.

## VERDICT: ❌ NOT PRODUCTION-READY — multiple floors open (Security, Legal, Data-loss, Ops)

The app's engineering is genuinely solid (auth/isolation, signed media, cost caps, green tests,
stable prod). What's missing is **launch hygiene**: legal handling of third-party recordings,
recording backup, outage detection, an operator runbook, and secret rotation.

## Gate results
| Gate | Verdict | Blockers |
|------|---------|----------|
| G1 Security | ❌ FAIL | admin password cleartext in git HISTORY (rotate to clear). App-layer PASS (no IDOR, signed URLs, rate-limited/fail-closed cron+password, DB not internet-exposed). |
| G2 Legal/Privacy | ❌ FAIL | (a) free-tier Gemini key live → 3rd-party meeting audio to a trainable/human-review tier; (b) no record-time consent notice; (c) "delete" is soft-only, `permanentlyDelete` has ZERO callers → R2 recordings orphaned forever + no retention policy. |
| G3 Data-loss | ❌ FAIL | recordings = single R2 copy (no backup); DB backup sits in the SAME bucket (one failure domain); restore never test-run. |
| G4 Correctness | ✅ PASS (code) / ⛔ BLOCKED (flows) | 11 fixes present+correct in `f2e64a6`; tsc 0, vitest 895, prod 0-restart. FLAG: repeating prod S3 `InvalidPart: non-trailing parts must have same length` on some uploads — possible silent recording-loss. Live flows owner-gated. |
| G5 UX | ⛔ owner-gated | headless can't walk the auth-gated dashboard — owner phone-walk. |
| G6 Performance | ✅ PASS | health ~0.35s, share ~64KB/0.5s, bounded AI cost, no N+1; holds at ~20 concurrent. |
| G7 DevOps | ❌ FAIL | down-alert workflow is on `qa-fixes` not `main` (scheduled workflows run only from default branch → NEVER fires) + secrets unset; no RUNBOOK (rollback/restore/rotate) for a non-programmer operator; VPS reboot pending (staged security update). |

## FIXABLE BY ME (code/config — no owner-only access)
1. **Down-alert** (G7): move `.github/workflows/uptime-alert.yml` onto `main` (needs a push to `main` — owner OK). [my earlier miss: I put it on qa-fixes]
2. **RUNBOOK.md** (G7): copy-paste rollback + DB-restore-from-R2 + rotate-each-secret.
3. **Deletion/erasure** (G2): wire `Videos.permanentlyDelete` to a purge (trash "delete now" action or a cron) so delete actually erases R2 objects; publish a retention period.
4. **Consent notice** (G2): add a record-time "this meeting is being recorded + sent to AI" string (recorder + extension + i18n).
5. **Transcript delimiters** (G1 LOW): wrap transcript as `<untrusted_transcript>` data in Gemini prompts.
6. **S3 multipart bug** (G4/G3): investigate the recorder's variable part-size; fix so non-trailing parts are equal-sized ≥5MB. (needs code dig — may be its own task.)

## OWNER-ONLY (no audit/agent can clear these)
1. 🔴 **Rotate the live admin password** (G1 floor — makes the git-history leak useless).
2. 🔴 **Free-tier Gemini** (G2 floor): remove `GEMINI_API_KEY_FREE` from the live Coolify env (instant, safe fallback to paid, byte-identical) OR get a no-training agreement. — this is CONFIG on the box; owner does it (or authorizes me via SSH).
3. 🔴 **Recording backup** (G3 floor): enable R2 versioning + object-lock; replicate the nightly DB dump to a second, separate destination.
4. 📱 **Device/flow tests** (G4): real record→upload→process (confirm the S3 error doesn't drop recordings); extension v0.3.2 on a real Meet; guaranteed-client-audio on a real 2-person Meet; dashboard phone-walk (G5).
5. **VPS reboot** for the staged security update (G7); **firewall** Coolify admin ports 8000/8080/6001/6002 (G1 MEDIUM infra).
6. **Domain** (non-legal adoption blocker): move off `*.duckdns.org` (Chrome "Dangerous site" risk).

## Path to READY (order)
Security+Legal floors first (rotate password · unset free key · wire deletion+consent) →
Data-loss (recording backup) → Ops (down-alert on main + RUNBOOK + reboot) → S3-upload fix →
owner device/flow tests → re-audit the changed gates. Then a real "ready" verdict.
