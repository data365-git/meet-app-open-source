# New Design System — Ustoz (approved direction 2026-06-21)

Synthesis: teacher's mockup (HIGHER weight) + Loom's best UX/UI, north star = **understandable & convenient at a glance**. Language stays **English** (owner decision). DNA also from the owner's PulTrack ("oson moliya") project: clean, simple, role-based colour. Owner approved the direction after seeing rendered mockups of all 4 key screens (share/watch, dashboard, recorder, empty state).

## Tokens
- **Accent (primary):** blue `#2563eb` (teacher's; Loom's `#1868db` is near-identical — keep teacher's).
- **Surfaces:** white `#ffffff`; page bg very light `#f7f9fc`.
- **Text:** heading `#101214`, body `#3a3f47`, muted `#7d818a`.
- **Buttons:** PRIMARY = solid blue **pill** (`border-radius: 9999px`); SECONDARY = white **outline pill** (border `#d6dadf`). Exactly **one primary action per screen**.
- **Cards:** white, `border-radius: 12–16px`, `0.5px` border `#eceff3`.
- **Tabs / segmented controls:** pill row on a `#f4f6f8` track; active = filled blue pill.
- **Colour as signal:** blue = primary/progress, green = success, amber = fix, **red = record / danger ONLY**.
- **Font:** Inter (substitute for Loom's proprietary "Charlie"); two weights only (400 / 500).
- **Whitespace:** generous; 8px grid.

## Cross-screen patterns (the "minimal but complete" rules)
- **One loud primary action** per screen; everything else quieter.
- **Progressive disclosure** — nothing is deleted, just ranked: secondary create actions live in a **"New video ▾" dropdown** (Record / Upload / Import from Loom); per-video actions in a **"…" card menu**; org/admin in an **"Admin" sidebar group** + **Settings**.
- **Guided empty states:** icon-in-soft-circle + heading + one-line subtitle + ONE primary pill (+ a quiet text link).
- **Video cards:** thumbnail + **duration badge**, title, **share status + view count**, hover "…".
- **Processing cost hidden from viewers** (already shipped, commit `9e94c7c`).

## Per-screen decisions
- **Dashboard:** clean sidebar = For you / Library / Meetings / Recent + "Admin" group (Settings, Members); bottom blue pill **"New recording"**. Top = pill search + bell + avatar. Main = "Library" + `New folder` (outline) + `New video ▾` (blue, dropdown). Cards as above.
- **Share / watch:** minimal header (back, title, **Share** pill, "…"); **sticky video** + chapter-segmented progress bar; **4 pill tabs** (Summary / Tasks / Transcript / Refined); content cards; comment input pill; floating **"AI chat"** pill (FAB). Cost shown to owner/members only.
- **Recorder dialog:** clean modal; segmented source (Full screen / Window / Tab); Camera + Microphone rows (status pills); **System audio toggle default ON**; blue pill **"Start recording"**; standard **× close** (no fake macOS dots, no "Pro" badge — shipped `d2d4f95`).
- **Empty state:** icon circle + "No videos yet" + one line + **"New recording"** pill + "or upload a video" link.

## Status
- Direction APPROVED (mockups rendered + owner OK'd). Already-shipped pieces that match this design: viewer cost hidden, recorder de-alarmed (blue/gray pills), macOS dots + Pro badges removed.
- NOT yet implemented in code: the full restyle (pills, sidebar IA, dropdown, empty states, card duration badges, tab styling). Implementation pending owner "boshla" + sequencing (and weighed against DEPLOY, which is also pending).

## Pre-build review (REQUIRED before any code — owner directive 2026-06-21)
Owner wants TWO independent analyses confirming the direction is good enough BEFORE writing code: (a) Opus (me), (b) Codex (independent model). If both confirm -> implement.

### Opus pre-review (my analysis) — verdict: GOOD-WITH-CHANGES
Direction is right (one primary action, progressive disclosure, guided empty states, one token set). Fix these before/while coding:
1. Don't pill-ify EVERYTHING — full pills (9999px) on buttons/CTAs only; tabs + containers should be subtler, else it reads "toy"/less professional.
2. Mobile-first share page — recipients mostly on phones; 4 pill tabs must scroll/wrap at 375px; sticky video on mobile.
3. Colour contrast (WCAG AA): muted #7d818a on white is borderline for small text -> darken slightly; verify gray "Off" pill text on light-gray.
4. Design the non-ideal states too: video loading, AI-generating %, upload progress, failed transcription, long-title truncation, many-videos grid/pagination, empty comments.
5. Dark-mode decision: share page is light-only today; either keep light-only on purpose or make the token set dark-safe (don't break existing dark capability).
6. Import discoverability: tucking Import/Upload into "New video v" is clean but ensure it's findable (empty-state "or upload" link helps).
MY #1: lock a small shared component set first (button-pill, card, tab, badge, colour tokens) THEN apply per screen — consistent + low-regression, not ad-hoc per screen.

### Codex pre-review (gpt-5.5, run 2026-06-21) — verdict: GOOD-WITH-CHANGES
Ranked weaknesses (most important first):
1. Mobile share page under-specified — sticky video + 4 tabs + comments sidebar + AI FAB become stacked clutter at 375px (students mostly on phones).
2. Too many pills — full 9999px pills everywhere reads toy-like; full pills for CTAs/status chips only, tabs = softer segmented control.
3. "New video" dropdown may hide the teacher's most-needed action — "New recording" should stay visible; Upload/Import can hide in the dropdown.
4. Hover/`...`-menu-only card actions fail on mobile + for non-technical users — keep 1–2 visible card actions; hide destructive/admin ones.
5. Share header has too many competing exits/actions (Back, logo, copy, edit, analytics, dashboard) — spec must say exactly what survives on mobile.
6. Visual hierarchy not strict enough — dashboard = ONE blue action + one outline + quiet utilities; the equal-weight "New Folder/Import/Record" must be fully broken, not just restyled.
7. AI chat FAB can block mobile content/comments + when keyboard is open — needs bottom-safe-area placement rules.
Missing states (Codex): video loading/failed playback, password/email-gated errors, still-uploading, transcription failed/no-audio, AI queued/processing/error/retry, empty comments/transcript/refined/tasks, no folders, no videos in folder, pagination, long uz/ru/en titles, long org names/URLs, missing/processing thumbnails. Responsive rules (320/375/430/tablet/desktop, tab scroll-vs-wrap, comments-below-video, FAB-hide-on-keyboard, sticky height) all missing. A11y: #2563eb on white OK; #7d818a small text weak; gray-on-light-gray pill text may fail WCAG AA.
Codex #1 (do before any code): write a mobile-first interaction spec for the share/watch page at 375px (header actions, sticky video, tab overflow, comments placement, FAB placement, visible-vs-hidden actions) — the highest-risk path.

### SYNTHESIS — single verdict (2026-06-21): GOOD-WITH-CHANGES (both independent reviewers agree; neither said "not-yet")
STRONG OVERLAP (both flagged → these are non-negotiable): (1) mobile-first share page = the #1 risk; (2) don't pill-ify everything (CTAs/chips only); (3) WCAG-AA contrast — darken #7d818a, fix gray-on-gray; (4) design the non-ideal/empty/error/loading states; (5) keep Import discoverable.
CODEX-ONLY ADDS (accept): hover/menu-only card actions break on mobile (keep visible actions); share header overload (define mobile survivors); break dashboard equal-weight CTA pattern fully; AI-FAB keyboard/safe-area rules.
AGREED BUILD ORDER: STEP 0 = write the 375px mobile-first share-page interaction spec + darken contrast tokens (Codex #1). STEP 1 = lock the shared component set — colour tokens, button-pill, card, tab(segmented), badge (Opus #1). STEP 2 = apply per screen (share → dashboard → recorder → empty states), agents + my review + gates.
GATE TO START = owner "boshla" (+ sequencing vs the pending DEPLOY).
