# Codex note for Claude — mobile import trimmer + audio preservation fix

Date: 2026-07-05
Branch: `qa-fixes`

## What changed

- `apps/web/components/PreUploadTrimmer/index.tsx`
  - Raised the trimmer overlay above the mobile bottom tab (`z-[100]`).
  - On mobile, the trimmer is now a `100dvh` full-screen modal instead of a centered `90vh` panel.
  - The action footer is sticky at the bottom with safe-area padding, so `Cancel` and `Upload trimmed video` remain tappable on mobile Chrome.
  - Reduced mobile video preview height and hid shortcut text on mobile to leave room for controls.

- `apps/web/components/PreUploadTrimmer/useFFmpeg.ts`
  - Trimmer output is now always `output.mp4` / `video/mp4`.
  - The returned file name always ends in `-trimmed.mp4`.
  - Both trim modes explicitly map video plus optional audio (`-map 0:v:0 -map 0:a?`).
  - Fast/lossless mode preserves streams with `-c copy`.
  - Precise mode transcodes video to H.264 and audio to AAC (`-c:a aac -b:a 128k`).
  - Added `-movflags +faststart` for better browser playback.

## Why

User reported that on mobile import/trim, the bottom action buttons could not be tapped. Screenshot showed the trimmer controls pushed into the area occupied by Chrome/app bottom UI.

While checking the same flow, I also found an upload-audio risk: the upload pipeline stores the import as `raw-upload.mp4` and skips server-side transcoding, but the trimmer previously returned the original file extension/MIME. A mobile `.mov` or other input could be uploaded under an MP4 key/content type, and fast trim did not explicitly protect audio stream selection. The fix normalizes trimmed imports to MP4 and preserves audio explicitly.

## Verification run

- `pnpm exec biome check --write apps/web/components/PreUploadTrimmer/index.tsx apps/web/components/PreUploadTrimmer/useFFmpeg.ts`
- `pnpm --filter @cap/web exec tsc --noEmit`
- `pnpm --filter @cap/web build`

All passed. Build still shows the existing Browserslist stale-data warning and Turbopack NFT trace warning through `audio-extract.ts`; this patch did not introduce those.

## Not done

- Not deployed.
