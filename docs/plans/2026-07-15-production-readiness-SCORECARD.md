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
| G3 Data-loss | ❌ FAIL | recordings = single R2 copy (no backup); DB backup is a SEPARATE bucket but SAME R2 account/provider (single failure domain — gate-2 C2); restore never test-run. |
| G4 Correctness | ✅ PASS (code) / ⛔ BLOCKED (flows) | 11 fixes present+correct in `f2e64a6`; tsc 0, vitest 895, prod 0-restart. NOTE (gate-2 C3): the multipart fix (equal 16MB parts + regression test) is ALREADY in `f2e64a6` — the observed prod `InvalidPart` errors are likely STALE/pre-fix logs; VERIFY they've stopped + no secondary upload path varies part size (not an open code bug). Live flows owner-gated. |
| G5 UX | ⛔ owner-gated | headless can't walk the auth-gated dashboard — owner phone-walk. |
| G6 Performance | ✅ PASS | health ~0.35s, share ~64KB/0.5s, bounded AI cost, no N+1; holds at ~20 concurrent. |
| G7 DevOps | ❌ FAIL | down-alert workflow is on `qa-fixes` not `main` (scheduled workflows run only from default branch → NEVER fires) + secrets unset; no RUNBOOK (rollback/restore/rotate) for a non-programmer operator; VPS reboot pending (staged security update). |

## FIXABLE BY ME (code/config — no owner-only access)
1. **Down-alert** (G7): move `.github/workflows/uptime-alert.yml` onto `main` (needs a push to `main` — owner OK). [my earlier miss: I put it on qa-fixes]
2. **RUNBOOK.md** (G7): copy-paste rollback + DB-restore-from-R2 + rotate-each-secret.
3. **Deletion/erasure** (G2): wire `Videos.permanentlyDelete` to a purge (trash "delete now" action or a cron) so delete actually erases R2 objects; publish a retention period.
4. **Consent notice** (G2): add a record-time "this meeting is being recorded + sent to AI" string (recorder + extension + i18n).
5. **Transcript delimiters** (G1 LOW): wrap transcript as `<untrusted_transcript>` data in Gemini prompts.
6. ~~S3 multipart bug~~ → **VERIFY-ONLY** (gate-2 C3): fix already deployed (16MB equal parts + test in `f2e64a6`); just confirm the prod `InvalidPart` errors stopped after that deploy + no secondary upload path varies part size. Not an open code fix.
7. **`getFolderVideoIds` info-leak** (G1 LOW, gate-2 C5): add a folder/space-membership guard — it currently enumerates video IDs by folderId with only a logged-in check (leaks IDs, not content).

## OWNER-ONLY (no audit/agent can clear these)
1. 🔴 **Rotate the live admin password** (G1 floor — makes the git-history leak useless).
2. 🔴 **Free-tier Gemini** (G2 floor): remove `GEMINI_API_KEY_FREE` from the live Coolify env (instant, safe fallback to paid, byte-identical) OR get a no-training agreement. — this is CONFIG on the box; owner does it (or authorizes me via SSH).
3. 🔴 **Recording backup** (G3 floor): enable R2 versioning + object-lock; replicate the nightly DB dump to a second, separate destination.
4. 📱 **Device/flow tests** (G4): real record→upload→process (confirm the S3 error doesn't drop recordings); extension v0.3.2 on a real Meet; guaranteed-client-audio on a real 2-person Meet; dashboard phone-walk (G5).
5. **VPS reboot** for the staged security update (G7); **firewall** Coolify admin ports 8000/8080/6001/6002 (G1 MEDIUM infra).
6. **Domain** (non-legal adoption blocker): move off `*.duckdns.org` (Chrome "Dangerous site" risk).

## GATE-2 (Fable) — VERDICT TRUSTWORTHY, corrections applied
Independent re-verification confirmed the NOT-READY verdict and the top floors (free-tier Gemini
tried-first, permanentlyDelete 0 web callers, IDOR-clean, down-alert not on main). Corrections folded:
- C1: the *web* delete is soft-only; the *desktop-app* endpoint (`/api/desktop/.../delete`) DOES hard-delete R2. Finding holds for data365's primary web/extension surface.
- C2/C3: applied inline above (backup = same R2 account; S3 fix already deployed → verify-only).
- C4: **owner-decision framing** — for an INTERNAL-only team where every meeting participant consents, the free-tier-Gemini (G2a) and un-erasable-recording (G2c) items are "FAIL — owner may accept". Given Google Meet routinely has EXTERNAL participants, the floor default stands unless the owner confirms internal-only + gets consent.
- C5: `getFolderVideoIds` ID-enumeration (added as FIXABLE #7).
- C6: soft-delete-with-no-purge is also an unbounded **R2 storage-cost** growth path (every web-deleted recording pays R2 forever), not only a legal issue.
- **Single most important blocker (gate-2): rotate the leaked admin password** — a compromised admin credential walks around the otherwise-solid multi-tenant isolation at the front door. Owner-only.

## Path to READY (order)
Security+Legal floors first (rotate password · unset free key · wire deletion+consent) →
Data-loss (recording backup) → Ops (down-alert on main + RUNBOOK + reboot) → S3-upload fix →
owner device/flow tests → re-audit the changed gates. Then a real "ready" verdict.
