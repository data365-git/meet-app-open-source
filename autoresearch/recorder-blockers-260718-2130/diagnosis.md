# Autoresearch — recorder blockers, round 0 diagnosis

Date: 2026-07-18 · Repo `D:\vibecoding\ustoz-github` @ `d350b1b` (branch `qa-fixes`)
Baseline gates: extension 59 · web 1041 · web tsc 0

Method note: SEARCH-FIRST gate applied. Blocker 3 depends on browser behaviour, so it
was researched before touching code; blockers 1/2/4 are local to this codebase, so they
were verified by reading the real code rather than searched.

---

## Blocker 1 — "Permanently discard" is a false promise

Codex reported that the extension's discard calls a route that soft-deletes into a
seven-day Trash. **Confirmed, and the picture is worse than reported** — there are three
separate defects, not one:

**(a) The extension calls the soft-delete route.**
`apps/web/app/api/video/delete/route.ts` → `videos.delete(...)`.
`packages/web-backend/src/Videos/index.ts:207-221` — its own comment says
*"Soft-delete a video (move to Trash). The row is marked deleted…"*, and it logs
`Soft-deleted video ${video.id}`. So the UI's word "permanently" is untrue.

**(b) A correct hard-delete exists but is UNREACHABLE.**
`Videos.permanentlyDelete` (`index.ts:229`) does authorize correctly (owner check against
the already-fetched row, deliberately before storage access). But a repo-wide grep for
`permanentlyDelete` returns **only its own definition and the generated .d.ts — zero
callers**. No API route, no server action exposes it. Its own comment claims it is "used
by the Trash 'delete now' action and the 7-day purge"; neither of those callers exists.
Dead code that documents a feature the product does not have.

**(c) Even that function has the ORDER backwards, and is not idempotent.**
It runs `repo.delete(video.id)` (DB row) at line 247, and only THEN lists and deletes the
R2 objects (250-261). If storage deletion fails, the DB row is already gone, so the media
survives in R2 with **no record pointing at it** — unrecoverable orphans, and nothing left
to retry from. The plan's requirement is the opposite: storage-first, database-last, so a
failed storage delete leaves the owner record intact and retryable.
Idempotency: it opens with `getByIdIncludingDeleted` → `Option.isNone` → `NotFoundError`.
A second, identical request therefore 404s instead of succeeding quietly, so any retry
(the whole point of blocker 2) reports failure on a discard that already worked.

**Required shape:** a new owner-authorized endpoint — authorize → delete storage objects →
delete DB row last → return success on an already-absent video (idempotent). The
soft-delete route must not be used by this flow at all.

---

## Blocker 3 — `Entire Screen` is only a hint (researched, settled)

`displaySurface: "monitor"` passed to `getDisplayMedia` is a *preference*, not a
constraint on the user. MDN is explicit: it "has no effect on what the user can actually
choose to share."

The verification mechanism is exact and cheap:
```js
const [track] = stream.getVideoTracks();
track.getSettings().displaySurface  // "monitor" | "window" | "browser"
```
So meeting mode must read it after the picker returns and reject a non-`monitor` surface
BEFORE upload initialization, closing the stream and re-asking. Plain instruction
recordings keep tab/window freedom.

Sources: [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) ·
[MDN MediaTrackSettings.displaySurface](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/displaySurface) ·
[W3C Screen Capture](https://www.w3.org/TR/screen-capture/)

---

## Blockers 2 and 4 — restated from the plan, to be verified during implementation

2. Offline discard has no durable retry: the local trace is cleared but nothing
   re-attempts server cleanup across a Chrome restart. Needs one queued task, no
   duplicates on repeat clicks or restart, and a UI showing only `Deleted` or
   `Delete queued; will retry automatically`.
4. Pause/Resume: the popup does not await the reply, and the always-open recorder page
   has no Pause/Resume at all. Both UIs must read the same service-worker state.

---

## Metric

Per blocker: a RED-first test that fails against current code (exact output captured),
then GREEN, with extension 59+ and web 1041+ green and web tsc 0 throughout.

## Binding constraints (owner-decided; do not re-litigate)

Keep BOTH capture modes · keep the full-screen no-audio waiver with a persistent warning ·
tab-only fails closed · no `desktopCapture` · no audio-energy detection · **do not claim
tab-strip mute behaviour without a real-device proof**.
