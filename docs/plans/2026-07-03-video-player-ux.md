# Share-Page Player & Panel UX v2 — Implementation Plan

> Owner directives (2026-07-03, recovered from the 429-killed session + today's chat):
> 1. Video must stay visible while reading the transcript → **pin (sticky) the video on mobile while it is PLAYING**; paused = normal scroll.
> 2. Mobile fullscreen must open **LANDSCAPE like YouTube**, not portrait.
> 3. Transcript becomes **speaker cards** exactly like the reference screenshot
>    `apps/web/scratchpad/recovered-ref-1.png` (white rounded card per utterance:
>    avatar-letter block [named speaker = dark, "Speaker N" = blue] + bold speaker
>    name + time pill + text below). BONUS BUG visible in that screenshot: literal
>    `</v>` leaks into rendered text — strip at the render boundary.
> 4. (Today) The chapter-chip list under the video is WRONG there → move it into the
>    **Summary tab**. Under the video (MOBILE) the TAB BAR must come immediately.
>    Tabs: **Xulosa · Vazifalar · Matn · Tozalangan (+ Izohlar stays)**. Owner chose
>    option A: **mobile = tabs under video; desktop = right panel unchanged.**
>    Tasks returns as its OWN tab (Phase D had folded it into Summary).

**Code map (verified 2026-07-03):**
- Layout: `apps/web/app/s/[videoId]/_components/ShareVideo.tsx` — `flex flex-col gap-4 lg:flex-row` (~L738); left column = video + chapter chips (~L745-761); right = `SharePanel` (~L764).
- Panel: `_components/SharePanel.tsx` — tab state in `?tab=` (~L143), desktop `lg:sticky lg:top-4` (~L359), AI input at bottom (~L473-485).
- Transcript: `_components/panels/TranscriptPanel.tsx` — `parseVTTCues` (L30-126), `extractSpeaker` (L149-164), row grid render (L762-901), karaoke `renderKaraokeText` (L320-352), auto-follow scroll (L409-416).
- VTT voice tags: `apps/web/lib/transcript-vtt.ts` — `normalizeWebVttVoiceText` (L5-74), `stripWebVttTags` (L76-83).
- Player: `_components/CapVideoPlayer.tsx` + `_components/video/media-player.tsx` (media-chrome); fullscreen button `MediaPlayerFullscreen` (media-player.tsx ~L3015-3059), state via `useMediaSelector(selectFullscreen)`.
- Seek+play handler: ShareVideo `handleSeekAndPlay` (~L289-292); currentTime tracking via `timeupdate` (~L300-317).

## Global constraints (same as all plans in this repo)

- Repo `D:\vibecoding\ustoz-github`, branch `qa-fixes`. Windows PowerShell; Node PATH fix: `$env:Path="C:\Program Files\nodejs;"+$env:Path`.
- **ONE ACTIVE COMMITTER** — tasks run serially, launched by Jarvis. Never `git add -A`/`git add .` — explicit paths only (other agents' untracked files exist). NO `git push` (push = Railway auto-deploy; Jarvis pushes after all batches + live QA).
- Gate before every commit: ROOT `pnpm typecheck` exit 0 + `pnpm --filter @cap/web run test` (known flake: developer-credits-checkout, passes in isolation). No UTF-8 BOM. Tests must fail when the feature is broken.
- Surgical diffs; match existing style; UI copy Uzbek (i18n `messages/{en,ru,uz}.json`), code/comments/commits English.
- **PROTECTED (do not touch):** `GenerateAiPanel.tsx` (separate cost-label task pending), `LanguagePicker`, comments logic + "c" shortcut (stays Izohlar-only), `LocaleSwitcher`, `SettingsSectionNav`, `WebRecorderDialog`, `StorageIndicator`, admin pages, AI chat request logic.

## Task P1 — `</v>` leak: strip VTT tags at the render boundary

**Files:** `apps/web/lib/transcript-vtt.ts`, `panels/TranscriptPanel.tsx`, `apps/web/__tests__/unit/transcript-vtt.test.ts`.

- Root cause class: a LONE closing `</v>` (opening tag lost across cue/chunk boundary or malformed Gemini output) survives `normalizeWebVttVoiceText` because its regex only fires on `<v ...>` openings.
- Fix: harden `stripWebVttTags` to also remove orphan closing tags (`</v>`, `</c>`, `</i>`, `</b>`, `</u>`, `</lang>`, `</ruby>`) and self-closing/attributed variants; apply it as the FINAL step on every cue text path TranscriptPanel renders (including search-highlight path and copy/download TXT/SRT output — SRT keeps timing, drops voice tags per current behavior).
- Unit tests: lone `</v>` end-of-text (the screenshot case: `...muammo bo'ldi.</v>` → clean), lone mid-text, `<v Name>text` unclosed, normal `<v Name>text</v>` (speaker still extracted), text containing a legit `<` comparison stays intact.
- Commit: `fix: strip orphan WebVTT voice tags at transcript render boundary`.

## Task P2 — Speaker-card transcript (reference screenshot)

**Files:** `panels/TranscriptPanel.tsx` (+ its test file if row logic is extracted as pure fns — extract grouping as `groupCuesIntoCards(cues): Card[]` pure fn + unit tests in `apps/web/__tests__/unit/`).

- Replace the current 2/3-column grid rows with CARDS, per reference `recovered-ref-1.png`:
  - Card = rounded-xl surface (light: white/`gray-1` on `gray-2` page bg with border `gray-4`; dark: `gray-3` card on `gray-1` — match existing panel tokens), padding ~12-14px, vertical gap ~8px between cards.
  - Card header row: avatar block (rounded-lg square ~34px, initials, existing `speakerHue` hash bg — keep; generic "Speaker N"/"Spiker N" labels render blue like reference "S2") + speaker name (sm, semibold) + time pill (existing timestamp style: `gray-3` rounded-full, mono, click = seek+play).
  - Text below header, full card width.
- **Grouping (deterministic):** consecutive cues merge into ONE card while (a) same speaker, (b) inter-cue gap ≤ 6s, (c) accumulated card span ≤ 60s. New speaker / gap > 6s / span > 60s → new card. Card timestamp = first cue's start. Inside a card each cue's text is its own `<span>`: click = seek+play to THAT cue (cursor-pointer, subtle hover), karaoke word-highlight keeps working on the active cue's span, auto-follow scrolls the CARD into view.
- No-speaker VTTs (older videos): card without avatar/name — time pill + text only.
- Search behavior unchanged in spirit: while a search query is active, grouping is DISABLED (each matching cue = its own card) so highlight+count logic stays as-is.
- Keep: `collapseRepeatedCues`, copy/download buttons, chapter headers if currently interleaved (check `chapterVtt` usage in transcript-utils), empty/loading states, dark mode, mobile width.
- Commit: `design: speaker-card transcript per reference (grouped cues, karaoke preserved)`.

## Task P3 — Chips → Summary TOC; mobile tab bar under video; Vazifalar tab returns

**Files:** `ShareVideo.tsx`, `SharePanel.tsx`, `panels/SummaryPanel.tsx`, `panels/TasksPanel.tsx` (or wherever tasks UI lives after Phase D — verify with grep before editing), `messages/{en,ru,uz}.json`, `Share.tsx` only if prop threading requires.

1. DELETE the chapter-chip block under the video (ShareVideo ~L745-761). The Summary tab already has a clickable chapter TOC — verify it covers the same chapters AND upgrades to **seek+PLAY** (same `handleSeekAndPlay`), not seek-only.
2. Tab order becomes: **Xulosa · Vazifalar · Matn · Tozalangan · Izohlar**. Extract the tasks checklist out of the Summary tab into its own Vazifalar tab (reuse the existing tasks component with checkbox persistence — do NOT rebuild it; move the render). Summary tab keeps overview/topics/TOC. `?tab=tasks` now selects Vazifalar (remove the Phase D legacy→summary map). Default tab stays Xulosa.
3. Mobile (<lg): DOM order must be video → tab bar immediately → active tab content (chips removal achieves this; verify nothing else sits between). Tab bar: 5 tabs fit via horizontal scroll (`overflow-x-auto`, no wrap, scrollbar hidden), active tab clearly visible. Desktop (lg+): right panel EXACTLY as today (sticky, width, AI input).
4. i18n: reuse existing tab keys; add `Vazifalar` tab label key to en/ru/uz if missing.
- Commit: `design: chapter TOC lives in Summary; tasks tab returns; mobile tab bar sits under video`.

## Task P4 — Mobile video pin while playing

**Files:** `ShareVideo.tsx` (+ `Share.tsx` if playing-state lives better there).

- Track `isPlaying` from the existing video element (play/pause/ended listeners alongside the existing timeupdate wiring — same mounting pattern, do not refactor the known `[]`-dep listener style).
- Mobile only (<lg): when `isPlaying`, the video wrapper becomes `sticky top-0 z-40` with page background + subtle shadow so content scrolls under it; when paused/ended → normal static flow. Desktop: no change (panel is already side-by-side sticky).
- Must not break: fullscreen, chapter TOC seek, comment timeline overlay, cost panel below video.
- Commit: `feat: pin video on mobile while playing (sticky player)`.

## Task P5 — Mobile fullscreen → landscape

**Files:** `_components/video/media-player.tsx` (or `CapVideoPlayer.tsx` effect), new tiny util `_components/utils/orientation-lock.ts` + unit test.

- Util: `lockLandscape()` / `unlockOrientation()` — feature-detect `screen.orientation?.lock`; call `.lock("landscape")` in try/catch(ignore); unlock likewise. Unit test with mocked `screen.orientation` (lock called on coarse-pointer path, no-throw when API missing).
- Wire: effect on media-chrome fullscreen state (`useMediaSelector` mediaIsFullscreen): entering fullscreen on a touch/mobile context (`matchMedia("(pointer: coarse)")` OR viewport < 1024) → `lockLandscape()`; exiting → `unlockOrientation()`.
- Known platform limit (document in code comment): iOS Safari ignores `lock()` — native fullscreen auto-rotates when the user rotates; acceptable (YouTube behaves the same). Owner will device-test.
- Commit: `feat: lock landscape orientation on mobile fullscreen`.

## Executor routing & order (strict serial, Jarvis launches each)

| # | Task | Executor | Reviewer |
|---|---|---|---|
| 1 | P1 `</v>` strip | Codex | Jarvis (Opus) line-by-line |
| 2 | P2 speaker cards | Codex | Jarvis (Opus) + live screenshot vs reference |
| 3 | P3 tabs/TOC layout | Opus agent | Codex adversarial |
| 4 | P4 pin + P5 landscape | Codex | Jarvis (Opus) |
| 5 | Whole-batch adversarial pass | Codex (fresh, whole diff) | — |

## Live QA metrics (after deploy; extend `scratchpad/qa-phase-d.mjs` → `qa-player-ux.mjs`)

1. `</v>` occurrences in rendered transcript DOM = **0** (test video with dirty cue).
2. Speaker cards present: card count > 0; card exposes avatar initials + name + time pill; grouped (card count < raw cue count on a multi-cue same-speaker video).
3. Mobile viewport: element after video block IS the tab bar (no chips); 5 tabs reachable by horizontal scroll; desktop panel unchanged.
4. Summary TOC: chapter entries match `aiSummary.chapters`; clicking entry N → `video.currentTime ≈ startSec` AND `video.paused === false`.
5. Vazifalar tab: opens via click AND `?tab=tasks`; checkbox toggle persists across reload.
6. Pin: mobile viewport → play → scroll to transcript end → video boundingBox.top ≈ 0; pause → scroll → video leaves viewport.
7. Landscape: unit test green (real rotation = owner device-test; note in report as Unverified-on-device).
8. Regression sweep (Phase D checklist): all 5 tabs open · default Xulosa · cue seek+play · karaoke · refined accordion · LanguagePicker · anon gating · AI stream + citations · comment post + "c" shortcut in Izohlar · dark/light · console 0 errors.
