# Loom vs Our App — UX Comparison & Minimal Recommendations

> Guiding philosophy: **Only necessary and understandable, NO excess functions — like the real Loom.**
> Every recommendation is either REMOVE (clutter), CLARIFY (label or wording), or ADD-SMALL (one small
> missing pattern). No new big features. Subtraction is the primary tool.

---

## 1. Sidebar / Navigation

### What Loom does well
- Single flat list: logo → workspace switcher → nav items (icon + label) → "Admin tools" group → blue "Record a video" bottom CTA.
- Exactly two visual groups, clear divider between user nav and admin tools.
- Collapsible to icon-only with tooltips; no extra chrome.

### What our app does (source: `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`, `SpacesList.tsx`)
- Nav items: Instructional recordings / Meeting Recordings / Analytics / Record a Cap / Import Video / Organization Settings / (conditional) Access Management / (conditional) Developers.
- Below nav: a collapsible Spaces section with "Browse spaces" + individual space links + "Create space" button.
- Bottom: Storage indicator + avatar popover menu containing: Homepage / Upgrade to Pro / Earn 40% Referral / Chat Support / Download App / Toggle Dark Mode / Settings / Sign Out.
- No persistent primary CTA button in the sidebar (record is just another nav item in the list).
- "Import Video" is a nav item AND also a toolbar button on the caps page — duplicated.
- "Record a Cap" is a nav item AND the "Record in Browser" button in the toolbar — duplicated.

### GAP
- No single blue "Record a video" CTA anchored at the bottom of the sidebar like Loom.
- Import Video + Record a Cap as nav items bloat the nav; they are actions, not destinations.
- "Earn 40% Referral" is a sidebar menu item with a persistent red pulsing dot — distracting for a self-hosted product.
- "Download App" in the menu is irrelevant for a self-hosted deployment.

### Recommendations
- [REMOVE] Remove "Record a Cap" from the nav item list — the toolbar button + a sidebar bottom CTA is enough. Effort: **S**
- [REMOVE] Remove "Import Video" from the nav item list — it is already a toolbar button on the caps page. Effort: **S**
- [ADD-SMALL] Add a blue "Record a video" button pinned to the bottom of the sidebar (above the user avatar area) that opens the WebRecorderDialog. This makes the primary action always visible, mirrors the Loom pattern, and eliminates the need for Record a Cap as a nav item. Effort: **S**
- [REMOVE] Remove "Earn 40% Referral" menu item and the pulsing red dot from the sidebar (irrelevant for self-hosted / data365 brand). Effort: **S**
- [REMOVE] Remove "Download App" from the avatar menu (irrelevant for a web-first self-hosted product). Effort: **S**
- [CLARIFY] Rename nav item "Instructional recordings" → "My Videos" (shorter, clearer, matches the Loom "Library" concept). Effort: **S**

---

## 2. Home / Dashboard (Videos List)

### What Loom does well
- Header toolbar: one search bar (wide, centered), secondary actions top-right (upgrade + bell + avatar).
- Content toolbar: "New folder" (outline) + "New video" (blue, primary) with sort/filter row below.
- Exactly one blue primary action per screen.

### What our app does (source: `apps/web/app/(org)/dashboard/caps/Caps.tsx`)
- Three equal-weight buttons in a row: "New Folder" (dark variant) / "Import Video" (separate component) / "Record in Browser" (blue variant).
- Three buttons of similar visual weight compete for attention.
- No sort/filter row beneath them.
- The top navbar has a search bar (in `Top.tsx`) but it is in the header above — fine.
- "New Folder" uses `variant="dark"` (same weight as other buttons), not clearly secondary.

### GAP
- Three action buttons = no clear primary. Loom has one blue primary ("New video") and one outline secondary ("New folder").
- "Import Video" button in the toolbar duplicates the removed nav item (if nav item is removed, this is fine to keep here, but its visual weight should be secondary/outline).

### Recommendations
- [CLARIFY] Promote "Record in Browser" to the sole `variant="blue"` primary button. Demote "New Folder" and "Import Video" to `variant="white"` (outline) secondary buttons. Effort: **S**
- [CLARIFY] Rename "Record in Browser" → "New Recording" (matches Loom's "New video" language pattern; shorter). Effort: **S**

---

## 3. Empty States

### What Loom does well
- Every empty state: illustration + big heading + one-line subtitle that explains context + ONE blue button guiding the next action.
- The button text is action-forward: "Find a Loom to watch", "Connect Google Calendar", "Record a Loom".
- No competing secondary options in the empty state itself.

### What our app does (source: `apps/web/app/(org)/dashboard/caps/components/EmptyCapState.tsx`, `spaces/[spaceId]/components/EmptySharedCapState.tsx`)

**Main caps empty state (EmptyCapState.tsx):**
```
Heading: "Hey [name]! Record your first Cap"
Subtitle: "Craft your narrative with Cap - get projects done quicker."
Buttons: [Download Cap] [or] [Record in Browser] [or] [Upload]
```
- Three equal-weight CTAs in a row with literal "or" text between them.
- The subtitle is vague marketing copy, not a clear one-line explanation of what the screen is for.
- "Craft your narrative with Cap" sounds like landing-page copy, not an interface caption.

**Spaces empty state (EmptySharedCapState.tsx):**
```
Heading: "Start sharing videos to this Space" / "No shared Caps yet!"
Subtitle: verbose two-sentence explanation
Button: "Add videos to Space" (conditionally shown)
```
- Heading and subtitle are good; the subtitle is slightly long.

**Folder empty state (FolderVideosSection.tsx):**
```
"No videos in this folder yet. Drag and drop into the folder or..."
```
- Inline text only, no illustration, no button — no guidance.

**Storage/dev empty states:**
- "No videos yet." (StorageDetailsClient.tsx) — bare text, no guidance.

### GAP
- Main empty state has three competing CTAs — kills the "one clear action" rule.
- Subtitle is marketing copy, not UX guidance.
- Folder empty state has no illustration and no clear CTA.
- Several minor empty states have no action at all.

### Recommendations
- [CLARIFY] Rewrite main empty state subtitle to: "Record your screen, webcam, or both — then share a link instantly." (one line, explains the product, not marketing fluff). Effort: **S**
- [REMOVE] In EmptyCapState, remove "Download Cap" button and the two "or" text nodes from the empty state. Keep a single blue "Record in Browser" as the primary CTA. If desktop download matters, tuck a small text link below: "Or download the desktop app →". Effort: **S**
- [ADD-SMALL] Add a simple CTA button to the folder empty state: "Add a recording" that opens the recorder or the import dialog. Effort: **S**

---

## 4. Video Cards

### What Loom does well
- Card shows: thumbnail + duration badge (bottom-left of thumbnail) + author avatar + "Name · time-ago" + share-status pill ("Not shared ▾" clickable) + title + engagement counts (views / comments / emoji).
- Duration badge is persistent, always visible — you know how long the video is without opening it.
- Share-status pill is a clear signal — green = shared, gray = not shared.

### What our app does (source: `CapCardContent.tsx`, `CapCardAnalytics.tsx`)
- Card shows: thumbnail + title (editable inline) + share status text ("Not shared" / "Shared" with a tiny chevron) + relative date (editable inline by owner) + analytics row (eye icon count / comment count / reaction count) + "View analytics" link.
- Duration badge: not found in the card components — duration is NOT shown on the card thumbnail.
- Share status is a plain text line, not a styled pill.
- Analytics row is duplicated: the same three stats appear on both the card AND the share/watch sidebar.

### GAP
- No duration badge on the thumbnail — the single most useful glanceable piece of info for a video library is missing.
- Share-status is plain text, not a visually distinct pill/chip that looks clickable.
- "View analytics" link at the bottom of every card adds visual noise; it is repeated on the analytics page.

### Recommendations
- [ADD-SMALL] Add a duration badge to the video thumbnail (bottom-left, small pill, `bg-black/60 text-white text-xs`). The video duration data is already available in `cap.metadata`. Effort: **S**
- [CLARIFY] Style the "Not shared" / "Shared" text as a small pill (border, rounded-full, small padding) so it reads as a clickable chip, not bare text. The click handler `setIsSharingDialogOpen` already exists. Effort: **S**
- [REMOVE] Remove the "View analytics" link from the card bottom (CapCardAnalytics.tsx line 83–89). Analytics are one click away via the eye/comment/emoji stats which already link there. Effort: **S**

---

## 5. Recorder Dialog

### What Loom does well
- Recorder is invoked from a persistent sidebar CTA; it is always reachable.
- The recording surface is clean: mode selector, camera, mic — then ONE big record button.
- No "How it works" inside the recorder itself — onboarding is separate.

### What our app does (source: `web-recorder-dialog.tsx`, `RecordingModeSelector.tsx`)
- Dialog has: Settings gear (top-right) / mode selector dropdown / camera selector / mic selector / system audio toggle / recording button / "How it works" button at the bottom.
- "How it works" is inside the recorder dialog — adds cognitive load when you just want to record.
- Settings panel and How-It-Works panel are sub-panels inside the same 300px dialog, layered on top.
- When recording completes, a "Share link ready" green box + "Open Share Link" button appear inside the same dialog — useful, but jarring since the dialog stays open.

### GAP
- "How it works" inside the active recorder increases cognitive load at the moment of action.
- The dialog is 300px wide with 5–7 controls stacked — manageable, but each control adds decision cost.

### Recommendations
- [REMOVE] Remove "HowItWorksButton" from the recorder dialog. Move it to the dashboard's empty state or a tooltip on the record button. Effort: **S**
- [CLARIFY] After recording completes and the share link is ready, close the dialog automatically and show a toast notification "Share link copied to clipboard" rather than keeping the dialog open with a button inside. This removes the need for the "Share link ready" in-dialog section. Effort: **M** (needs to wire clipboard copy on complete)

---

## 6. Share / Watch Page

### What Loom does well
- Single-focus layout: video large on left, sidebar with activity on right.
- Header is minimal: title + share-status pill + author + relative date + copy-link button.
- Tabs for activity (comments, transcript, etc.) keep the sidebar uncluttered.

### What our app does (source: `ShareHeader.tsx`, `Sidebar.tsx`, `Share.tsx`)
- Header: "Back" pill + branding logo + title (editable) + share-status pill + author info + date + "Make shareable" / "Shared" pill + "Edit video" / "View analytics" / "Go to dashboard" buttons for owners.
- Sidebar (for owner/member): MeetingCostPanel card (gradient blue) + Comments card (white with drop shadow).
- MeetingCostPanel is shown to owner/member with a prominent gradient-blue glass card. This is operational info but visually very prominent.
- The "Go to dashboard" button in the share header — a third navigation option alongside "Back" and the logo — is redundant.
- Owner action buttons ("Edit video", "View analytics", "Go to dashboard") are clustered at top-right and can exceed the header height on mobile.

### GAP
- Three navigation paths out of the share page for owners: "Back" pill, logo link, "Go to dashboard" button — too many.
- The gradient glass MeetingCostPanel draws significant visual attention despite being secondary info (billing cost).
- For viewers (non-owners) the sidebar is clean; the clutter is owner-only.

### Recommendations
- [REMOVE] Remove "Go to dashboard" button from the share header — "Back" already handles that. Effort: **S**
- [CLARIFY] Reduce MeetingCostPanel visual prominence: remove the gradient/glassmorphism styling, use a plain bordered card instead (consistent with the Comments card below it). The info is valuable but should not be the most eye-catching element on the page. Effort: **S**

---

## 7. Settings

### What Loom does well
- Settings are reachable from a single "Personal settings" nav item.
- Organization settings are in a separate "Admin tools" group — clear role separation.

### What our app does (source: `SettingsNav.tsx`, `Settings.tsx`)
- Organization settings tabs: General / Preferences / Integrations / Members / Permissions / Activity — 6 tabs is reasonable and well-organized.
- Account settings: one page with profile, notification toggles, AI budget, API keys, dev mode card.
- The settings area has no obvious issues relative to Loom.
- "Dev Mode Card" (`DevModeCard.tsx`) is visible in account settings — likely internal, should be admin-gated.

### GAP
- Minimal gap vs. Loom. The settings tabs are clean.
- "LanguageSwitcher" appears in account settings — confirm it is needed (the owner decision is English-only UI); if unused, remove.

### Recommendations
- [REMOVE] Verify and remove "Dev Mode Card" if it is only for internal use (should be hidden behind `isAdmin` check). Effort: **S**
- [CLARIFY] If the LanguageSwitcher is not needed (English-only product), remove it from account settings to reduce noise. Effort: **S**

---

## 8. Top Navbar (Header Bar)

### What Loom does well
- One wide search bar centered, top-right: Upgrade pill + bell + avatar. Clean and spacious.

### What our app does (source: `Top.tsx`)
- Left: page title (e.g., "Instructional recordings").
- Center: DashboardSearch.
- Right: ReferButton (with pulsing red dot) + notification bell.
- The "Refer" button with a pulsing red dot sits between the search bar and the bell — it grabs attention on every page load.

### GAP
- The Refer button with the persistent animated red dot is distracting; it is marketing, not a workflow action.

### Recommendations
- [REMOVE] Remove the Refer button from the top navbar entirely (or move it to the avatar popover menu only, without the pulsing dot). For a self-hosted / data365 branded product this is irrelevant. Effort: **S**

---

## Top 5 Highest-Impact Minimal Changes

Ranked by visibility × frequency × effort-to-fix:

1. **[ADD-SMALL S] Add a persistent blue "New Recording" CTA button at the bottom of the sidebar** (above the user avatar). This is Loom's signature pattern. It makes the primary action always reachable without scanning the toolbar, and allows removing "Record a Cap" from the nav list entirely. Files: `Items.tsx`.

2. **[REMOVE S] Strip the three competing toolbar buttons down to one blue primary + two outline secondaries** ("New Recording" blue → "New Folder" outline → "Import Video" outline). Currently all three compete equally; demoting two of them with a single `variant` prop change makes the primary action obvious. File: `Caps.tsx`.

3. **[ADD-SMALL S] Add a duration badge to every video card thumbnail**. The single most useful glanceable piece of info in a video library — visible without opening the video. The data exists in `cap.metadata`. File: `CapCard` thumbnail section.

4. **[CLARIFY S] Rewrite the main empty-state subtitle and reduce its CTAs to one**. Current: three equal CTAs + marketing copy subtitle. Fix: one blue "New Recording" button + a one-line product-explaining subtitle. File: `EmptyCapState.tsx`.

5. **[REMOVE S] Remove "Record a Cap", "Import Video", and "Earn 40% Referral" from the sidebar nav list, and remove the Refer button + pulsing dot from the top navbar**. Four items that are either duplicate actions (record, import) or irrelevant marketing (referral) for a self-hosted product. Removing them makes the sidebar read as clearly as Loom's. Files: `Items.tsx`, `Top.tsx`.

---

*All recommendations are surgical: each is a prop change, a JSX removal, or a class name edit — no new screens, no new features.*
