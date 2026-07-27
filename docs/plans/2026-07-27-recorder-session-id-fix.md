# PLAN — 2026-07-27: stop cross-recording chunk contamination (session-id stamping + stale-recorder teardown)

Status: **v2 — REVIEWED BY BOTH FABLE AND CODEX (independent, non-authoring, different model families), both
VERDICT = BUILD-WITH-FIXES. Their must-fixes are folded in below (§2bis). Not yet built.**
Branch `qa-fixes`, extension at v0.5.4.

## 0. What the two reviews changed (read this before §2 — §2 as originally written is INSUFFICIENT)

**Both reviewers independently converged on the same two points — treat these as settled:**
1. **The identity check must run INSIDE `enqueueRecorder`, against freshly-read state — not at the
   `sw.ts` handler edge.** A handler-edge check is time-of-check/time-of-use: chunk A passes the edge,
   B becomes live, then A's queued job mutates B. The codebase already documents this exact race in
   its own R7 guard (`upload.ts:897-911`), and I verified the hole myself: `handleChunk` (`upload.ts:837`)
   reads state and checks only `kind === "recording"` before `appendToBuffer` at `:843`.
2. **STRICT-DROP is correct** for a message with no `sessionId` while the live recording has one.
   Accept-if-absent re-opens the exact observed hole under a compatibility disguise. Budget for the
   strict-drop failure mode instead: a missed send site drops ALL that path's chunks → loud, immediate,
   test-catchable. Requires (a) every send site stamped, (b) a test that an unstamped chunk is dropped
   and warn-logged.

**Codex-only must-fixes (its model family caught what Fable's did not — the value of two families):**
3. **Bind the id during ARMING and make registration atomic** (`sw.ts:305`, `1208-1366`). `isInProgress`
   deliberately excludes `"arming"`, so two `RECORDER_STARTED` calls can BOTH initialize uploads —
   one upload is orphaned and the wrong recorder can claim the session.
4. **Define identity handling while arming, not only while recording** (`sw.ts:1396-1468`). A stale
   `RECORDER_ERROR(A)` arriving while B is arming currently overwrites B with an error and closes its
   offscreen document, because no live id exists yet to compare against.
5. **Ownership must cover every async start continuation, rejection and catch** — not just the recorder
   callbacks (`offscreen/recorder.ts:143-147,299,363-391`; `inpage-recorder.ts:427,601-620,678-685`;
   `recorder-page.ts:816,856-903`). Otherwise an older attempt cleans up the current session, or the
   accepted recorder becomes an unreachable orphan producing no accepted chunks.
6. **There are 20 send sites, not 18** — my grep count in §4 was wrong. Full list:
   `inpage-recorder.ts:275,563,575,588,602,683`; `offscreen/recorder.ts:253,265,278,364,376,385,401,419`;
   `recorder-page.ts:768,780,793,857,901,921`.
7. **`offscreen/recorder.ts:143-147` permits overlapping `START_CAPTURE`** while the first start is still
   awaiting media (state is still null), so a later call can destroy or orphan the first capture.

**Fable-only must-fixes:**
8. **The cross-context orphan is NOT neutralized by the `state !== mine` check.** That check only fires in
   a context whose module state was replaced; an orphaned offscreen document or leftover recorder tab has
   its own intact state, so `state === mine` and it emits forever — chunks dropped, but the recorder keeps
   running with the mic/share indicator lit. Fix: the SW's drop reply must say so
   (`{ok:false, reason:"stale-session"}`) and each sender must stop its recorder + release tracks on that
   reply. Note the chunk `sendMsg` calls are currently fire-and-forget — the response must be read.
9. **`RECORDER_ERROR(stale)` needs its own regression test** — it is the worst of the three: `sw.ts:1399-1419`
   flips state, runs a salvage `finalizeUpload`, and calls `closeOffscreenDocument()`, which would tear down
   a LIVE offscreen recording.
10. **Blast radius omits `src/background/state.ts`** — `recorderSessionId` is a new persisted field, plus the
    shared message type definitions. "Data: none" was wrong.

**Paths BOTH reviewers checked and cleared (recorded so nobody re-audits):** `sw.ts:1383` is the only caller
of `handleChunk`; `retryPendingUploads` / pending-buffer restore are keyed by `videoId`/`uploadId`;
`inMemoryBuffer` is reset at `initializeUpload` (`upload.ts:613`); pause/resume reuses the one MediaRecorder
per session, so one id per session is sound.

**Test list grows to:** interleaved two-session chunks (only live session's bytes land) · stale STOPPED does
not finalize · stale ERROR does not tear down a live recording · unstamped chunk against a stamped recording
is dropped + warn-logged · overlapping starts (both during arming and during an awaited start continuation) ·
a delayed `arrayBuffer()` resolving after the session was replaced · after the stale-session reply, the loser
recorder's tracks are actually released.
Bug evidence + root cause: [`docs/HANDOFF_2026-07-23_broken-recording.md`](../HANDOFF_2026-07-23_broken-recording.md).

## 1. The defect, restated

`result.mp4` for `2j1p57ysddveyrd` is TWO fMP4 streams interleaved (`19…31` woven with `1…13`,
the single `ftyp`+`moov` sitting 532 KB in), so the browser cannot parse it (`MediaError.code 4`).
Cause: `RECORDER_CHUNK` / `RECORDER_STOPPED` / `RECORDER_ERROR` carry **no recording identity**, and
`index` restarts at 0 per recorder — so the SW appends whatever arrives to whatever upload is live.
A MediaRecorder still alive from an earlier session wrote its fragments into the new recording.

**Verified independently this session (not taken on trust from the handoff):**
- `sw.ts:1377` (CHUNK) and `sw.ts:1390` (STOPPED) do no identity check whatsoever.
- All three senders post only `{index, mime, ts}`: `offscreen/recorder.ts:265`,
  `content/inpage-recorder.ts:575`, `recorder/recorder-page.ts:780`.
- `sw.ts:1248` refuses a second `RECORDER_STARTED`, but that blocks *registration* only — it does
  nothing about an already-running recorder that keeps emitting.

**Second defect found while tracing (NOT in the handoff, must be fixed in the same change):** in all
three senders the `finishStop` / `ondataavailable` / `onerror` closures read the **module-level
mutable `state`**, not the session they belong to (`inpage-recorder.ts:560-564`, `:566-585`;
same shape at `offscreen/recorder.ts:248-275`, `recorder-page.ts:762-790`). So a late `onstop` from
an OLD recorder runs `cleanup(state)` / `state = null` against the **CURRENT** recording — tearing
down a live session locally. SW-side id filtering cannot prevent that; it is client-side state.

## 2. Fix (two halves — both required)

**A. Identity on the wire.**
- Each recorder session mints a `sessionId` (`crypto.randomUUID()`) at start, stored on its own
  session object.
- All four message types carry it: `RECORDER_STARTED` (which registers it), then `RECORDER_CHUNK`,
  `RECORDER_STOPPED`, `RECORDER_ERROR`.
- SW persists it on the recording state as `recorderSessionId` in the `RECORDER_STARTED` handler.
- SW **drops** a CHUNK / STOPPED / ERROR whose `sessionId` ≠ the live recording's, and **logs the
  drop** (`console.warn`) — a guard that is silent when it acts is invisible exactly when it matters.

**B. Client-side ownership (the late-callback bug).**
- Every handler captures its own session object (`const mine = pending;`) and returns early unless
  the module `state` is still `mine`, before touching shared state or sending.
- An orphaned recorder is explicitly `.stop()`ed and its tracks released, so it does not keep the
  mic/screen-share indicator lit and does not keep emitting rejected chunks forever.

**Deliberately NOT bundled** (suggest-don't-bundle): the misleading `MIN_VIABLE_BYTES` copy at
`upload.ts:1017` ("Recording was too short" while the quantity measured is durable BYTES) — it is a
real user-facing lie, but a separate, lower-risk change.

## 3. Regression test FIRST (must go RED before the fix)

In `sw.test.ts`: drive the SW with `RECORDER_STARTED(session=A)`, then interleave
`RECORDER_CHUNK(session=A)` and `RECORDER_CHUNK(session=B)`, and assert the assembled upload buffer
contains **only** A's bytes. Must fail on today's HEAD (both land) and pass after.
Second test: `RECORDER_STOPPED(session=B)` must NOT finalize A's recording.
Client-side: a late `onstop` from recorder #1 must not null the state of recording #2.

## 4. Blast radius (mapped, adapt in the same change)

- 3 sender files, 18 send sites total across the 4 message types (enumerated by grep).
- 4 SW handlers: `sw.ts:1208 / 1377 / 1390 / 1396`.
- Test files that construct these messages: `sw.test.ts` (~lines 304, 413, 420, 464, 1179, 1268,
  1327, 1455, 1481, 1491, 1522, 1556, 1567, 1603, 1648, 1835, 1852, 2598, 2621), `upload.test.ts`,
  `offscreen/recorder.test.ts`, `recorder-page.test.ts`, `recorder-page.pause.test.ts`.
- **Back-compat decision needed (question for the reviewer):** what should the SW do with a message
  carrying NO `sessionId` while the live recording HAS one? Strict-drop closes the hole completely
  but would break any sender I failed to stamp; accept-if-absent is safe but leaves the hole open
  for an orphaned pre-update context. Current lean: **strict-drop**, because an extension update
  invalidates old contexts (their `sendMessage` throws) so a legitimate unstamped sender should not
  exist — provided all 18 sites are stamped.
- Data: none (no schema/migration). UX: an orphaned recorder now stops instead of running invisibly.
- Version bump v0.5.4 → v0.5.5 + repackage both zips, as every extension change requires.

## 5. Verification before any deploy claim

Ext vitest full suite, root `pnpm typecheck`, CRLF-churn check (`git diff --shortstat` vs `-w`), and
the new tests proven RED→GREEN. Deploy is **owner-gated** (asked in the morning), never at night.
