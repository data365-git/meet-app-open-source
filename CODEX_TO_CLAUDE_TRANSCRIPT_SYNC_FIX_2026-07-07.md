# Codex to Claude: transcript sync fix (2026-07-07)

## Scope

Only touched share-page transcript/refined transcript playback sync behavior.
No transcription generation, AI prompts, player controls, playback speed logic,
deploy config, or unrelated UI was changed.

## Root Cause

The raw Transcript tab used its own VTT timestamp parser in
`TranscriptPanel.tsx`. That parser misread Gemini colon-ms timestamps such as
`01:25:480` and `00:07:540` as hour/minute/second values instead of
minute/second/millisecond values. Example: `01:25:480` became `5580s` instead
of `85.48s`. Duration recovery could only partially mask this and left visible
drift while playback continued.

A second sync issue was that overlapping cues selected the first active cue,
while the caption overlay already selects the latest active cue. A runaway/long
cue could therefore hold the transcript highlight on older text.

Refined transcript had a smaller related issue: it compared normalized chapter
display times against a raw `chapter.startSec` accumulator, so old x60 chapter
times could leave the active chapter stuck.

## Changes

- `apps/web/app/s/[videoId]/_components/panels/TranscriptPanel.tsx`
  - Parse Gemini colon-ms timestamps exactly.
  - Keep dot/comma millisecond support.
  - Include comma in end-token extraction.
  - Select the latest active cue when cue ranges overlap.

- `apps/web/app/s/[videoId]/_components/panels/RefinedTranscriptPanel.tsx`
  - Reuse `clampStartSec` for chapter display time normalization.
  - Choose the active chapter using normalized display time, while returning the
    original raw `startSec` for existing React keys/refs.

- `apps/web/__tests__/unit/transcript-sync.test.ts`
  - Covers colon-ms parsing, overlapping cue selection, and refined x60 chapter
    active selection.

## Playback Speed

No special playback-rate adjustment was added. Transcript sync follows
`video.currentTime`, which is the media timeline position in seconds. That is
the correct source for 1x, 1.2x, and 2x playback; playbackRate only changes how
quickly the media timeline advances.

## Verification

Ran from `apps/web` using existing local binaries, no install:

- `vitest run __tests__/unit/transcript-sync.test.ts __tests__/unit/transcript-bold-preservation.test.ts __tests__/unit/caption-vtt-clamp.test.ts`
  - 3 files passed, 9 tests passed.
- `tsc --noEmit`
  - passed.

No commit, push, or deploy was performed.
