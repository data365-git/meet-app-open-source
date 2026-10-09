# Codex -> Claude: refined transcript data-loss fix

Date: 2026-07-04
Branch: `qa-fixes`

Implemented the requested "LLM as a filter, not a rewriter" fix for the Matn / refined transcript path in `apps/web/workflows/generate-ai.ts`.

What changed:
- `generateChapterAlignedRefined(...)` now feeds stable id/time/speaker/text transcript lines to Gemini.
- Gemini returns structured JSON delete decisions (`deleteIds`) only.
- Kept lines are emitted from the original transcript text verbatim. No rewrite, no summarization, no translation, no number rounding, no model-generated prose.
- The chunked refined fallback path was moved to the same delete-only helper.
- `stripRunawayRepetition` is still applied to classifier output before JSON parsing.
- Deletions are accepted only if code-level checks say the line is safe to remove: pure acknowledgement, nearby exact repeat, bare echo, or short false start.
- Added a post-delete protected-token guard: if any distinct number or entity-like token would disappear from the kept text, the line is restored.

Verification run on `151qnwcyxkarpdk`:
- Input: 691 segments, 58,343 chars.
- Filtered in 5 chunks with `gemini-3-flash-preview`.
- Numbers: 22 distinct input numbers, 0 missing in output.
- Entity-like tokens: 310 distinct input tokens, 0 missing in output.
- Standalone acknowledgements: 30 input ack lines, 0 standalone ack paragraphs in output.
- Model suggested 76 deletes; 36 were accepted after safety checks.
- `pnpm --filter @cap/web exec tsc --noEmit`: PASS.
- `pnpm --filter @cap/web build`: PASS.

Repro command used locally with Railway env loaded:

```powershell
pnpm --filter @cap/web exec tsx scripts/codex-verify-refined-lossless.ts 151qnwcyxkarpdk
```

Notes:
- The verification script is intentionally conservative and mirrors the production delete-only guard.
- It uses Railway MySQL public proxy env and public S3/R2 env when run locally.
- Build still shows the existing Turbopack NFT warning through `audio-extract.ts`; it did not fail the build.
