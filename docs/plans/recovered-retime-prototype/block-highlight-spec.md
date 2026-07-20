# SPEC: Block-level transcript highlight ("Matn" tab)

## Goal
In the raw transcript panel, highlight the active BLOCK (card) as playback moves,
instead of the current per-cue highlight + word-by-word karaoke. This makes small
timestamp drift imperceptible: the correct block stays highlighted even if
individual cue times are several seconds off. (Owner's design decision — jump
block-to-block, not word-by-word.)

## File
`apps/web/app/s/[videoId]/_components/panels/TranscriptPanel.tsx` ONLY.
(Reuse the EXISTING `groupCuesIntoCards` at ~line 222 — do NOT modify it.)

## Current behavior (for context)
- Render is a FLAT list, one row per cue (~line 1046 `filteredCues.map(renderRow)`).
- `renderRow` (~966): `active = cue.id === activeCueId`; active row gets
  `background: var(--brand-wash)` + `renderKaraokeText(cue, currentTime)` (word-by-word).
- `getActiveTranscriptCueId(cues, currentTime)` (~312): active cue = one whose
  [startSeconds, endSeconds) contains currentTime.
- `activeRef` sits on the active row; an effect (~444, dep `[activeCueId]`)
  auto-scrolls it into view.

## Change
1. NEW pure exported helper `getActiveTranscriptCardIndex(cards, currentTime)`:
   returns the index of the active card = the LAST card whose `startSeconds <=
   currentTime` (same "most recently started" rule as
   `getActiveRefinedChapterStartSec`), or `null` if none started yet / no cards.
   This means once playback passes the first card, exactly one card is always
   active (gaps included) — robust to drift.
2. In the component: build `const cards = groupCuesIntoCards(filteredCues)` (memoize
   with useMemo on filteredCues). Compute `activeCardIndex =
   getActiveTranscriptCardIndex(cards, currentTime)`. Build a map from cue.id ->
   its card index (or compute per-row) so `renderRow` knows its card.
3. In `renderRow`: change `active` to mean "this cue's card === activeCardIndex"
   (so EVERY row in the active card gets the brand-wash background — the whole
   block highlights). Keep the same brand-wash styling.
4. REMOVE karaoke: render text always via `renderMarkdownBold(cue.text)` (keep the
   search-match branch). Delete the `active ? renderKaraokeText(...) : ...` path.
5. `activeRef`: attach to the FIRST row of the active card (so the block scrolls
   into view). Change the auto-scroll effect dependency from `activeCueId` to
   `activeCardIndex`.
6. If `renderKaraokeText` (and any helper only it uses) becomes unused after this,
   REMOVE it (surgical: only if truly orphaned — grep usages first).
   `getActiveTranscriptCueId` may also become unused — remove only if orphaned.

## Keep intact (blast-radius)
- Click-to-seek per row (seeks to that cue's start) — unchanged.
- Search highlighting, header, export (SRT/plaintext), speaker column — unchanged.
- Refined tab and chapters — untouched (already block-level).
- Don't change card bounds (`MAX_CARD_GAP_SEC=6`, `MAX_CARD_SPAN_SEC=60`).

## Tests (`apps/web/__tests__/unit/` — add to existing transcript test file or new)
- `getActiveTranscriptCardIndex`: before first card start -> null; inside a card ->
  that index; in a gap between cards -> the earlier (last-started) card; exactly at
  a card boundary -> the newly-started card; empty cards -> null.

## Gate (run from repo root, ALL must pass)
- `pnpm --filter @cap/web exec tsc --noEmit` -> 0 errors
- `pnpm --filter @cap/web run test` -> ALL green (incl. existing
  group-cues-into-cards.test.ts + new)
- `pnpm --filter @cap/web run build` -> SUCCESS

## Constraints
- Surgical: ONLY TranscriptPanel.tsx (+ its unit test file). No refactors beyond
  the change. Match existing style (inline styles, tabs). Do NOT sub-delegate.
- If a pre-existing test unrelated to this change fails, STOP and report — do not
  "fix" it.
