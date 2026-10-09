# Task 001 — Phase 3b: Share page visual polish to match mockup

## Goal
Make the public share page `/s/[videoId]` match the redesign mockup, make the video player **sticky**, fix the **duplicate-React-key** console errors (~180× on the populated page), and fix the **responsive overlap** (sidebar/comments overlapping tab content at narrow widths). NO behavior changes — purely visual + bug fixes. The engine and data wiring already work — do NOT touch data fetching, server actions, or the AI pipeline.

## Verified background (read these first)
- Route entry: `apps/web/app/s/[videoId]/page.tsx` (server) → `Share.tsx` (client wrapper).
- Layout split lives in `apps/web/app/s/[videoId]/Share.tsx` (~lines 535–586): `flex flex-col gap-4 lg:flex-row`, video in `flex-1`, sidebar in `lg:w-80`.
- Sidebar: `apps/web/app/s/[videoId]/_components/Sidebar.tsx` (sets `position: sticky; top: 1rem` ~line 238).
- Video player container: `apps/web/app/s/[videoId]/_components/ShareVideo.tsx` (~lines 371–374, outer `<div className="relative h-full">`).
- Below-video tabs: `apps/web/app/s/[videoId]/_components/BelowVideoTabs.tsx` — tab bar is ALREADY sticky (line 110 `sticky top-0 z-10`); active tab uses PURPLE inline hex (lines 135, 138, 141).
- Mockup design system (source of truth for colors): accent `#2563eb`, accent-ink `#1d4ed8`, accent-soft `#eef4ff`, accent-glow rgb `37, 99, 235`, radius 16px. Mockup file (read for exact look): `C:/Users/localhost/Downloads/Telegram Desktop/Share Page - Redesigned.html`.
- The AI-chat already uses the correct blue (`_components/ai-chat.css`) — do NOT change it; it is the reference.

## Changes required

### A. Accent color: purple → blue (match mockup)
The share-page PANELS use purple as the accent; the mockup uses blue. Replace purple with the mockup blue across these files. Use Tailwind blue-* for class names and the exact mockup hex for inline styles.
Mapping:
- Tailwind: `purple-50`→`blue-50`, `purple-100`→`blue-100`, `purple-400`→`blue-400`, `purple-600`→`blue-600`, `purple-700`→`blue-700` (and any `bg-purple-*`/`text-purple-*`/`border-purple-*`/`hover:*-purple-*`).
- Inline hex: `#7c3aed`→`#2563eb`; `#f5f3ff`→`#eef4ff`; `rgba(124, 58, 237, .14)`→`rgba(37, 99, 235, .14)`; any other purple rgba → the `37, 99, 235` glow.
Files known to contain purple (grep `purple|7c3aed|f5f3ff|124, 58, 237` across `apps/web/app/s/[videoId]` to be exhaustive — fix ALL hits in the SHARE page, including the `edit/` route only if it shows purple as accent; leave genuinely-semantic non-accent colors alone):
- `_components/BelowVideoTabs.tsx` (lines ~135, 138, 141)
- `_components/GenerateAiPanel.tsx` (admin AI panel — lines ~86, 89, 93, 141, 150, 173, 210)
- `_components/panels/RefinedTranscriptPanel.tsx` (lines ~42, 53)
- `_components/panels/TranscriptPanel.tsx` (lines ~204, 231)
- `_components/panels/SummaryPanel.tsx` (lines ~38, 45, 65, 116)
- `_components/Sidebar.tsx` (line ~113)
Re-grep after editing to confirm ZERO purple/`#7c3aed`/`#f5f3ff` remain in the share page (except inside `ai-chat.css`, which is already blue and untouched).

### B. Sticky video player
In `ShareVideo.tsx`, make the outer video container sticky so the player stays visible while scrolling tabs/comments. Add `sticky top-0 z-50` (or inline `position: sticky; top: 0; z-index: 50`) to the outer `<div className="relative h-full">` (~line 372), plus a soft shadow when sticky (mockup: `box-shadow: 0 8px 30px rgba(0,0,0,.25)`). Verify the stacking context: the player must not cover the sticky tab bar (tab bar is z-10; keep player above page content but ensure tab bar still works — test by scrolling). On mobile (stacked layout) sticky-top-0 is fine.

### C. Fix duplicate-React-key errors (~180× on populated page)
Audit EVERY `.map()` render in the share-page component tree and ensure each child has a STABLE, UNIQUE `key`. The ~180× count comes from a long list on the populated page = transcript segments and/or chapters. Prefer a stable id or start-timestamp from the data; use the array index ONLY when the list is static and never reordered. Known suspects to fix:
- `_components/panels/TranscriptPanel.tsx` — transcript segments (the likely ~180× source). Use segment id/start time, not index.
- `_components/video/SegmentedProgressBar.tsx` — chapter segments. Use chapter id/start, not `key={0}`/index.
- `_components/panels/RefinedTranscriptPanel.tsx` (line ~61, uses paragraph text as key — make it a stable composite like `i + '-' + start` or a real id).
- `_components/panels/TasksPanel.tsx` (line ~200, `key={i}`).
- `_components/panels/SummaryPanel.tsx` (line ~115, `key={step}` — ok if steps unique, but make robust).
- `_components/AIChatPopup.tsx` (line ~83, `key={`b-${i++}`}` mutating counter — use the message index/id instead).
Acceptance: open the POPULATED test video (`/s/h9rvanjvm2vrft7`) and confirm the browser console shows ZERO "Encountered two children with the same key" / "unique key" warnings.

### D. Responsive overlap
At narrow/tablet widths the sidebar (sticky comments/emoji) overlaps the tab content. Fix in `Share.tsx` + `Sidebar.tsx`:
- Mockup stacks to a single column at `max-width: 900px` and makes the sidebar `width: 100%`. Align the breakpoint so the sidebar drops below the video before sticky causes overlap (e.g. ensure the row layout only applies when there is room; the sidebar `position: sticky` should NOT cause overlap once stacked — verify it does not stay pinned over the tabs when stacked).
- Acceptance: at 768px and 414px widths the sidebar sits BELOW the video full-width with no overlap; at ≥1024px the side-by-side sticky layout is unchanged.

## Files NOT to touch
- `_components/ai-chat.css` (already correct blue — it is the reference).
- Any server action, data fetch, `actions/`, the AI generate route, DB, auth. No behavior changes.
- The recording / dashboard / extension code.

## Acceptance criteria
1. ZERO purple accent remains in the share page (grep clean, except ai-chat.css).
2. Active tab, panel chips, transcript highlight, refined play buttons, admin AI panel = mockup blue (`#2563eb` family).
3. Video player is sticky on scroll (desktop) with the mockup shadow; tab bar still reachable.
4. Browser console on the populated share page has ZERO duplicate-key warnings.
5. No sidebar/tab overlap at 768px & 414px; ≥1024px layout unchanged.
6. `pnpm typecheck` GREEN at repo root (the REAL one — `next typegen && tsc -b`, NOT `-F @cap/web` which is a no-op false-green).

## Gate commands (run from repo root, report exact output)
- `pnpm typecheck`  (root script — must be 0 errors)
- (build is heavier; typecheck is the required gate for this UI task)

## Reporting
Final report: list every file changed + one-line what; the grep-clean confirmation for purple; the typecheck result (paste tail); and any deviation from this spec with reason.
