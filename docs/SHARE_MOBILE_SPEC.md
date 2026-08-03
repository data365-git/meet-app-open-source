# Share / Watch Page — Mobile-First Interaction Spec (375px)

> STEP 0 of the redesign build order. Required by BOTH pre-build reviews (Opus + Codex) before any
> share-page code — it is the single highest-risk user path: students mostly open links on phones.
> Source of truth for tokens + components = `NEW_DESIGN.md`. Figma reference file (built 2026-06-21):
> https://www.figma.com/design/pVGGOWWhRLyKOZVbEjMK81 (Screens › Share Page, mobile 390px).

## Breakpoints
- **Mobile** 320 / 375 / 430 (design target = 375). Single column, everything stacks.
- **Tablet** ≥ 768: video + tabs full width, comments still below.
- **Desktop** ≥ 1024: optional 2-column (video+tabs left, comments/AI right). NOT required for v1.

## Vertical stacking order (mobile, top → bottom)
1. **Header** (sticky top) — see below.
2. **Video** — sticky under the header while you scroll the tabs/content.
3. **Segmented tabs** (Summary / Tasks / Transcript / Refined).
4. **Active tab content** (cards).
5. **Comments** (input + list).
6. **AI chat FAB** — floating, fixed to the viewport (not in flow).

## Header — what SURVIVES on mobile (Codex weakness #5)
Keep only THREE things on the mobile header, left→right:
- **Back** (`‹`) — returns one screen (device back also works).
- **Title** — single line, **truncate with ellipsis** at one line; full title available on tap/long-press.
- **Share** — ONE primary blue pill. This is the single loud action.
Everything else (copy link, edit, analytics, open dashboard, owner cost) → collapse into a **"…" overflow menu**
shown ONLY to owner/members. Viewers see only Back · Title · Share. Cost panel: owner/members only (already shipped `9e94c7c`).

## Video — sticky behaviour
- 16:9, `border-radius: 16`, full content width minus 16px side padding.
- **Sticky**: `position: sticky; top: <header height>` so the video stays visible while tabs/content scroll under it.
- **Sticky height cap**: on short viewports the sticky video must not eat the screen — cap its height to **≤ 38vh**
  when stuck; below that, it scrolls away normally.
- Duration badge bottom-right (dark pill, white text). Chapter-segmented progress bar on the scrubber.

## Tabs — overflow rule (Opus #2 / Codex #1)
- 4 pill tabs on a `surface/track` segmented control.
- At 375px the 4 labels may not fit on one line → the tab row **scrolls horizontally** (no wrap, no shrink-to-unreadable).
  Active pill auto-scrolls into view. Never wrap to a second row (breaks the segmented-control metaphor).
- Active = filled blue pill + white text; inactive = transparent + muted text.

## Content cards
- White, `radius 16`, `0.5–1px` `border/default`. One concept per card. Generous padding (16–20).
- Long mixed uz/ru/en titles: wrap to max 2 lines then ellipsis.

## Comments
- Input = the shared **Input** pill (full width), placeholder "Add a comment…". Login required (no anonymous — intended).
- List below. **Empty state**: small icon + "No comments yet" + one muted line. Never a blank gap.

## AI chat FAB (Codex weakness #7)
- Floating blue pill, fixed `bottom-right`, inside the **bottom safe-area inset** (`env(safe-area-inset-bottom)`).
- **Hide the FAB while the comment input / on-screen keyboard is open** (it overlaps the send button otherwise).
- When opened, the AI panel is a bottom sheet on mobile (not a desktop floating popup), dismissible by swipe-down / backdrop tap.

## Actions visible vs hidden (Codex weakness #4 — hover/`…` fails on mobile)
- **Always visible** per video card (on dashboard) and on share: open, Share/status. No action may depend on hover.
- **In the `…` menu**: rename, move, delete, analytics, embed — destructive/admin only, owner/members only.

## Non-ideal states this page MUST handle (Opus #4 / Codex section 3)
| State | What the user sees |
|---|---|
| Video still uploading | progress + "Processing your video…" (no broken player) |
| Video failed / no audio | clear error card + retry (owner) |
| Password / email-gated | gate form, friendly copy, error on wrong entry |
| AI not generated yet | owner: "AI tahlilni boshlash" button; viewer: tabs hidden or "not generated yet" |
| AI generating | real % + ETA bar (already shipped) — never a bare spinner |
| Empty transcript / refined / tasks / comments | guided empty state, never a blank panel |
| Long title / long org name / long URL | truncate + ellipsis, no layout break |

## Accessibility (WCAG AA) — fix before code (both reviews)
- `text/muted` `#7d818a` on white is **borderline for small text** → darken to ~`#5f636b` for body/secondary text.
- Verify any gray text on `surface/track` (e.g. inactive tab labels) meets AA; bump if it fails.
- Touch targets ≥ 44×44 for every pill/menu/tab. Visible focus ring on keyboard nav.

## Pills discipline (Opus #1 / Codex #2 — don't read "toy")
- Full `9999px` pills ONLY for: primary/secondary CTAs, status chips, the FAB, the segmented-control track + active pill.
- Cards, inputs containers, content surfaces = `12–16px` radius, NOT full pills.
