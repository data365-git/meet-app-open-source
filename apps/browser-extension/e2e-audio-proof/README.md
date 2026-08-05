# e2e audio proof — the sacred-path regression gate

Machine proof that a meeting recording captures the Meet tab's (remote participants')
audio, end-to-end through the REAL flow. Born 2026-07-19 after the owner's live Meet
test silently lost the remote voice (stale zip incident). Full iteration history:
`autoresearch/meet-audio-proof-260719-1900/log.md`.

## Run

```
cd apps/browser-extension
pnpm build
cd e2e-audio-proof
# one-time: generate the fake meet.google.com cert (Git Bash):
#   mkdir -p certs && cd certs && openssl req -x509 -newkey rsa:2048 -keyout key.pem \
#     -out cert.pem -days 30 -nodes -subj "//CN=meet.google.com" \
#     -addext "subjectAltName=DNS:meet.google.com"
node run-proof.mjs
```

PASS line: `VERDICT=PASS metric=full-contract filing=OK duration=OK(...) tone=OK ...`

## What it proves
- **(`run-proof-inpage.mjs`, phase 0) real Chrome ACCEPTS the tab-audio constraint
  object** — `assert-tab-constraints.mjs` compiles the real
  `shared/recording-quality.ts` and hands `tabAudioConstraints()` to a live
  Chrome. Every arm carries a control that fails when its detector is blind, so
  a green `tabconstraints=OK(...)` is not vacuous. Read that file's header for
  what it deliberately does NOT prove (it cannot mint a real tabCapture
  streamId — that stays `run-proof.mjs`'s job on an interactive desktop).
  Runs in its OWN browser instance with a fake audio device, so it can never
  contaminate the 440 Hz measurement below.
- **the tone's LEVEL, not just its presence** — `band=OK(x >= -16.5dB)`. The
  analyzer's own threshold is -50 dB, which a limiter clamping far too hard
  would still pass while crushing the remote voice. Floor overridable with
  `PROOF_MIN_BAND_DB` (a deliberate re-baselining, not an edit).
- Real OS keypress (WScript SendKeys) → manifest `commands` shortcut → activeTab grant →
  tabCapture mints the Meet tab's audio (programmatic openPopup does NOT grant — measured).
- One-Boshlash 2-click meeting flow; screen picker auto-accepted by
  `--auto-select-desktop-capture-source`.
- The assembled multipart upload contains the fake Meet tab's 440Hz tone
  (`analyze-audio.mjs`: band-passed mean volume > -50dB).
- `createVideo` files as `extensionContext=meeting` + meetingId; `completeMultipart`
  carries `durationInSecs`.

## Constraints
- Needs an interactive Windows desktop (headed Chromium + real OS key event) — not CI-safe.
- Runs Playwright resolved from the `apps/web` workspace; ffmpeg from PATH or ffmpeg-static.
- `serve.mjs` binds 443 (host-resolver maps meet.google.com there); mock API binds 3001
  (must be inside the extension's host_permissions — 8787 fails CORS preflight, measured).

## Two harnesses, two paths

| script | proves | needs |
|---|---|---|
| `run-proof.mjs` | the SHORTCUT path: real OS keypress -> `commands` -> activeTab -> `chrome.tabCapture` | an **idle, focused** Windows desktop |
| `run-proof-inpage.mjs` | the TWO-STEP IN-PAGE path: a real click on the nudge -> `getDisplayMedia` -> `HTMLMediaElement.captureStream()` for the remote voices | a headed session (no keypress) |
| `run-tier-bitrate-proof.mjs` | that a capture-tier drop actually REDUCES the bytes produced per second (`ratio=`), not just that a tier line was logged | a headed session |

`PROOF_SWAP=1 node run-proof-inpage.mjs` runs the harder variant: the fake Meet
REUSES its `<audio>` element with a new source mid-recording, exactly as Meet does
when the active speaker changes, and the tone must then be present in EVERY
segment. That scenario is what caught a wrong fix on 2026-07-20 (segments 3-4 at
-90 dB while a plain run stayed green).

### The adaptive-capture arms (slow link vs fast link)

```
PROOF_MINUTES=6 node run-proof-inpage.mjs                    # control arm
THROTTLE_KBPS=800 PROOF_MINUTES=6 node run-proof-inpage.mjs  # slow-link arm
```

The control arm must produce **more than 36 MB** in six minutes, otherwise the
throttled arm proves nothing: a capture that already fits down an 800 kbit/s pipe
never needed to adapt. That number is not luck — the fake Meet page paints a
deterministic moving surface (`?load=<cells>&loadhz=<Hz>`, defaults 20 @ 1 Hz ≈
12.5 MB/min ≈ 1.7 Mbit/s) so the recorded bitrate is a property of the harness
rather than of whatever happened to be on the dev machine's screen. Override with
`PROOF_VIDEO_LOAD` / `PROOF_VIDEO_LOAD_HZ`; `PROOF_VIDEO_LOAD=0` turns it off.
Calibration table and the saturation ceiling: the header of `run-proof-inpage.mjs`.

Both arms log every backlog measurement the extension made
(`upload backlog N bytes (buffered B, queued Q)`) and end with
`peakBacklog=...`, so "the tier never dropped" can be read against the number
that would have caused a drop (15 MB) instead of being an unexplained absence.
The throttled arm is expected to log `tier drop:` lines; the control arm is
expected to log none, and its `tier=OK(never left the best tier)` claim is only
made when the watch has proved it can see one.

**The control arm's byte count is VARIANCE-PRONE — do not read one low run as a
regression.** It records the ENTIRE SCREEN, so its bitrate depends on what the
desktop is doing, and the same commit has measured 7.9 MB and 139 MB on the same
machine within the hour (2026-08-05, isolated by stashing the change and
re-running: last-good gave 127.9 MB, the change under suspicion then gave 139 MB
— i.e. the low run was the desktop, not the code). Before attributing a
sub-36 MB control run to a diff, re-run it; if it still collapses, stash the diff
and run the same arm at the last-good commit. `run-tier-bitrate-proof.mjs` avoids
this entire class of noise by capturing the tab instead of the screen.

### Does a tier drop actually save anything? (`run-tier-bitrate-proof.mjs`)

```
node run-tier-bitrate-proof.mjs        # ~3 min, headed
```

The soak arms prove a slow-link recording FINISHES and that tier lines were
emitted. Neither proves the tier drop is what did it — a tier whose constraints
the source silently refused would still log a move, still notify the user, and
still produce every byte it did before. This harness is the number behind that
claim:

```
tier bytes/s full=<X> minimal=<Y> ratio=<R>      # fails unless R >= 3
```

Same surface, same stream, **identical MediaRecorder options in every window** —
the only thing that differs between the arms is the tier's caps applied through
the product's own `captureTierConstraintSteps()`. That is deliberately the
weakest mechanism a tier has, and deliberately the one measured, because it is
the only one production has mid-recording: `videoBitsPerSecond` is fixed when the
MediaRecorder is constructed, and rebuilding the recorder mid-run is forbidden
(it corrupts the in-flight multipart upload). It carries a drift control — the
full tier is recorded twice, bracketing the minimal window — and reports
`BLOCKED` rather than a number if those two disagree.

Two calibration facts, both measured, both easy to get wrong:
- It captures **the tab**, not the screen, so the deterministic canvas is 100% of
  the recorded surface. Capturing the whole screen makes the reading a property
  of whatever else is on the desktop (a 17x swing was measured that way).
- It paints at **30 Hz**, not the soak's 1 Hz. At 1 Hz the capturer sees ~1
  distinct frame per second, so capping 24 fps -> 8 fps removes nothing that was
  there and the caps read ~1.8x. A real screen recording changes on most frames,
  which is the only regime where the capture outruns the link in the first place.

### Reading a `run-proof.mjs` FAIL honestly
`reason=recorder-tab-never-opened` usually means the OS keystroke never reached
Chromium, not that the product broke: `WScript.SendKeys` needs the desktop free
and the Chromium window genuinely foreground, so it fails while anything else
holds focus. Before blaming the code, check the two facts that separate the
causes: the command IS registered in a fresh profile (`chrome.commands.getAll()`
returns `start-meeting-recording: Ctrl+Shift+9`), and the same FAIL reproduces on
a stashed, unmodified tree. Both were confirmed on 2026-07-20.
