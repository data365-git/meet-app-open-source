# Quality push 2026-08-04 — evidence

Closes DONE CONTRACT items #4 and #6 of `docs/plans/2026-08-04-quality-push-spec.md`.

## 1. Video: before/after through the real production encoder args

`source-capture-1080p.webm` is not a synthetic test pattern. It is a **real
recording produced by the extension's own capture path**, taken straight out of
the e2e audio proof (`apps/browser-extension/e2e-audio-proof/out-inpage/recording.bin`):
1920x1080, H.264, 48 kHz Opus, captured at the new `VIDEO_BITS_PER_SECOND`.

Both outputs were then encoded with the **verbatim** ffmpeg argument lists — the
"before" one from the pre-2026-08-04 compress pass, the "after" one copied from
the shipping `optimizeRemoteVideoToMp4FileInternal()` in `apps/web/lib/video-convert.ts`:

```
# before — the OLD compress pass: 720p cap, CRF 28, 96k audio, no sample-rate pin
ffmpeg -y -i <source> -c:v libx264 -preset veryfast -crf 28 \
  -vf "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'" \
  -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart before-old-args-720p-crf28.mp4

# after — the args in apps/web/lib/video-convert.ts today
ffmpeg -y -i <source> -c:v libx264 -preset veryfast -crf 21 \
  -vf "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'" \
  -pix_fmt yuv420p -c:a aac -b:a 128k -ar 48000 -movflags +faststart after-new-args-1080p-crf21.mp4
```

### The screenshot pair

`before-smalltext-crop.png` / `after-smalltext-crop.png` are the SAME 760x200
region of the SAME frame (t = 5 s). Both outputs were first scaled to 1920x1080
— i.e. rendered at the size the viewer actually watches them at — so the crops
are a fair like-for-like comparison rather than one image simply being bigger.
The region was chosen because it contains the hardest content this product has:
an 11-px UI caption ("bu kecha override ishlatilgan") on a dark background,
which is exactly the "slide text and code look mushy" complaint that started
this push.

### Measured, not eyeballed

Structural similarity of each output against the 1080p source (`ffmpeg -lavfi ssim`,
both scaled to 1920x1080 first):

| output | resolution | SSIM (Y) | SSIM dB (all) | size |
|---|---|---|---|---|
| before — old args | 1280x720 | 0.995626 | 23.14 | 143 657 B |
| after — new args  | 1920x1080 | 0.999990 | 42.23 | 202 272 B |

The old pass threw away detail the capture had already paid for: it is ~19 dB
further from the source for a ~41 % file-size saving. That trade is the wrong
way round for D1 ("video quality is FIRST, size is second").

Reproduce with:

```
ffmpeg -i <output>.mp4 -i source-capture-1080p.webm \
  -lavfi "[0:v]scale=1920:1080:flags=bicubic,setpts=PTS-STARTPTS[a];[1:v]setpts=PTS-STARTPTS[b];[a][b]ssim" -f null -
```

## 2. Audio: the 440 Hz band floor and the tab-constraint acceptance

`node apps/browser-extension/e2e-audio-proof/run-proof-inpage.mjs`, run against
the NEW audio graph (mic constraints + unprocessed tab constraints + the mix
limiter):

```
VERDICT=PASS metric=inpage-full-contract
  tabconstraints=OK(A:reached-capture-stage,A-control:detector-has-teeth,
                    B-names:all-recognised,B-names-control:detector-has-teeth,
                    B:live-track,B-apply:applied-track-alive,B-control:detector-has-teeth)
  filing=OK duration=OK(11s of ~10s) tone=OK band=OK(-14.8dB >= -16.5dB)
  sustained_ms=10000
```

Two things are new in that line and both are gates, not decoration:

- **`band=`** enforces the spec's -16.5 dB floor on the 440 Hz band mean. The
  pre-existing analyzer only asked whether the tone was *present* (> -50 dB),
  which a limiter clamping far too hard would still satisfy while crushing the
  remote voice. Override with `PROOF_MIN_BAND_DB` only as a deliberate
  re-baselining.
- **`tabconstraints=`** is a real-Chrome acceptance assertion for the new
  `mandatory {...}` tab-audio constraint object — see the header of
  `apps/browser-extension/e2e-audio-proof/assert-tab-constraints.mjs` for what
  each arm proves, what its control proves, and (stated plainly) what it does
  not prove.

### Honest limits of the audio evidence

- The harness cannot mint a real `chrome.tabCapture` streamId: that needs an
  activeTab grant, which needs a real OS-level invocation. `probe-gesture.mjs`
  measured the refusal, and the Win32 keychord path reports
  `sent-but-not-foreground` in an automated run. End-to-end tab capture stays
  the job of `run-proof.mjs` on an interactive desktop.
- One assertion was **built, measured to be blind, and removed**: reading
  `track.getSettings()` back to check Chrome "honoured" the three flags passes
  unchanged even when the source is flipped to `true`, because Chrome's fake
  audio device reports all three false regardless of what was requested. The
  flag *values* are covered by `src/shared/tab-audio-unprocessed.test.ts`; this
  harness only claims *acceptance*.
- The one gate no rig can close stays open: a real 2-person Meet call, judged by
  ear. That is on the owner-only list in the spec.
