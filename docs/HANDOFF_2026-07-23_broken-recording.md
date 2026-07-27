# HANDOFF — 2026-07-23: a recording that uploads "successfully" but cannot play

**Read this first if you are picking up the broken-recording bug.** Everything below was PROVEN live
against production (byte-level probes in the browser with the owner's session), not inferred.
**No code was changed. No storage was touched.** One decision is waiting on the owner (§7).

Environment: repo `D:\vibecoding\ustoz-github`, branch `qa-fixes`, extension manifest `0.5.4`,
live host `data365.duckdns.org`, storage `…r2.cloudflarestorage.com`.
The affected video: `userId=25s3fqp7e7vc5p0`, `videoId=2j1p57ysddveyrd` (`/s/2j1p57ysddveyrd`).

---

## 1. The two symptoms the owner hit

1. Extension modal: **"Upload failed — Recording was too short — no video was captured. Please record
   for at least a couple of seconds and try again."** (Retry / Close.)
2. Share page for a *different* attempt: the video renders as a normal cap — title, "a minute ago",
   duration **1:23** — but the player shows **"Could not load a playable video source."**

They look like two bugs. Symptom 2 is the one that revealed the mechanism.

## 2. What the server actually has (measured)

| request | result |
|---|---|
| `/api/playlist?…&videoType=raw-preview` | **404** |
| `/api/playlist?…&videoType=segments-master` | **404** |
| `/api/playlist?…&videoType=mp4` | **302 → R2 signed URL → 200**, `content-length: 22117021`, `content-type: video/mp4` |

So **the upload succeeded**: 22 MB of real media is in storage. The 404s are a red herring — this
video is an mp4-source cap, so `raw-preview`/`segments-*` are simply not its variants.

A `<video>` pointed at the mp4 endpoint fails with **`MediaError.code = 4`
(MEDIA_ERR_SRC_NOT_SUPPORTED)** — the browser cannot parse the container.

## 3. Why it cannot parse: the file is two recordings interleaved

Byte-level walk of all 54 top-level boxes (26 `moof`, each read for its `mfhd` `sequence_number`):

```
offset 0        moof  seq 19      <- file starts mid-stream, NOT with ftyp
offset 532308   ftyp  (36 bytes)  <- the init segment is 532 KB INTO the file
offset 532344   moov  (1164 bytes)
```

Full order of fragments as stored:

```
19, FTYP, MOOV, 20, 21, 1, 2, 22, 3, 23, 4, 24, 5, 6, 25, 26, 7, 8, 27, 9, 28, 10, 29, 11, 30, 12, 31, 13
```

Two independent fMP4 streams, alternating almost 1:1:

- **Stream A** — sequences `19…31` (13 fragments). Its own init and fragments 1–18 are **absent**.
- **Stream B** — sequences `1…13` (13 fragments). The single `ftyp`+`moov` in the file is B's, and it
  appears exactly where B starts.

An MP4 must begin with `ftyp`; this one begins with a media fragment, and even past that the two
streams are woven together. Hence `code 4`.

## 4. The owner's recording is INTACT and recoverable (proven)

Rebuilt candidate files in-page from the same bytes and probed each with a real `<video>`:

| reconstruction | bytes | result |
|---|---|---|
| `init + frags 1…13` (stream B) | 10,702,798 | **PLAYABLE — 75.5 s, 1920×1080** |
| `init + frags 19…31` (stream A, borrowing B's init) | 11,415,423 | PLAYABLE — reports 459.2 s |
| `init + all 26 sorted by seq` | 22,117,021 | PLAYABLE — reports 459.2 s |

**Stream B (75.5 s) is the recording the owner made** — it matches the 1:23 shown on the page.
Stream A's media timeline sits ~7.6 minutes in, which is the tell that it belongs to an **earlier
recording session whose MediaRecorder was still alive**.

## 5. Root cause (confirmed in code)

`RECORDER_CHUNK` handler — [`apps/browser-extension/src/background/sw.ts:1377`](../apps/browser-extension/src/background/sw.ts):

```ts
case "RECORDER_CHUNK": {
    const raw = msg.chunk as number[] | undefined;
    const index = getNumber(msg, "index") ?? 0;
    const mime = getString(msg, "mime") ?? "video/webm";
    if (raw && Array.isArray(raw) && raw.length > 0) {
        await enqueueRecorder(() => handleChunk(new Uint8Array(raw).buffer, index, mime));
    }
    return { ok: true };
}
```

**The message carries no recording / upload / session identifier.** `index` is a per-recorder counter
that restarts at 0 for every recorder, so it cannot disambiguate either. The SW appends whatever
arrives to whatever upload is currently live. Any still-running recorder from a previous session
therefore writes its fragments straight into the new recording's file.

Same hole on `RECORDER_STOPPED` ([`sw.ts:1390`](../apps/browser-extension/src/background/sw.ts)) —
a stale recorder's stop would finalize the *live* recording.

The existing guard at [`sw.ts:1248`](../apps/browser-extension/src/background/sw.ts) refuses a second
`RECORDER_STARTED` while a recording is in progress — but that only blocks *registration*. It does
nothing about an already-running recorder that keeps emitting chunks.

Three senders, all unstamped:
- `src/offscreen/recorder.ts:265`
- `src/content/inpage-recorder.ts:575`
- `src/recorder/recorder-page.ts:780`

### Where symptom 1 comes from
[`src/background/upload.ts:1017`](../apps/browser-extension/src/background/upload.ts) —
`MIN_VIABLE_BYTES = 10 * 1024`; if `durableBytes < MIN_VIABLE_BYTES` the state flips to the
"Recording was too short…" error. Note the copy names **duration** while the quantity actually
measured is **durable bytes** — which is why a 22 MB recording can be reported as "too short".

## 6. Proposed fix (surgical — not yet written)

Stamp every recorder→SW message with the live recording's identity (`videoId`+`uploadId`, or a
nonce minted at start alongside `RECORDER_STARTED`), and have the SW **drop** any
`RECORDER_CHUNK` / `RECORDER_STOPPED` / `RECORDER_ERROR` whose id ≠ the live recording.

Blast radius to adapt in the same change:
- 3 sender files (above) — add the id at send time.
- `sw.ts` handlers for CHUNK / STOPPED / ERROR — reject on mismatch, and log the drop (a guard that
  is silent when it acts is invisible exactly when it matters).
- `sw.test.ts` message constructions at lines ~304, 413, 1491, 1603, 1835, 2621.
- `upload.test.ts` chunk helpers.

Regression test to write FIRST (must fail before the fix): feed the SW an interleaved chunk stream
from two ids and assert the resulting buffer contains only the live id's bytes.

**Suggested but deliberately NOT bundled:** make the "too short" copy honest (report bytes, and say
the recording could not be assembled) so a corrupted-assembly case never again presents as a
duration problem.

## 7. ⛔ Waiting on the owner

Asked, not yet answered: **may I repair the stored file?** — rebuild `result.mp4` as
`init + frags 1…13` (the real 75.5 s recording) and write it back to
`{ownerId}/{videoId}/result.mp4` so the existing share link plays.

It overwrites his own data, so it does not proceed without his word. Keep the original bytes
alongside (e.g. `result.broken.mp4`) before overwriting so it is reversible.

## 8. Reproduction recipe for the next session

Open the share page in the Browser pane (the owner's session is already logged in) and run the box
walk over the signed mp4 URL — fetch `/api/playlist?userId=…&videoId=…&videoType=mp4` with
`redirect:'follow'`, read `r.url`, then walk top-level boxes reading `mfhd` `sequence_number` at
`moof_offset + 20`. A healthy file starts `ftyp`, `moov`, then `moof` with sequence 1 ascending.
