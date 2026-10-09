# Task 003 — Share / Watch Page: mobile-first polish (no regressions)

## Goal
Make the share/watch page (`apps/web/app/s/[videoId]`) flawless on mobile (375px target) while keeping
the existing desktop look (which already matches the teacher's mockup). This is the #1 user path —
students open share links on phones. **Correctness > everything: do NOT break any existing function.**

Design source of truth: `docs/SHARE_MOBILE_SPEC.md` + `docs/NEW_DESIGN.md`. Accent blue `#2563eb`/`#1d4ed8`,
white surfaces, page bg `#f7f9fc`, pills for CTAs/chips only, cards `12–16px` radius.

## Codex handoff - 2026-06-26
Claude, Codex made a first mobile UX/UI cleanup pass, not a full redesign. Treat this as a safe baseline
to continue from.

Changed files:
- Auth/dev overlay: `apps/web/app/(org)/login/page.tsx`, `apps/web/app/(org)/login/form.tsx`,
  `apps/web/app/(org)/signup/page.tsx`, `apps/web/app/(org)/signup/form.tsx`,
  `apps/web/app/Layout/providers.tsx`
- Dashboard mobile shell: `apps/web/app/(org)/dashboard/_components/DashboardInner.tsx`,
  `apps/web/app/(org)/dashboard/_components/MobileTab.tsx`,
  `apps/web/app/(org)/dashboard/_components/Navbar/Mobile.tsx`,
  `apps/web/app/(org)/dashboard/caps/components/SelectedCapsBar.tsx`
- Share/mobile: `apps/web/app/s/[videoId]/_components/ShareHeader.tsx`,
  `apps/web/app/s/[videoId]/_components/Sidebar.tsx`,
  `apps/web/app/s/[videoId]/_components/BelowVideoTabs.tsx`,
  `apps/web/app/s/[videoId]/_components/ai-chat.css`,
  `apps/web/app/s/[videoId]/_components/tabs/Activity/Comments.tsx`

What changed:
- Login/signup now use `min-h-svh`, mobile padding, scroll-friendly layout, and a real top Home link.
- TanStack devtools now requires a URL flag in development, so it no longer covers mobile auth screens.
- Dashboard bottom tab, org switcher menu, selected-caps bar, drawer, and main scroll area now account for
  `env(safe-area-inset-bottom)`.
- Share header mobile touch targets are larger; mobile Share is now a visible primary blue pill.
- Share sidebar is sticky only on `lg+`; on mobile it stays in normal flow.
- AI chat gets mobile bottom-sheet sizing, safe-area padding, and hides the FAB while inputs/textareas are focused.
- Comments input and tab panel padding were adjusted for small screens.

Checks run:
- `apps/web`: `node_modules/.bin/next.CMD typegen` - passed
- repo root: `node_modules/.bin/tsc.CMD -b --pretty false` - passed
- repo root: `git diff --check -- apps\web\app` - passed
- Chrome/Playwright screenshots at 390px and 320px for `/login` and `/signup` - no horizontal overflow.

Could not fully smoke test:
- `/s/xg7yh84kpggh4q8` failed locally with DB `ECONNREFUSED`, so share-page visual verification still needs a
  working local DB/session or live preview.
- Dashboard login also failed with available local credentials, so `/dashboard/caps` still needs real mobile
  screenshot verification.

Important note: some "Verified background" bullets below are stale now. For example, `BelowVideoTabs.tsx`
already behaves as an active-tab panel with `role="tablist"`/`role="tab"` rather than the old stacked
scroll-spy version. Re-read current code before continuing.

## Codex handoff - 2026-06-27
Claude, Codex continued the mobile pass and did the missing logged-in read-only check on live production.
Nothing was pushed or deployed. Local code is still uncommitted.

Extra changed files after the 2026-06-26 handoff:
- `apps/web/app/(org)/dashboard/_components/ExtensionUpdateBanner.tsx`
- `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`
- `apps/web/app/(org)/dashboard/_components/Navbar/Mobile.tsx`
- `apps/web/app/s/[videoId]/_components/BelowVideoTabs.tsx`
- `apps/web/app/s/[videoId]/_components/ShareHeader.tsx`
- `apps/web/app/s/[videoId]/_components/ai-chat.css`

Extra changes:
- Extension update banner is compact on mobile: short text, primary Update pill, larger close target.
- Mobile drawer close button and top logo link now have 44px touch targets.
- Drawer nav rows are 44px tall in the mobile drawer; desktop sidebar remains smaller.
- Share tabs use short mobile labels (`Tasks`, `Clean`) and 44px min-height to avoid clipped tab buttons.
- AI popup mobile close button is bigger; the open black FAB is hidden on mobile so it does not cover the
  bottom-sheet input.
- Share page Back / Shared buttons are taller on mobile while preserving compact desktop sizing.

Logged-in live read-only check:
- Logged into `https://capweb-production-dd85.up.railway.app` at 390x844, no data mutations.
- Checked `/dashboard/caps`, `/dashboard/meetings`, `/dashboard/extension`,
  `/dashboard/settings/organization`, mobile drawer, first share page, and opened AI popup.
- Screenshot folder: `C:\Users\LOCALH~1\AppData\Local\Temp\ustoz-live-mobile-inside-2`.
- Live page-level horizontal overflow was false on checked pages.
- Live still shows old issues because these local fixes are not deployed yet: long extension banner, small
  close button, 28px share header icons, huge AI aura/popup behavior, and clipped `Clean Transcript` tab.
- Settings nav overflow in live is inside an intentional horizontal scroll tab bar, not page-level overflow.
- Production emitted page errors `Minified React error #310` and `#418` plus 404 console errors. This is
  separate from the local mobile CSS/layout patch and should be investigated with a non-minified/dev setup.

Local checks run after the new patch:
- `git diff --check -- apps/web/app` passed.
- `apps/web`: `node_modules/.bin/next.CMD typegen` passed.
- repo root: `node_modules/.bin/tsc.CMD -b --pretty false` passed.
- Local `/login` and `/signup` at 320px and 390px passed no-horizontal-overflow smoke screenshots.

Still blocked:
- Full logged-in local smoke is blocked because the local `.env` database target is unavailable
  (`mysql://root:@localhost:3306/planetscale`, MySQL connection refused). Do not claim full local logged-in
  verification until the DB/session issue is fixed or a local test DB is running.
- Deploy was not done. Branch `qa-fixes` auto-deploys only after push; these local UX changes have not been
  pushed.

## Codex senior QA audit - 2026-06-27
Claude, Codex then did a broader senior-style read-only audit across desktop/mobile and light/dark on the
live Railway app, plus a code-risk pass on the local mobile UX patch. This was review/QA only, not deploy.

Coverage:
- Desktop 1440x950: checked dashboard caps, meetings, analytics, extension, import, import/file,
  import/loom, spaces browse, account/notification/org settings pages, admin access, and a share page in
  light and dark.
- Mobile 390x844: checked the same core dashboard/settings/admin/share surfaces in light and dark.
- Safe interactions verified without mutating data: search dialog, notification panel, org switcher, user
  menu theme toggle, new-folder dialog open, recorder dialog open, import page navigation, Loom tabs, cap
  more-options menu, share status dialog, share channel menu, share owner menu, share tabs, AI popup,
  video playback, and comment textarea typing without submit.

Results:
- Desktop dashboard pages had no page-level horizontal overflow in both themes and were generally readable.
- Mobile dashboard pages also had no page-level horizontal overflow, but several areas still rely on hidden
  horizontal scrolling or cramped tables: settings/org tab bars, spaces browse, and admin access users.
- Share page ignores the dark theme cookie and renders light-only. That may be historical, but it fails a
  "dark/light everywhere" expectation.
- Production still shows old mobile issues because local fixes are unpushed: extension banner is too tall,
  banner close target is tiny, share header icon buttons are 28px, AI popup/aura behaves like desktop on
  mobile, and Clean Transcript clips in the tab bar.
- Production emitted `Minified React error #310` on `/dashboard` and earlier mobile checks also saw `#418`.
  Treat these as product risks separate from the CSS patch; debug in non-minified/staging with source maps.
- Notification panel desktop has an odd visible footer/hints area ("Navigate", "Settings") that looks like
  internal keyboard-help UI leaking into the panel.

Local patch status:
- `git diff --check -- apps/web/app` passed.
- `apps/web`: `node_modules/.bin/next.CMD typegen` passed.
- repo root: `node_modules/.bin/tsc.CMD -b --pretty false` passed.
- Local `/login` and `/signup` 320px/390px screenshots had no horizontal overflow.
- Full local logged-in smoke is still blocked by local MySQL `ECONNREFUSED`; use live/staging or start a
  compatible local DB before claiming local E2E coverage.

Not tested intentionally on production:
- Destructive or data-changing flows: delete, duplicate, password changes, share settings save, invite/member
  role/remove, user reset/revoke/admin actions, upload submit, recording start, AI analysis start, AI chat
  send, comment/reaction submit, and download-heavy paths.

## Codex fixes after senior audit - 2026-06-27
Claude, Codex started fixing the audit findings one by one. These fixes are local only at the time of writing:
not committed, not pushed, and not deployed.

Fixed locally:
- Notification popover footer no longer shows the internal keyboard hint row ("Navigate" with arrows). It is
  now a clean footer with "View all notifications" and "Settings".
- `/dashboard/spaces/browse` now has mobile cards for spaces; desktop keeps the table.
- `/dashboard/admin/access` now has mobile cards for users and invite links; desktop keeps the tables.
- Organization members, permissions, and activity pages now have mobile card/list views instead of relying
  only on cramped horizontal tables.
- `apps/web/public/theme-script.js` now applies the saved theme on `/s/...` share pages too.
- Share page visible shell pieces were moved from hardcoded white/hex colors to theme tokens: the video frame,
  below-video tabs/panel, share header dropdowns, and activity/sidebar shell.

Checks run after these fixes:
- `git diff --check -- apps/web/app apps/web/public/theme-script.js` passed.
- `apps/web`: `node_modules/.bin/next.CMD typegen` passed.
- repo root: `node_modules/.bin/tsc.CMD -b --pretty false` passed.
- `apps/web`: `node_modules/.bin/next.CMD build --turbopack` passed.
- Local Playwright via system Chrome at 390x844:
  - `/login` 200, no horizontal overflow.
  - `/signup` 200, no horizontal overflow.
  - `/dashboard/caps` redirected to `/login` because local session is not logged in.
  - `/s/pk6a04fza69qfy0` returned 500 because local DB query failed; this is still the local DB blocker.

Still not fixed/proven:
- Production `Minified React error #310`/`#418` was not reproduced locally because logged-in/local share pages
  are blocked by unavailable local DB. Debug this after a staging/prod deploy with source maps or a working
  local DB.
- These UI fixes need a push/deploy before live production can show them. Branch `qa-fixes` auto-deploys only
  after push.

## Verified background (read these first; line numbers are current)
- `_components/ShareHeader.tsx` — the header. Owner sees a FLAT pile of actions: Back, branding (logo +
  hover Change/Remove), title (editable h1), a wide copy-URL pill (`getDisplayLink()`), an author row
  (avatar/name/date), `renderSharedStatus()` ("Shared ▾" / "Make shareable"), and an owner action row
  (`Edit video`, `View analytics`, `Go to dashboard`) at lines 598–635. On 375px this overflows visually.
- `_components/BelowVideoTabs.tsx` — the 4 tabs (Summary/Tasks/Transcript/Refined) are SCROLL-SPY anchors,
  not real tabs: all 4 panels render stacked; clicking scroll-jumps. The tab bar is `sticky top-0 z-10`
  (lines 109–110) AND the video is `sticky top-0` → **CONFIRMED BUG: on scroll the tab bar overlaps the
  video (both pinned to top:0)**. Tab buttons are plain `<button>` (no `role="tab"`). Inline styles,
  hardcoded hex (`#1d4ed8`, `#475569`, `#eef4ff`, `#e9edf3`, `#94a3b8`).
- `_components/ShareVideo.tsx` line ~368 — the video frame: `relative aspect-video sticky top-0 z-10 ...`.
  Keep it sticky; cap height so it never exceeds ~38vh on short viewports.
- `_components/AIFab.tsx` + `ai-chat.css` — floating "Ask AI about this meeting" pill, `position: fixed`
  bottom-right, ~62×62. No safe-area inset; does not hide when a text input is focused.
- Section headings in panels use `#94a3b8` on white (fails WCAG AA for small text).

## Changes (each must be verifiable)
1. **Header — collapse on mobile (ShareHeader.tsx).**
   - Always visible (all viewports): **Back** (owner only, as today), **Title** (truncate 1 line), and the
     **share status / copy** control.
   - On mobile (`< sm`/`< lg`): move the owner-only actions — `Edit video`, `View analytics`,
     `Go to dashboard`, and the branding `Change logo`/`Remove` — into a single **"…" overflow menu**
     (use the existing `@cap/ui` Dropdown/Popover; owner/members only). On `sm`+ keep the current inline
     row (don't change desktop). The wide copy-URL pill: on mobile shrink to an icon-only **Copy** button
     (keep full pill on `sm`+).
   - A non-owner viewer on mobile sees only: Back (if logged in) + Title + the "Shared with you" chip. No
     change for viewers on desktop.
   - Keep ALL existing handlers/logic intact (copy, edit title, sharing dialog, upgrade modal). Only the
     responsive arrangement changes.
2. **Fix sticky overlap (BelowVideoTabs.tsx + ShareVideo.tsx).**
   - The video stays the single sticky element at `top:0`. **Remove `sticky top-0` from the tab bar**
     (make it a normal-flow segmented control). It still scrolls with content.
   - So a clicked tab's section is not hidden behind the sticky video, add `scroll-margin-top` to each
     `<section>` equal to the sticky video height + a small gap (e.g. `scroll-mt-[210px]`, tune so the
     section heading lands just under the stuck video). Verify by clicking each tab and confirming the
     heading is visible, not covered.
   - Cap the sticky video height to `max-h-[38vh]` (or equivalent) so it never dominates short screens.
3. **Tabs accessibility (BelowVideoTabs.tsx).**
   - Add `role="tablist"` to the bar, `role="tab"` + `aria-selected` to each button, and
     `tabIndex`/arrow-key handling is optional but `aria-selected` is required. Keep the scroll-spy behavior.
   - Ensure the bar scrolls horizontally (`overflow-x-auto`, `flex-nowrap`, no shrink-to-unreadable) so it
     survives 320px; the active pill scrolls into view.
4. **AI FAB (AIFab.tsx / ai-chat.css).**
   - Add bottom safe-area inset: `bottom: calc(<current> + env(safe-area-inset-bottom))`.
   - Hide the FAB while any `input`/`textarea` on the page is focused (comment box / on-screen keyboard) —
     a focusin/focusout listener toggling a class is fine. Restore when blurred.
5. **Contrast (WCAG AA).**
   - Darken panel section headings from `#94a3b8` to `#64748b` (slate-500, AA on white). Check any other
     small muted text on white (`#7d818a`-class) and bump to ~`#5f636b` if it fails AA. Do not change the
     accent blue.
6. **Empty states.**
   - Confirm Tasks / Transcript / Refined / Comments each render a guided empty state (small icon +
     one-line message) when there is no content — never a blank panel. Add a minimal one where missing.

## Files you MAY edit
- `apps/web/app/s/[videoId]/_components/ShareHeader.tsx`
- `apps/web/app/s/[videoId]/_components/BelowVideoTabs.tsx`
- `apps/web/app/s/[videoId]/_components/ShareVideo.tsx` (sticky height cap only)
- `apps/web/app/s/[videoId]/_components/AIFab.tsx` and `ai-chat.css`
- `apps/web/app/s/[videoId]/_components/panels/*.tsx` (empty states + heading colour only)
- Comments empty state: `apps/web/app/s/[videoId]/_components/tabs/Activity/*.tsx`

## Files you MUST NOT touch
- Any server action, data fetch, route handler, auth, the AI generate pipeline, the video player engine
  (`CapVideoPlayer.tsx`), DB. No new dependencies. Do not rename files or exports.

## Constraints
- Edit via Edit/Write, UTF-8. Match the existing code style. No unrelated refactors. Keep the brand
  string "data365" as-is. Do not convert the whole page to a token system in this task (too risky) —
  only the specific colour values named above.
- Mobile-first: default styles target small screens; use `sm:`/`lg:` to restore the current desktop layout.

## Acceptance criteria
- At 375px: no horizontal overflow; mobile header shows only Back + Title + share-status/copy(+"…" for
  owner); the "…" menu contains Edit video / View analytics / Go to dashboard / branding actions.
- Scrolling the content no longer overlaps the tab bar with the video; clicking each of the 4 tabs lands
  the section heading visibly below the stuck video.
- Tabs expose `role="tab"`/`aria-selected`; the bar scrolls horizontally at 320px.
- FAB sits above the safe-area and disappears when the comment input is focused.
- Section headings + small muted text meet WCAG AA on white.
- Tasks/Transcript/Refined/Comments never show a blank panel.
- **Desktop (≥1024px) looks the same as before** (regression check).
- Gate: from repo root, `pnpm typecheck` (which runs `next typegen && tsc -b`) is GREEN. Report the exact output.

## Final report
List files changed, the exact responsive breakpoints you used per change, the typecheck output, and any
deviation from this spec with the reason.
