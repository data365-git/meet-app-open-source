# PLAN — 2026-07-28: whole-project re-audit → production ready

Owner directive (2026-07-28): *"barcha muammoni hal qil va keyin butun loyihani qayta audit qilib
production ready qil."* Phase A (the recorder corruption bug) is being closed first; this document
is Phase B — the re-audit — and exists so the audit is a *measured* pass, not a vibe.

## 0. Why a RE-audit, when there was a 61-test QA on 2026-07-22

Because that run's own verdict was conditional and the build has moved since:
- Its honest score was **~38 clean live passes + ~10 code-read-only**, not "42 passed" — the QA
  workflow's blanket no-prod-writes rule overrode the plan's sanctioned-writes clause.
- Coverage gaps it recorded: no `public=0` video, no password video, no ERROR video on prod, so
  **E10/E11/P6 were code-read, never live**; **M-DEL** (delete account) was never live-run.
- Since then the product changed materially: v0.5.4 (English UI + web default locale) **and** the
  v0.5.5 recorder-identity fix, which touches the single most important path in the product.
- The 07-22 QA could not have caught the corruption bug at all: it tested one recording at a time,
  and the defect needs a SECOND session. That is the audit's most important lesson — see §3.

## 1. Definition of "production ready" (owner's words, from the handover goal)

(a) post-recording AI results (summary/chapters/action-items/chat) correct · (b) the recording is
captured accurately, including the OTHER person's voice · (c) no money waste or malfunction ·
(d) proven by a live test plan executed against the deployed build · (e) timestamp on the free path
(~5-10 s target) · (f) newer Gemini models evaluated. Client = the internal IT team only.

**A gate is only "passed" when a script or a saved artefact says so.** No self-assessment, no
"looks right". Every claim in the final report cites its evidence file.

## 2. Order of work

**A. Close the recorder bug (in progress).** v0.5.5 + both independent reviews clean → deploy →
owner's 2-person Meet test (the one thing no machine can do).

**B. Re-audit, in this order (cheapest signal first):**
1. **Static sweep** — `vibecoding-antipatterns` mechanical pass over the whole repo, then the
   `qa-harden` 9-layer audit (security incl. OWASP A01/A05/A07/A08/A10, perf INP/LCP/CLS, a11y,
   offline/SW lifecycle, rollback, data-erasure cascade, visual regression, usability friction).
2. **Gate re-run** — root typecheck, full web + extension suites, build, CRLF check.
3. **Live pass on the deployed build** — re-run the 07-22 plan's still-relevant tests, and CLOSE its
   three admitted gaps with real fixtures: a `public=0` video (E10), a password video (E11), a
   disposable user for delete-account (M-DEL). These need prod writes → **owner consent required**
   (asked once, as one question, not three).
4. **Concurrency pass (NEW — this is what 07-22 missed)** — every test that involves recording is run
   TWICE in the same session: two recordings on one call, a start while another is arming, a stop
   from a stale tab. The corruption bug existed because nothing ever exercised session #2.
5. **Cost pass** — re-read `ai_usage_events` for the month, confirm no structural waste, confirm the
   $100/org + $20/video caps still hold, and that the timestamp/model-eval work stays inside the
   **$2** envelope the owner set.
6. **Handover pass** — RUNBOOK accuracy (a fresh person can deploy + roll back), STATE truthfulness,
   and the owner-facing QA script matching the shipped build.

## 3. The audit's own rule, learned from this bug

A test that exercises a feature ONCE cannot find a defect that needs a SECOND instance of it. So for
every stateful surface (recording, upload, AI job, cron, session) the audit asks: *what happens the
second time, while the first is still finishing?* That question, not more test count, is what would
have caught the interleaved recording.

## 4. Reporting

One report at `docs/qa/run-2026-07-28/REPORT.md`: per-gate PASS/FAIL, the command or artefact that
proves it, and a single honest verdict — including what was NOT covered and why. Blockers separated
from shoulds. If the verdict is not "production ready", it says so plainly.
