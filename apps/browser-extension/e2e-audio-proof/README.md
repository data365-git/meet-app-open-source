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
