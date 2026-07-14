# Floating mini-player (dockable video) — Design Plan (for Fable review)

**Owner spec (2026-07-13, verbatim intent):** when the user scrolls down to read the AI analysis, the video should stay visible as a **floating mini-player in the TOP-RIGHT**, **smaller than the main player but BIGGER than the old tiny dock**, showing the **real player with ALL controls working** (play/pause, seek, volume, fullscreen — not a stripped slim bar), and **dismissible (×)**. For **audio-only** videos, a **Telegram-audio-player-style pin bar**. It must NOT feel "stuck/pinned" (his rejection of the previous slim-bar dock).

**History (why this is the 4th attempt — don't miss again):** floating draggable corner box → (owner: "in the way of reading") → slim bottom bar with no video pixels → (owner: "pin bo'lib qolyapti", worse than Railway) → **now:** top-right floating REAL player, bigger, full controls, dismissible.

**Component:** `apps/web/app/s/[videoId]/_components/DockableVideo.tsx` (currently the slim-bottom-bar version). It already has the load-bearing bits: an IntersectionObserver that flips `docked` when the inline player scrolls off, a **no-remount stable host** (the `<video>` is rendered once and only CSS position toggles — a remount would restart playback), slot-height reservation, `dismissed`/`activated` state, and `isAudio`. Rework the DOCKED rendering only.

**Constraints (facts):**
- No-remount invariant MUST hold: `children` (the real CapVideoPlayer + media-chrome controls) stays mounted; docking only changes CSS position/size of its wrapper. Do NOT hide the player and draw a separate control bar for VIDEO (that's what made controls feel limited before) — float the REAL player so all its controls work.
- Desktop layout: the share page is a 2-col grid ≥1280px — video LEFT, **AI panel is the sticky RIGHT column** (what the user reads). A viewport-top-right float would overlap the AI panel.
- Design system: Tailwind + Radix gray scale + `--brand`; light + dark; honor `prefers-reduced-motion`. Mobile is the owner's primary device (375px).

## Proposed design

**Trigger:** show the mini when the inline player has scrolled out of view AND has been played (existing `docked && activated`), dismissible with ×; re-scrolling the inline player back into view restores it (existing).

**VIDEO mini (the main case):**
- Position: **fixed top-right**, `top-4 right-4` (below any header). Size **`w-[min(380px,70vw)]`** desktop / **`w-[min(320px,64vw)]`** — bigger than the old dock, ~16:9, rounded-2xl, shadow-lg, thin border.
- Content: the **real player** (playerHost VISIBLE — remove the docked `opacity-0`), so media-chrome's full control bar (play/seek/volume/fullscreen/speed) works natively at the smaller size.
- Overlay: a small **× dismiss** top-right corner of the mini (and optionally a "return to inline" affordance — tapping the mini body scrolls back to the inline player).
- Motion: fade + slight scale-in (180ms), `motion-safe` only.

**Desktop overlap resolution (the key open question):** at ≥1280px the AI panel occupies top-right. Options: (a) on desktop, dock to **bottom-right** instead of top-right (clears the AI reading area), top-right only on mobile; (b) keep top-right everywhere and let it float above the panel (dismissible); (c) shrink + top-right with a small offset. **Recommend (a):** mobile = top-right (owner's stated case, single column, no conflict); desktop ≥xl = bottom-right (standard miniplayer spot, doesn't cover the AI panel). Ask reviewer to confirm.

**AUDIO mini (Telegram-style pin):** no video frame → a slim horizontal **pin bar**, `fixed top-4 right-4` (mobile) / `bottom-4 right-4` (desktop), `w-[min(360px,80vw)]`: play/pause + thin seek + elapsed/-total + title + ×. Compact, calm, like Telegram's audio pin. (This is close to the existing slim bar — reuse its DockSeekBar/time.)

**Anti-"stuck" feel:** clean fade-out on × and on scroll-back; generous corner offset; shadow so it reads as floating above content, not welded to an edge; never covers the primary reading column.

## Scope / non-goals
- Rework `DockableVideo.tsx` docked rendering only; keep the observer + no-remount host + audio branch.
- No backend, no changes to CapVideoPlayer's own controls.
- Verify: tsc + DOM-reads on localhost dev (screenshots are broken this session — video renderer hang); owner confirms pixels on his phone at the next batch deploy.

## ✅ FINAL SPEC (Fable-reviewed 2026-07-14 — read the actual page code; supersedes the proposal above)

Fable approved floating the real player, but page geometry forces specific placement (getting it wrong = a 4th rejection). Build EXACTLY this.

**Placement (geometry-forced, don't offer options):**
- **Mobile/tablet (<xl):** `fixed right-3`, top = **below the sticky share header** — measure the header height (ref / CSS var), do NOT hardcode `top-4`/`top-16` (`ShareHeader.tsx:495` is `sticky top-0 z-10`, stacks flex-col on mobile). Width **`min(230px,60vw)`** (~225px @375 — bigger than the old bar, but leaves the left ~40% of text readable). Let the player's aspect drive height.
- **Desktop (≥xl):** `fixed left-4 bottom-4`, width **380px**. **Bottom-LEFT** is the only clean quadrant — bottom-right has the AI chat FAB (`ai-chat.css` z-index 2147483002), top-right/right has the sticky AI panel.
- Elevation: `shadow-[0_8px_30px_rgba(0,0,0,0.25)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.55)]` + `ring-1 ring-black/10 dark:ring-white/15`. `rounded-xl overflow-hidden`. No opaque bg (video edge-to-edge). Keep `z-50`.

**Video mini = the REAL player (no remount):** host flips from `opacity-0 absolute -z-10` to visible; ONLY classes on the SAME host div change; render the overlay strip as a SIBLING inside the fixed wrapper (no re-parenting). 
- **Top overlay strip:** absolute top gradient `from-black/50 to-transparent` ~40px, **expand chip top-LEFT, × top-RIGHT**, icons `size-4` inside **`size-10` (≥40px) hit targets**, white/90 on scrim, no boxes. (Current `size-7` × fails at 375px.) Always-on for v1 (no hover on mobile).
- **Docked chrome diet (via `data-docked` on the wrapper → CSS in CapVideoPlayer, NO remount):** hide the in-player LanguagePicker (`absolute right-3 top-3`) + caption pill (they collide with ×), cap the center play button (`size-12 xs:size-20 md:size-32` → keep `size-12` when docked), hide volume slider + speed control. **Keep play, seek, time, fullscreen.** Disable the mobile swipe-seek gesture layer (`CapVideoPlayer.tsx:~1254`) when docked (it eats scroll in a 127px mini).
- **Motion:** 200ms ease-out, mobile enters `translateY(-8px) scale(0.96) opacity-0 → identity` (from the top, where the player exited); desktop bottom-left uses `translateY(8px)`. Exit reverse 150ms. `motion-safe` only. No spring/bounce. Directional slide (not a fade) is what kills the "installed/stuck" feel.

**Audio pin (Telegram-style under-header bar, NOT a corner chip):** `fixed inset-x-2`, top = below header (mobile); desktop `left-4 bottom-4 top-auto right-auto max-w-[420px]`. Height 48px, `rounded-xl border border-gray-5 bg-gray-1/95 backdrop-blur-md shadow-md`: 36px play/pause circle (`bg-[--brand]`) · truncating title (`text-xs text-gray-12`) + thin `DockSeekBar` under it · `tabular-nums` time (`text-gray-10`) · ×. Reuses the current slim-bar internals (they were only wrong for VIDEO). `DockSeekBar` fill: `bg-blue-500` → `bg-[var(--brand)]`.

**Behavioral fixes:** keep `activated` true once set until dismiss (so "scroll down while paused" still shows the mini — else the owner calls it a bug). Guard the IntersectionObserver while `document.fullscreenElement` is set (avoid a dock/undock flap when entering/exiting fullscreen from the mini). `handleExpand` (smooth scrollIntoView) stays as the return-to-inline; do NOT add tap-body-to-return (media-chrome owns body taps).

**Verify:** tsc + DOM-reads on localhost (screenshots broken this session); owner confirms pixels on phone at next batch deploy. Light+dark both.

## Open questions for the reviewer
1. Desktop overlap: mobile top-right + desktop bottom-right (recommended) vs top-right everywhere?
2. Size: is `min(380px,70vw)` the right "bigger than default, smaller than main"? Too big on mobile?
3. Should tapping the mini body return-to-inline, or only the ×/expand affordance? Any accessibility trap with a fixed player + its own fullscreen control?
4. Anything that will still read as "stuck/pinned" and cause a 4th rejection?
