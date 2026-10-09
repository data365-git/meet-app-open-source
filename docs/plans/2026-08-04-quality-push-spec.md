# Spec — 2026-08-04 quality push (owner-interviewed)

Owner gave five work items and answered every open decision in two batched rounds.
This spec is the contract; the goalkeeper loop runs against the DONE CONTRACT at the bottom.

## Owner's stated priorities (verbatim intent)

1. **Video quality is FIRST, size is second.** "Hajm kichikligi xo'p, lekin undan ham muhimi video sifati juda ham yaxshi bo'lishi shart."
2. **Gemini API is the main cost — no waste.**
3. **Meeting audio must be Zoom-grade** — both sides, especially the OTHER participant, clear and natural.
4. **Recordings must be movable into Meetings** (and back), including imported ones.
5. **Upload/import must be proven healthy.**

## Decisions (owner, 2026-08-04 — do not re-litigate)

| # | Decision | Chosen |
|---|---|---|
| D1 | Video quality target | **High: keep 1080p, sharp text.** ~2.5-3x current size accepted. |
| D2 | Mic noise suppression | **ON** (Chrome's EC/NS/AGC, as Zoom does). |
| D3 | Gemini free quota exhausted | **Use free first, then continue on paid.** No waiting. |
| D4 | Move between Recordings/Meetings | **Manual, both directions, AND in the multi-select bar next to Delete** — "Move" must offer Meetings/Recordings and folders. |
| D5 | Old videos | **Compress the 3 uncompressed raw ones** at the new high setting (originals preserved). Already-compressed ones untouched. |
| D6 | Storage (6.6 GB free) | **Leave it; migration solves it.** I warn him if it gets tight. |

---

## S1 — Video quality

**Measured problem (facts, with sources):** quality is lost TWICE.
- Capture: 1920x1080 @ 24 fps but only **3 Mbit/s** — `apps/browser-extension/src/shared/recording-quality.ts:10-18`.
- Server: every 1080p recording trips `HIGH_RESOLUTION_MAX_EDGE = 1280` (`apps/web/lib/video-convert.ts:25`), so the compress pass **downscales to 720p at CRF 28** and drops audio to 96k — `video-convert.ts:439-463`.

**Changes**
1. `recording-quality.ts`: `VIDEO_BITS_PER_SECOND` 3_000_000 → **8_000_000**. (The capture bitrate is the ceiling — no server setting can recover detail the encoder never wrote. Screen text at 1080p24 needs ~8 Mbit/s.)
2. `video-convert.ts` compress pass: scale cap 1280 → **1920**, `crf 28` → **21**, `-b:a 96k` → **128k**, add `-ar 48000`.
3. `HIGH_RESOLUTION_MAX_EDGE` 1280 → **1920** (a 1080p source must no longer be treated as oversized).
4. `HIGH_BITRATE_BPS` stays 2_500_000 — deliberately: the 8 Mbit/s capture SHOULD still be re-encoded, that is what turns ~60 MB/min raw into ~3 MB/min at CRF 21.
5. Expose all three as env-overridable constants with the above defaults, so the client's server can be tuned without a rebuild.
6. Update the arg-pinning tests: `apps/web/__tests__/unit/video-convert.test.ts`.

**Non-goals:** do not touch the trim pass (CRF 23) or the copy-fallback pass (CRF 26); do not change frame rate.

## S2 — Audio quality

**Measured problem:** not one of the three recorder paths sets ANY audio constraint — `inpage-recorder.ts:362-372`, `recorder-page.ts:649-664`, `offscreen/recorder.ts:231-243` request bare `{audio: true}` / a deviceId only. Everything is at Chrome's unstated defaults. Also `TAB_AUDIO_GAIN = 1.8` (`recording-quality.ts:23`) is applied with no limiter, so a loud remote speaker clips.

**Changes**
1. **Mic** (all three paths): explicit `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 }` merged with the existing deviceId. Single shared constant in `shared/recording-quality.ts` — three copies would diverge (the twin trap that already bit this repo twice).
2. **Tab / display / system audio**: explicitly `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`. **This is the load-bearing one for the owner's #3 priority** — browser voice processing on a tab stream treats the remote participant as "echo" and can attenuate or gate the other person's voice. It must never be enabled on that leg.
3. **Limiter before recording**: a `DynamicsCompressorNode` (threshold ≈ -3 dB, ratio ≈ 20, fast attack) between the mix destination and the recorder, so the 1.8x tab lift cannot clip. Applied in all three paths from the shared module.
4. `AUDIO_BITS_PER_SECOND` stays 128_000 (already ample for speech; the loss was server-side and is fixed in S1).
5. Level the two branches: `recorder-page.ts:734-736` mixes system audio at unity while the tab branch lifts 1.8x — use the same constant for both.

**Verification:** the existing e2e audio proof harness (`apps/browser-extension/e2e-audio-proof/run-proof-inpage.mjs`) must still PASS, and the analyzer's measured 440 Hz band must not regress.

## S3 — Gemini waste

**Facts:** ~$7.16/mo. Free chain then paid (`workflows/transcribe.ts:106-109`, `workflows/generate-ai.ts:872-875`) — D3 confirms that shape stays.

**Changes (ranked by provable saving)**
1. **Retry re-uploads the whole audio file up to 5x** — `lib/gemini-transcribe.ts:899-967`: the Files-API upload sits INSIDE the retried closure. Hoist it so a retry reuses the existing `fileUri` for the same key. (Upload bandwidth + latency; the biggest mechanical waste.)
2. **Prompt-prefix stability for implicit caching** — the ~700-word instruction block (`buildTranscriptionPrompt`, `gemini-transcribe.ts:800-878`) is re-sent per 3-minute chunk. Ensure the fixed instructions are a byte-identical PREFIX and the variable part (speakers, chunk offset) comes AFTER, so Gemini's implicit context cache can hit. A 60-min video is 20 chunks of the same prefix.
3. **Summary output cap** — `workflows/generate-ai.ts:1076` sets `maxOutputTokens: 65536` with no runaway guard, while the transcription path caps at 24000 AND strips runaway repetition. Apply the same repetition guard to the summary path before billing.

**Non-goals:** do NOT change models, do NOT remove the free chain, do NOT switch to Vertex (measured and rejected 2026-07-30).

**Acceptance:** a re-run of one real video must produce an identical transcript with strictly fewer billed input tokens than before, measured from `aiUsageEvents`.

## S4 — Move between Recordings and Meetings

**Fact + blast radius (checked, not assumed):** the classification is `videos.source` JSON = `{type:"extensionWeb", context:"meeting"}` (`packages/database/schema.ts:387-402`), set ONCE at creation (`app/api/desktop/[...route]/video.ts:240-253`) and never edited. **`source.type` also drives playback and editing** — `app/api/playlist/route.ts:105-142`, `app/s/[videoId]/_components/ShareVideo.tsx:669`, `actions/videos/save-edits.ts:36-38`. **Therefore a move must NOT rewrite `source.type`** — doing so would make moved videos unplayable. Loom imports are `{type:"webMP4"}` (`actions/loom.ts:372`), so they can never satisfy the meeting predicate today.

**Design (additive, reversible)**
1. New nullable column `videos.libraryKind` — `"recording" | "meeting" | NULL`. Additive migration only.
2. Both list queries become: meeting **iff** `libraryKind = 'meeting'` OR (`libraryKind IS NULL` AND the existing JSON predicate). Caps = the negation. `source` is never written. Sites: `dashboard/meetings/page.tsx:151,209`, `dashboard/caps/page.tsx:149,206`, `dashboard-data.ts:289`.
3. Server action `moveVideosToLibrary(videoIds, target)` — membership-guarded like the other video actions, works on a LIST (bulk), and is fully reversible.
4. UI: a **Move** control in `SelectedCapsBar.tsx` next to Delete, offering Meetings / Recordings / a folder. Same bar on the Meetings page.
5. Because it is additive, imported (Loom) videos become movable for free.

**Acceptance:** move a Loom-imported video to Meetings → it appears in Meetings, still plays, still edits; move it back → it returns to Recordings. Bulk-select three, move all three in one action.

## S5 — Upload / import health

Two known weak points to close (owner asked directly whether upload is healthy):
1. **Misleading failure copy** — `apps/browser-extension/src/background/upload.ts:1017` says "Recording was too short" when it actually measured zero durable BYTES. Say what happened.
2. **Tail-loss window** — `upload.ts:52-60`: up to ~1 MB can be lost if the service worker is evicted between the last flush and finalize. Never observed in a real recording (the 2-hour soak uploaded 179 parts clean), so: measure it with a test that evicts the worker mid-recording, and only then decide whether it needs a fix. Do not patch blind.

## DONE CONTRACT (machine-checkable; the goalkeeper loop runs until all pass)

1. `pnpm exec tsc -b --force` → exit 0 (NOT `pnpm typecheck` — that is a cached no-op in this repo).
2. Full web suite + extension suite green, with the new tests included and the pre-change baseline count exceeded.
3. **RED→GREEN proof for every behavioural change**: the ffmpeg-arg test fails against the old args; the audio-constraint test fails when the tab-audio processing flags are flipped back on; the move test fails without `libraryKind`; the playback test proves `source.type` is unchanged after a move.
4. The e2e audio proof (`run-proof-inpage.mjs`) VERDICT=PASS with the 440 Hz band no worse than -16.5 dB mean.
5. `git diff --shortstat` vs `-w` must match (no CRLF churn) before any commit.
6. A real 1080p sample encoded through the NEW production args, with a before/after screenshot pair saved under `docs/qa/quality-2026-08-04/`, showing small on-screen text legible.
7. Live-verified on prod after deploy: image tag == `git rev-parse`, `/api/health` ok, and the changed screens walked in the Browser pane.

## Owner-only steps (cannot be machine-closed)

- A real 2-person Meet recording to judge the other participant's voice by ear — the one gate no rig can close.
- The replace-with-audio button still needs one throwaway video (it permanently destroys the video).
