# Polish Decision-Map — cap-v2 (Ustoz) share/consumption surface

_Wayfind map (owner: "loyihani kamchiliklarini tuzatish yani polish", 2026-07-13). One unit per session; the map carries context across `/clear`, not the window. Resolve → record the decision inline → flip status → unblock dependents._

## GOAL
The surface the IT team actually sees — the `/s/[videoId]` share page (player + AI tabs + status view + chat) plus `/login`/`/embed` — looks and feels **excellent**: calm, glance-clear, ONE accent as signal, correct in **light AND dark**, comfortable on **mobile**, with every QA-found rough edge fixed and **verified live** (never blind-shipped). "Done" = an owner walk on his phone finds nothing that reads as rough, broken, or templated.

## HARD CONSTRAINT (shapes ordering)
Browser-pane **screenshots timed out ALL of the build session** → visual polish could not be verified headlessly. Blind visual shipping is forbidden (this session's core lesson). So the FIRST unblocking unit is establishing a trustworthy visual-verify channel; almost every visual unit is blocked by it.

## OPEN DECISIONS

### D1 — [task] Establish a working visual-verify channel · status: OPEN · blocks: D2,D4,D7,D8
Screenshots broke this session (even video-less /login). Decide the channel: (a) local `pnpm dev:web` on :3001 + Browser pane against localhost; (b) a fresh Claude session where the pane may recover, against live data365; (c) owner's phone as the oracle for each screen. Recommend: try (a) first (fully self-serve, screenshottable), fall back to (c). No decision needed from owner — mechanical. **This unblocks all visual work.**

### D2 — [research/verify] Live-verify the just-shipped batch · status: OPEN · blocked-by: D1 (partial: DOM-reads work now) · blocks: D3,D8
Deploy `10e0149` (in progress at map-time): confirm on data365 — (1) AI-status view renders as the Fable design (vertical 3-stage list, in-row bar, no slop); (2) chat is the blue FAB → dialog; (3) tabs switch fine; (4) tap-targets ≥44px; (5) mailto gone. DOM-reads already possible; visual confirmation needs D1. Records what actually landed vs what still looks rough.

### D3 — [grill] Dark-mode direction · status: OPEN · blocked-by: D2
Share/embed ignore system dark (0 `dark:` variants in share components; theme is `body.dark` class-based, no provider on /s). Owner choice: (a) add a light/dark toggle to ShareHeader; (b) honor `prefers-color-scheme` by adding `body.dark`; (c) leave light-only. Trade-off: (b) auto-themes via Radix tokens BUT every share component is untested in dark → likely rough surfaces to fix. Owner decides scope/appetite. → `/grill-with-docs`.

### D4 — [prototype] Dark-mode visual (only if D3 ≠ "leave light-only") · status: BLOCKED · blocked-by: D3,D1
If pursued: enable dark on /s, walk every share surface in dark, fix the un-tuned ones. Cheap prototype the owner reacts to before committing. → `/prototype`.

### D5 — [research] Dock (#2/F9) root cause · status: OPEN · blocked-by: owner on-device confirm
Slim bottom bar didn't activate in headless tests (but code looks correct + prior check saw it). Owner confirms on phone post-deploy. If genuinely broken → real repro → fix the `setDocked` path. If it works → close as headless artifact.

### D6 — [research] "Optimizing" badge / raw-source · status: OPEN · (AFK-able, independent)
`CapVideoPlayer.tsx:731` shows the badge because `resolvedSrc.type === "raw"` — the optimized mp4 isn't the active source on a COMPLETE video. Investigate the transcode/source-resolution pipeline: does the mp4 exist in R2? Is resolution preferring raw? Fix so a done video serves the optimized source (or the badge clears). Low, but real.

### D7 — [task] T4b "Audioga almashtirish" relocation · status: OPEN · blocked-by: D1 (verify placement)
Owner earlier: move it from the player pill into the video-card ⋮ dropdown next to "Delete recording" (`CapCard.tsx`), keep ConfirmationDialog, guard on "has video track". Server action already built. Mechanical once placement verified visually.

### D8 — [verify] Supermodel visual sweep · status: BLOCKED · blocked-by: D1,D2
Walk `/s`, `/login`, `/embed` at 375/768/1280 in light+dark: alignment, spacing rhythm, truncation, contrast, focus/hover states, icon alignment. Emit fixes into QA_POLISH.md, apply via `frontend-design`. This is the "make it excellent" pass; do it LAST, once the structural fixes + verify channel are in.

## PROGRESS (2026-07-14)
- **D1** verify channel → RESOLVED: screenshots broke all session (video renderer hang, even localhost); channel = DOM/computed-style reads + owner's phone at deploy. Local dev server (:3001) IS up for DOM checks.
- **D2** live-verify shipped batch → PARTIAL: blue-FAB chat verified LIVE (opens dialog, inline gone); tabs work; #8 status-UI only renders during processing (verify on phone/processing video).
- **D3** dark-mode → RESOLVED: owner "hozircha skip" — deferred to a dedicated visual pass (0 dark: variants in share components + unverifiable headlessly = too risky to ship blind).
- **D5** dock → SUPERSEDED by a new build: owner rejected the pinned bar on his phone → **floating mini-player** built (Fable-reviewed, `2026-07-14-floating-miniplayer-design.md`, commit 3e409da) — awaits his on-phone confirm at deploy.
- **D6** "optimizing" badge → RESOLVED-as-Low: badge is **owner-only** (`Share.tsx:511` `viewerId === data.owner.id`); the team never sees it. Video is source=webMP4 serving raw (optimized-mp4 probe fails); plays fine. Transcode-pipeline fix is disproportionate for an owner-only Low — surfaced, no change.
- **D7** T4b relocation → still OPEN (dashboard/auth-gated code move; next round).
- **D8** supermodel sweep → still BLOCKED on a visual channel (deploy + phone).

## ORDER (the unblock chain)
**D1 (verify channel)** → **D2 (live-verify what shipped)** → then parallel: **D3→D4 (dark-mode)**, **D5 (dock, owner)**, **D6 (badge, AFK)**, **D7 (T4b)** → finally **D8 (supermodel sweep)**. D1 is the keystone: without a way to SEE, no visual unit can honestly close.

## When done
All units resolved → the recorded decisions ARE the polish spec → hand to `/writing-plans` (or apply directly via `frontend-design`), implement, verify live.
