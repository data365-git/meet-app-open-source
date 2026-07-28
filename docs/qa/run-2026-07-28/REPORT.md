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

## Deploy — v0.5.5 IS LIVE (owner approved, 2026-07-28)

| check | result |
|---|---|
| Prod container image | ✅ `f43c7d3` (was `16a93d8`), landed ~19 min after trigger |
| `/api/health` | ✅ `db:ok`, `storage:ok` |
| Served `365-extension.zip` | ✅ **v0.5.5**, and the fix is **inside the served bundle** (`stale-session` present in its `background.js`) — what the team downloads actually contains it |
| Anon surfaces `/login /signup /terms /privacy` | ✅ all 200 |
| CORS — extension upload preflight | ✅ `OPTIONS` from a `chrome-extension://` origin → **204 with ACAO + ACAC + methods + headers**, so the upload path the recorder depends on is intact |
| CORS — evil origin preflight | ✅ 204 with **no `Access-Control-Allow-Origin`** → the browser blocks it (the lone ACAC is the known non-exploitable E2b backlog item) |

## Cost pass — DONE (read-only, prod DB)

| question | answer | evidence |
|---|---|---|
| July spend | **$6.16** (834 calls) vs June $0.43 | `ai_usage_events` grouped by month |
| Is there structural waste? | **No.** The spike is the known one-time dev cost: transcription of a handful of videos re-run many times in July to verify the drift fix ($5.03 of the $6.16 is transcription). | grouped by operation+model |
| Is the free tier actually saving? | **Yes** — 57 calls on `gemini-3.5-flash` billed **$0.00** | same query |
| Any runaway / retry loop? | **No.** The only recent charge is 2026-07-27: ONE recording (`ck0sfkg6zxdmpfc`) transcribed once (19 chunks) + summarised once = **$0.46**, no repeats. | grouped by videoId, first/last timestamp 3 minutes apart |
| Videos in a bad state | **0 errored, 0 stuck processing** (25 videos, 9 transcribed) | `videos` status counts |

## Unplanned finding — the owner's 2026-07-27 recording is HEALTHY

Checked because the corruption bug makes every fresh recording suspect. The stored object for
`ck0sfkg6zxdmpfc` begins `00 00 00 1c 66 74 79 70` — **`ftyp` at offset 0**, i.e. a well-formed MP4.
The 07-23 broken one began with a `moof` (its `ftyp` sat 532 KB in). So:
- The corruption is **intermittent**, not systematic — it needs the second-session overlap, which
  matches the root cause exactly.
- A recording made on v0.5.4 the day before this fix played fine, and its transcript + summary cost a
  normal single-pass $0.46.

## Recording path — the owner's #1 requirement, hammered

**Real-browser proofs on the deployed build** (headed Chromium, a fake Meet page, tone measured in the
recorded file — a machine verdict, not an opinion):

| proof | result |
|---|---|
| `PROOF_SECOND` — record, stop, **record AGAIN on the same call** (the exact bug that hit the owner) | ✅ **PASS** — recording #1 **−23.9 dB**, recording #2 **−23.9 dB** (threshold −50). The remote voice is on BOTH. |
| `PROOF_SWAP` — Meet swaps its media elements mid-call (the 2026-07-20 silent-tap trap) | ✅ **PASS** — 4 segments, **0 silent**, steady ≈−16.7 dB across all of them |

**Failure-mode sweep (8 modes traced through the real code, independent agent, then spot-verified):**

| # | mode | verdict |
|---|---|---|
| 1 | Meet tab reloaded mid-recording | ⚠️ DEGRADED (full-screen path only) |
| 2 | Network drops and returns before Stop | ✅ SAFE — chunks queue durably, retry alarm drains them |
| 3 | Chrome's own "Stop sharing" bar | ✅ SAFE — identical to the app's Stop |
| 4 | Pause → Resume → Stop | ✅ SAFE — pause only persists if the recorder acked |
| 5 | Service worker evicted mid-recording | ✅ SAFE — persisted state + buffer restore; ~2 s tail at risk |
| 6 | Mic denied / prompt unanswered | ⚠️ was DEGRADED → **FIXED this run** |
| 7 | Remote participant joins AFTER start | ✅ SAFE — re-tap within ~1 s |
| 8 | Call ends while still recording | ✅ SAFE — auto-stop + finalize, or ask on the full-screen path |

- **Mode 6 FIXED:** the mic is best-effort with an 8 s deadline (so a permission prompt can never hang
  the start) — but a denied/unanswered mic used to produce a recording missing the OWNER'S OWN voice
  and report ordinary success. It now says so on screen. A partial failure must never look like a win.
- **Mode 1, honest limitation, NOT fixed:** on the FULL-SCREEN path only, reloading the Meet tab loses
  the remote voice for the remainder; a banner + notification already warn, but no re-attach is
  attempted. The owner's actual flow is the in-page "Record now" path, which auto-saves the first half
  and tells the user to start again. Fixing it means re-minting a tabCapture streamId after the reload,
  which can fail if the activeTab grant died — a separate, testable change, not a quiet patch.

## Live security pass (prod, owner-approved writes — all reverted)

| test | result |
|---|---|
| **E10 — private video vs a stranger** | ✅ PASS. With `public=0`: the media endpoint returns **401** (video cannot be fetched) and the page shows *"This video is restricted"* with a login/password gate. The real title did **not** leak (actual name `data365 Meeting – qxs-wgzz-tzy`; the page rendered only a generic string). Video **restored to `public=1`** and re-verified. |
| **M-DEL — delete-account really erases** | ⛔ NOT RUN. It needs a disposable account, and creating accounts / entering passwords is outside what I may do even with the owner's approval. Code-verified + Fable-approved only — this one is genuinely an owner task. |

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
