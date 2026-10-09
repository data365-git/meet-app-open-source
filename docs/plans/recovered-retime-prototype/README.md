# Recovered: the July 2026 pause-reinsertion retime prototype

**These files were believed lost.** The scratchpad that held them
(`…/Temp/claude/D--vibecoding/45b320b2-…/scratchpad/`) still exists but was
emptied on 2026-07-15, and nothing was ever committed. They were recovered on
2026-07-20 from the SESSION TRANSCRIPT — Claude Code keeps every session as
JSONL at `C:\Users\mirko\.claude\projects\D--vibecoding\<session-id>.jsonl`, and
the files' full contents sit inside the `Write` tool calls. The extractor kept
the LONGEST version of each path, i.e. the final edit.

**How they were recovered** (worth knowing — it works for any "lost" scratchpad):
grep the transcript for a distinctive string (`warp4`, `silencedetect`), then
walk the JSON for `tool_use` blocks whose `input.file_path` matches and dump
`input.content`.

## What each file is

| file | what it does |
|---|---|
| `warp4.mjs` | **The algorithm.** Per chunk: `M = chunkDur − geminiSpan` (the time Gemini lost), redistribute M into that chunk's REAL silences proportionally, keep speech slope at 1; if M exceeds total silence, linear-stretch the remainder. Chunk start/end are exact anchors. |
| `retime-spec.md` | The production port spec — a new pure module `apps/web/lib/vtt-retime.ts`, its exact signature and behaviour, written when the algorithm was declared frozen. |
| `grid-localize.mjs` | The GROUND TRUTH rig: cuts mini-clips at known offsets, transcribes each alone, finds where the text really sits. This is what measured 18.3s → 10.8s. |
| `chunk-density.mjs`, `cross-check.mjs`, `landmarks.mjs` | The diagnostics that proved Gemini compresses SPEECH as well as pauses (missing time per chunk 52–107s > total pause time). |
| `transfer.mjs`, `transfer-dp.mjs` | Word-timing transfer (the Scribe path's ancestor — how you move one source's timings onto another's text). |
| `2026-07-08-scribe-timing-transfer.md` | The write-up from that day. |

## ⚠️ Before running any of them

They are scratchpad scripts, not products: `warp4.mjs` hard-codes the old
scratchpad path, `TOTAL = 6993.71` (that one 2-hour video) and
`TARGET_CHUNK = 360`, and it reads a `silencedetect.log` that no longer exists.
Treat them as the ALGORITHM and the MEASUREMENT METHOD, not as runnable tools.

## Why this matters now

Today's shipped fix stretches each chunk by ONE linear factor — it removes the
average slope of Gemini's wrong clock but not its curvature, and it stalls at
~10s mean. This prototype corrects the same error NON-uniformly (silences absorb
the missing time, speech keeps its slope), which is exactly the curvature the
linear stretch cannot touch. It reached ~10.8s alone, from 18.3s.

**Neither alone got below ~10s. The open question — worth measuring before
building anything — is whether they COMPOSE**: rescale to fix the slope, then
pause-reinsertion for the shape. Nobody has tried that; the July team never had
the rescale, and today's work never had this.
