# ADR 2026-10-06 — Pick the speech-to-text model by measured quality + price

**Status:** accepted (owner interview 2026-10-06)

## Context
Paid STT runs on `google/gemini-3.7-flash` only because the owner's OpenRouter key guardrail allows nothing else (2026-08); 3.7 was never A/B'd for transcription. Free leg = gemini-3.5-flash → gemini-3-flash-preview. 3.7 standard price doubles on 2027-01-01. The free Google key can call every current Gemini model, so a benchmark costs $0.

## Decisions
1. **Material:** 3 clips of ~3 min from real data365 recordings — a clean meeting, a noisy / many-speaker one, an Uzbek+Russian mixed one.
2. **Candidates:** every current flash / flash-lite model on the free key (3.5-flash-lite, 3.1-flash-lite, 2.5-flash-lite, 3-flash-preview, 3.6/3.7/3.8-flash, 3.5-flash) + gemini-3.1-pro-preview as the quality reference.
3. **Quality:** automatic scoring against the reference transcript (character error rate, digits, Latin/Cyrillic script fidelity, invented/leaked text, valid timestamps) + the owner listens blind to the top 2.
4. **Winner rule:** if quality is within ~2% of the best, the CHEAPEST wins.
5. **Scope:** the winner becomes the default STT model in data365, gemini-mic and Business OS (Business OS = client system → applied via Hermes, carefully).
6. **Re-test:** automatically once a month — check for new Gemini models; if one appeared, run the same 3 clips and report to the owner.

## Consequences
- The OpenRouter key guardrail must allow the winner before the paid leg can use it (owner action).
- Flex tier (−50%, live since `6d13305`) stacks on whichever model wins.

## Result 2026-10-07
Run `/opt/data365/stt-bench/run-2026-10-07a/` (19/21 pairs). CER vs gemini-3.5-flash: 3-flash-preview .079 (digits .28), 3.8-flash .097 (1 clip), **3.1-flash-lite .098, $0.046/audio-h flex**, 3.7-flash .120, $0.117/h flex. Owner blind test on the mixed clip (A = 3.7, B = 3.1-flash-lite): "almost the same, B slightly better". **Winner: gemini-3.1-flash-lite for the paid leg.** Free leg keeps gemini-3.5-flash first (free → quality first).
