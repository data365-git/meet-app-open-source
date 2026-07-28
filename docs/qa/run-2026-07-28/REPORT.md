# Production-readiness re-audit — run 2026-07-28

Live document. Every line states the command or artefact that proves it; anything not proven says so.
Plan: [`docs/plans/2026-07-28-production-ready-audit.md`](../../plans/2026-07-28-production-ready-audit.md).

## Phase A — the recorder corruption bug (the reason for this run)

| item | status | evidence |
|---|---|---|
| Root cause identified | ✅ | `RECORDER_CHUNK/STOPPED/ERROR` carried no recording identity; verified in code, not taken from the 07-23 handoff on trust |
| Regression test written FIRST | ✅ | F2 block in `sw.test.ts`: **RED before the fix (4 failing) → GREEN after** |
| Fix implemented | ✅ | `bad5338` + `4ab247c` |
| Independent review round 1 | Fable SHIP-WITH-FIXES (4 defects, all fixed) · Codex **BLOCK** (9 defects) | both non-authoring, different model families |
| Independent review round 2 | Fable SHIP-WITH-FIXES (5) · Codex **BLOCK** (6) | all 13 closed in `4ab247c` |
| Independent review FINAL | **Fable: SHIP** — "could not construct a sequence that corrupts, truncates or loses a recording, leaks media hardware, or refuses a legitimate start/stop" | 3 residuals, all below the bar, recorded in the plan §3b |
| Codex FINAL | ⏳ running at time of writing | |

## Phase B — gates (re-run on this build)

| gate | result | command |
|---|---|---|
| Extension unit suite | ✅ **145/145** | `npx vitest run` in `apps/browser-extension` |
| Web unit suite | ✅ **1181 passed, 26 skipped, 0 failed** | `pnpm --filter @cap/web run test` |
| Root typecheck | ✅ **exit 0** | `pnpm typecheck` |
| Production build | ✅ **exit 0**, full route table emitted, no errors | `pnpm --filter @cap/web run build` |
| EOL/CRLF churn | ✅ none | `git diff --shortstat` vs `-w` |
| Extension packaged | ✅ v0.5.5, both zips identical, and verified to CONTAIN this round's markers (`start-in-flight`, `retired while queued`) — written AND wired | `unzip -p … background.js \| grep` |

## Still to do (nothing below is claimed as done)

- Codex final verdict → fold in any blocker.
- **Deploy v0.5.5** (owner-gated) → then ONE 2-minute smoke recording before the team is told, per the
  deploy-risk shape in the plan §3b.
- Static sweep (`vibecoding-antipatterns`) + 9-layer `qa-harden` pass.
- Live pass on the deployed build, including the three fixtures the 07-22 QA admitted it never covered
  live: `public=0` video (E10), password video (E11), disposable user for delete-account (M-DEL) —
  **these need prod writes, so they need the owner's consent, asked once.**
- **Concurrency pass** — every recording-related test run TWICE in one session. This is the gap that
  let the corruption bug through: the 07-22 61-test QA only ever exercised ONE recording.
- Cost pass (`ai_usage_events`, caps still enforced, ≤ $2 envelope for timestamp + model eval).
- Handover pass (RUNBOOK reproducible, STATE truthful, owner QA script matches the shipped build).

## Honest notes

- The 07-22 run's real score was **~38 clean live passes + ~10 code-read**, not "42 passed"; this run
  does not inherit that number.
- No verdict of "production ready" will be given until the owner's own 2-person Meet test passes on
  the deployed build. No machine can substitute for it.
