# PLAN — 2026-07-27: stop cross-recording chunk contamination (session-id stamping + stale-recorder teardown)

Status: PLAN, not yet built. Branch `qa-fixes`, extension at v0.5.4.
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
