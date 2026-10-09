# Claude → Codex handoff: "Matn" (refined transcript) drops real data

Date: 2026-07-04
Author: Claude (Opus)
Branch: `qa-fixes`

## The requirement (owner's hard rule)

The **"Matn"** tab on the watch page (`app/s/[videoId]`) shows a *refined transcript*.
The owner's rule, verbatim intent:

> Remove ALL useless filler/backchannel, but keep **ALL important data**. Shortening
> is NOT the goal — **nothing important may be lost.** It must NOT become a summary.

So: same substance as the transcript, only the noise ("aha", "xo'p", "mhm", "ага/угу",
bare echoes, exact repetitions, false starts) removed. Every number, name, price,
place, decision, Q&A must survive **verbatim**.

## Where it's generated

- `apps/web/workflows/generate-ai.ts`
  - `generateChapterAlignedRefined(...)` — approx line **1012**. For each summary
    chapter it takes the timestamped transcript slice and calls the model to "clean"
    it. There is a **second, near-identical refine call site** approx line **1291**
    (the chunked path). Both share the same prompt text (approx line **1061**).
  - `GEMINI_SUMMARY_MODEL` — approx line **782** (now `"gemini-3-flash-preview"`).
  - `callAiApi(...)` — approx line **791** (`maxOutputTokens: 65536`).
  - Output → `result.aiSummary.refinedTranscript.chapters[].paragraphs`.
- Renderer: `apps/web/app/s/[videoId]/_components/panels/RefinedTranscriptPanel.tsx`.
- Runaway guard already applied: `stripRunawayRepetition` from
  `apps/web/lib/gemini-transcribe.ts:457`.

## What Claude changed this session (deployed, commit `b207c80`)

1. Rewrote the refine prompt: added Uzbek/Russian filler+backchannel examples +
   "merge into flowing paragraphs" + "keep all substance, not a summary".
2. Upgraded `GEMINI_SUMMARY_MODEL` `gemini-2.5-flash` → `gemini-3-flash-preview`
   (2.5 left residual chat-cruft; 3-flash follows the clean instruction far better).

This made filler removal **much** better. **But it introduced data loss** (below).

## The problem (measured, not guessed)

Test video: **`151qnwcyxkarpdk`** — a real ~53-min Uzbek call (egg-farm / IT
automation). I fed its stored refined chapters back through the new prompt on
`gemini-3-flash-preview` and ran a **number-preservation check** (every distinct
multi-digit number in the input must appear in the output — numbers are hard data
that must not vanish):

```
New prompt (current, deployed):
  input 52,149 chars -> clean 14,520 chars (72% shorter)
  numbers MISSING from output: ~10  (100000, 10000, 1000, 100, 90, 20, 30, 16, ...)

STRICTER prompt ("keep every number verbatim, do NOT condense"):
  input 52,149 chars -> clean 5,382 chars (90% shorter)   <-- WORSE
  numbers MISSING: 15  (16, 300, 30000, 150, 150000, 365, 3000, ...)
```

**Conclusion:** `gemini-3-flash-preview`, when handed a whole conversation to "clean",
tends to **summarize/condense** and silently drops real numbers/facts — and telling it
"do not summarize, keep every number" makes it condense *harder*, not softer. Prompt
tuning does **not** reliably satisfy "verbatim minus filler". The clean/lossless goals
fundamentally conflict when the LLM is allowed to **re-write** the text.

Caveat on the measurement: the input I used was the OLD (2.5-flash) refined output,
not the raw VTT — so a few "missing" numbers may be false positives (word-form, or
they were themselves filler echoes). But the direction is unambiguous: heavy
condensation + real numbers (150000, 30000, 3000) dropped.

## Recommended fix: LLM as a *filter*, not a *rewriter*

To guarantee "keep everything important", **do not let the model rewrite the text.**
Make it a classifier and delete deterministically:

1. Feed the model the transcript lines/cues (with stable ids/indices).
2. Ask it to return **structured output** (JSON) marking which lines are pure
   filler to DELETE — categories: bare acknowledgement/backchannel, exact echo of a
   number/word the other speaker just said, verbatim repetition, false start.
   "When unsure, KEEP."
3. In code, **delete only the flagged lines**; every kept line is the **original
   verbatim text** → no number/fact can be lost, nothing is reworded.
4. (Optional, deterministic) merge consecutive kept lines of the same speaker into
   paragraphs — pure string join, no model rewrite.

Result: clean (filler gone) + **guaranteed lossless** (kept text byte-identical to
source). Slightly more verbose than a rewrite — which is fine ("shortening isn't the
goal").

If that's too big: fallback is to accept "Matn" as a *readable cleaned version that
may condense* and rely on the **Transkript** tab (already full verbatim with
speakers+timestamps) for completeness — but the owner said losing data matters, so
the filter approach is preferred.

## Verification bar (must pass before shipping)

Re-run on `151qnwcyxkarpdk`: **every** distinct number and named entity in the input
transcript must appear in the output (**0 missing**), while the "aha/xo'p/mhm"
acknowledgement lines are gone. A crude but effective check: extract `\d{2,}` from
input vs output; missing count must be 0 (after excluding pure repeats).

## Access notes (how Claude tested)

- Railway MySQL via public TCP proxy: host `thomas.proxy.rlwy.net`, port `26774`,
  user `root`, db `railway` (password from `railway variables --service MySQL --json`,
  key `MYSQL*PASSWORD`). Connect with the repo's own `mysql2`.
- Video content: `SELECT metadata FROM videos WHERE id=?` → JSON →
  `aiSummary.refinedTranscript.chapters[].paragraphs`.
- Cost: `ai_usage_events` (columns incl. `operation, model, inputTokens,
  outputTokens, costUsdMicros, videoId`). For reference, a normal 53-min run =
  ~$0.086 total (transcription ~82%, summary/refined ~18%).
- `GEMINI_API_KEY` from `railway variables --service @cap/web --json`.
- Gemini REST: `POST .../v1beta/models/gemini-3-flash-preview:generateContent?key=...`.

## Rollback

The pre-session refined behaviour is `git show b207c80^:apps/web/workflows/generate-ai.ts`.
Reverting `b207c80` restores the 2.5-flash + English-only-filler prompt (complete but
dirty). Don't do that if you're implementing the filter approach — build forward.
