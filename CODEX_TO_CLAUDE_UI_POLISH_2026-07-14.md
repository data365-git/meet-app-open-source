# Codex to Claude — Mobile/Desktop UI Polish Handoff

Date: 2026-07-14
Branch: `qa-fixes`
Status: verified locally, uncommitted, not pushed, not deployed

## Scope contract

Only change the observed mobile/desktop UI and UX defects in public auth and the share header. Do not change authentication logic, recorder/extension behavior, AI pipelines, database behavior, or deployment configuration.

## What Codex reviewed

- Read the current `docs/STATE.md` and the full `docs/design-handoff-2026-07/README.md`.
- Audited the current production build at 390x844 and 1280x720.
- Checked login, signup, the public share layout, the owner share layout, touch targets, horizontal overflow, and browser console logs.
- Ran independent read-only desktop, mobile, and accessibility reviews, then reproduced the selected issues in the live local build before editing.

## Exact code changes

### `apps/web/app/(org)/login/form.tsx`

- Removed `autoFocus` from email so a phone does not open the keyboard immediately.
- Removed `tabIndex={-1}` from the password visibility button.
- Expanded the password button from 16x16 to 44x44 px.
- Added a brand-colored `focus-visible` ring.
- Increased password input right padding from `pr-10` to `pr-12`.

### `apps/web/app/(org)/signup/form.tsx`

- Removed `autoFocus` from name.
- Made both password visibility buttons keyboard reachable and 44x44 px.
- Added the same visible focus treatment.
- Increased both password fields' right padding to `pr-12`.

### `apps/web/app/s/[videoId]/_components/ShareHeader.tsx`

- Mobile header now places title and actions in one row instead of stacking a second action row.
- Removed standalone mobile Copy and Download buttons from the header.
- Preserved both actions inside the mobile Share menu.
- Added `min-h-11` (44 px) to all Share-menu rows.
- Made the owner Back control icon-only at mobile width; its text remains visible at `sm+`.
- Desktop Copy, Share, Download, Back, and owner overflow behavior remains unchanged.

### `apps/web/components/LocaleSwitcher.tsx`

- Increased the mobile trigger from 36 to 44 px.
- Preserved the existing 36 px height at `sm+`.

## Measured before/after evidence

- Login password visibility target: 16x16, `tabIndex=-1` -> 44x44, `tabIndex=0`.
- Login initial focus: `email` -> `BODY` (no automatic mobile keyboard request).
- Mobile share header: Copy + Share + Download on a second row -> one Share action beside the title; Copy and Download remain in the menu.
- Owner mobile Back target: 91x36 with text -> 44x44 icon target, giving the title more room.
- Share-menu rows: below 44 px -> exactly 44 px each.
- Locale trigger on mobile: 67x36 -> 67x44.
- 390 px viewport document width: 390 or less; no horizontal overflow.
- Browser console errors after the final build: none.

## Verification run by Codex

- `pnpm typecheck` — exit 0.
- `pnpm --filter @cap/web test` — exit 0.
- `$env:NEXT_PUBLIC_DOCKER_BUILD='false'; pnpm --filter @cap/web build` — exit 0.
- Fresh production server started with `NEXT_PUBLIC_DOCKER_BUILD=false` to prevent automatic migrations.
- Fresh visual walkthrough:
  - login at 390x844 through `127.0.0.1` guest context;
  - signup DOM/touch/focus audit at 390x844;
  - share page at 390x844, including opened Share menu;
  - share page at 1280x720;
  - no console errors on verified screens.

Biome still reports pre-existing whole-file formatting/import warnings in these legacy files. Codex did not apply broad formatting because that would create unrelated churn. Typecheck, tests, build, and live UI verification are green.

## Important repository boundaries

- Do not overwrite `apps/web/app/s/[videoId]/_components/ai-chat.css`; it was already dirty from another writer before this batch.
- Do not touch the current browser-extension changes or `apps/web/public/365-extension.zip`; they belong to the guaranteed-client-audio work.
- Do not commit, push, or deploy this batch unless the owner explicitly authorizes it and the extension writer's state is reconciled.

## Remaining review findings intentionally not bundled

These were noted but are separate units because they need broader behavior/design work: dashboard localization gaps, mini-player keyboard slider semantics, transcript search focus styling, ARIA tab keyboard navigation, speaker-listbox keyboard behavior, long-title disclosure on touch, and AI glow token reconciliation in the already-dirty `ai-chat.css`.

## Recommended next action for Claude

Review only the four-file UI diff above, preserve all unrelated dirty work, then wait for owner approval before any commit/push/deploy. If approved, run `.claude/gate.cmd` before committing and repeat the live mobile walkthrough after deployment.

## Follow-up: audio/video player review

Date: 2026-07-14, after commits `96c5e80` and `37cd39f`

Codex reviewed Claude's audio-player work in a fresh local production build rather than relying on the green gates or STATE claim.

### Gaps found

1. The desktop audio title was still clipped. Its computed line-height was 28 px, but flex shrink left only 16.25 px of rendered height. The cause was the vertical icon/title stack inside a 210 px card: the intended 80 px icon, 12 px gap, title, 70 px transport, outer gap, and padding could not fit.
2. After visible skip controls were restored, the two full-area invisible double-tap buttons still remained keyboard focusable and screen-reader visible. Users encountered duplicate skip actions, including two controls with no visible focus target.
3. The visible Lucide rewind/fast-forward icons did not communicate the promised ten-second amount visually.

### Codex correction — one file only

File: `apps/web/app/s/[videoId]/_components/AudioPlayer.tsx`

- Placed the 56 px audio icon and the two-line title in one horizontal row. This preserves the compact 190/210 px card without shrinking the title.
- Kept visible skip controls at 44x44 px and changed their visible content to `−10` and `+10`.
- Kept touch double-tap behavior, but marked its invisible gesture zones `tabIndex={-1}` and `aria-hidden="true"`.
- Removed the now-unused Rewind/FastForward imports.

### Fresh evidence

- Desktop audio, 1280x720: title rendered at full 28 px line-height; both visible skip controls were 44x44 and keyboard reachable; no horizontal overflow; no console errors.
- Mobile audio, 390x844: title rendered as two complete lines at 40 px total; `−10`, Play, `+10` fit on one row; no horizontal overflow; no console errors.
- Neighbor video flow, 390x844 and 1280x720: unchanged 16:9 player; desktop video measured 740x416; fullscreen control present; caption toggle present; two caption tracks loaded; no console errors.
- `pnpm typecheck` — exit 0.
- `pnpm --filter @cap/web test` — exit 0.
- `$env:NEXT_PUBLIC_DOCKER_BUILD='false'; pnpm --filter @cap/web build` — exit 0.

### Boundary

The correction is uncommitted. Do not include QA docs, untracked scratch files, extension work, or any unrelated dirty files in its commit. Do not push or deploy without owner approval.

## Follow-up: video seek-control polish

Date: 2026-07-14, after the owner flagged the desktop video seek controls as visually incorrect

### Scope contract

Only change the main share-page video's visible desktop seek-control meaning, size, and order. Do not change audio controls, touch double-tap, fullscreen, captions, timeline, or mini-player behavior.

### Root cause and correction

- The old controls were generic 32x32 rewind/fast-forward icons with no visible duration.
- The behavior was asymmetric: backward defaulted to 5 seconds, while forward defaulted to 10 seconds.
- `CapVideoPlayer.tsx` now renders `10-back / Play / 10-forward`, with each desktop control at 44x44 and both seek components explicitly set to 10 seconds.
- The seek visuals use the existing circular-arrow icons with a visible `10` inside, so the action is recognizable without opening a tooltip.
- `video/media-player.tsx` now uses the existing localized `backSeconds` and `backSecondsLabel` messages instead of hard-coded English for the backward tooltip and accessible label.
- Mobile seek buttons remain hidden; the existing touch double-tap layer was not modified.

### Owner follow-up: selectable seek duration

- Holding either desktop seek button for 450 ms now opens a compact duration picker.
- Options are `5s`, `10s`, `15s`, `20s`, and `30s`; 10 seconds remains the default.
- The selected duration updates both seek controls, is saved under `data365:videoSkipStep`, and survives a page reload.
- A normal click still seeks immediately. The click generated after a long press is suppressed so opening the picker does not also seek.
- Right-click and keyboard ArrowDown open the same picker as accessible desktop alternatives.

### Fresh evidence

- Desktop, 1280x720: backward, Play, and forward each measured 44x44; DOM order is backward / Play / forward; accessible labels are `10 soniya orqaga`, `Ijro`, and `10 soniya oldinga`.
- Functional live click test: video time changed 1s -> 11s with forward, then 11s -> 1s with backward.
- Follow-up live test: picker showed all five choices; selecting 20 updated both visible icons and accessible labels; clicks changed 0s -> 20s -> 0s; reload kept 20. A later shared-control pass also verified the actual pointer-hold path, not only the ArrowDown alternative.
- Mobile, 390x844: both desktop seek buttons remain `display:none`; no neighboring layout regression observed.
- Browser console errors: none.
- `pnpm typecheck` — exit 0.
- `pnpm --filter @cap/web test` — exit 0.
- `NEXT_PUBLIC_DOCKER_BUILD=false pnpm --filter @cap/web build` — exit 0.

### Handoff boundary

The two code files and this STATE/handoff update are uncommitted. Preserve unrelated dirty QA and scratch work. Do not commit, push, or deploy without explicit owner approval; run `.claude/gate.cmd` first if approval is given.

## Follow-up: shared audio/video selectable seek control

Date: 2026-07-14, after the owner requested the same hold picker for audio

### Exact correction

- Extracted the selectable seek behavior into `video/SkipControls.tsx` so audio and video cannot drift apart.
- `AudioPlayer.tsx` now uses the same `5 / 10 / 15 / 20 / 30` picker for both visible controls. Its touch double-tap gesture uses the selected persisted duration too.
- A normal click seeks; holding for 450 ms opens the picker. Right-click and ArrowDown remain alternatives.
- The shared buttons remain 44x44 and preserve the circular arrow with the selected number inside.
- Stopped ArrowDown keydown and keyup propagation inside the picker trigger. Without the keyup guard, the parent media player also showed its volume indicator.

### Fresh evidence

- Desktop audio, 1280x720: all five choices rendered; selecting 15 updated both Uzbek labels and visible icons.
- A real pointer-down hold on the audio back button opened the picker; the generated click did not also seek.
- Functional audio test: 1:15 -> 1:30 with forward, then 1:30 -> 1:15 with backward.
- Reload preserved 15 seconds.
- Mobile audio, 390x844: picker and all controls fit; no horizontal overflow; no volume overlay collision.
- Neighbor video, 1280x720: both shared controls rendered once, used the persisted 15-second value, and the picker remained visually correct.
- Browser console errors: none.
- `pnpm typecheck`, `pnpm --filter @cap/web test`, and `NEXT_PUBLIC_DOCKER_BUILD=false pnpm --filter @cap/web build` all exited 0.

### Handoff boundary

The player files and documentation remain uncommitted. Do not include unrelated QA, extension, scratch, or concurrent Claude changes. Do not commit, push, or deploy without explicit owner approval.

## Superseding owner decision: hide video skip buttons

Date: 2026-07-14

The earlier visible video seek-control direction is superseded.

- Removed visible backward/forward controls from the main video transport.
- Kept the normal desktop Play control and all neighboring volume, timeline, caption, settings, theater, and fullscreen controls.
- Desktop plain Left/Right Arrow seeking remains active and was live-tested: 20s -> 25s -> 20s.
- Corrected the mobile touch layer from single-tap seeking to a real same-side double-tap within 320 ms. One side tap does not seek; left/right double-tap seeks ±10 seconds.
- Audio visible selectable skip controls remain unchanged.

This player correction is uncommitted. It must not be bundled with unrelated dirty files, pushed, or deployed without explicit owner approval.
