# Handoff: data365 Web App — Design Polish & Consistency Pass

## Overview

data365 is a self-hosted meeting-recording platform (a customized Cap fork, repo: `ustoz-github`, app: `apps/web`, Next.js + Tailwind + Radix colors). It records meetings, generates AI analysis (summary, chapters, tasks, transcript), and shares videos with clients via public `/s/[videoId]` links.

This handoff implements a **17-item design audit** that fixes inconsistencies and unprofessional leftovers while **keeping the existing visual language** (Radix gray scale, white cards, left sidebar + rounded content panel, Neue Montreal font). This is NOT a redesign from scratch — it is a polish/consistency pass.

## About the Design Files

The bundled `data365 Redesign.dc.html` (+ `support.js`) is a **design reference created in HTML** — a prototype showing intended look, not production code. Recreate the designs in the existing Next.js codebase using its established patterns (Tailwind classes, Radix color tokens, `@cap/ui` components, next-intl). Open the HTML file in a browser and look at sections **4A** (full audit + Login + Empty state) and **3A** (improved Dashboard, Share page, dark mode, mobile).

## Fidelity

**High-fidelity for layout/spacing/hierarchy; token-based for colors.** Match the structure and sizes closely, but always express colors through the existing Radix/CSS-variable token system rather than hardcoding hex values (that hardcoding is exactly what this pass removes).

## UI Language

All user-facing copy must be **Uzbek**, added through the existing next-intl message files (do not hardcode strings in components). Exact strings are listed per task below.

---

## Tasks (mapped to audit items; file paths relative to `apps/web/`)

### A. Brand & Color

**A1 — Single accent blue (audit 01).**
Currently four "primary" blues coexist: `--primary: #005cb1` and `--secondary: #2eb4ff` in `app/globals.css`; Radix `blue-9/blue-11` in components; and `--accent: #2563eb` declared locally in `app/s/[videoId]/_components/ai-chat.css`.
- In `app/globals.css` define one semantic token: `--accent: #005cb1` (light) and in `.dark { --accent: #2e9dff; }`.
- Point `--primary` and `--secondary` at `var(--accent)` (or replace usages), and replace the local `--accent` block in `ai-chat.css` with the global token.
- Audit component usages of `var(--blue-9)` / `text-blue-*` used as "brand accent" and switch them to the semantic token. Radix blues may remain for purely informational elements.

**A2 — AI components must inherit the app font (audit 02).**
- `ai-chat.css` line ~13: `.ai-fab, .ai-aura, .ai-popup { font-family: -apple-system, ... }` → `font-family: inherit;`.
- `_components/BelowVideoTabs.tsx`: remove the inline `fontFamily: "-apple-system, ..."` on the tablist.
The whole app uses Neue Montreal (loaded in `app/layout.tsx` via `next/font/local`); AI surfaces must match.

**A3 — Remove old-brand leftovers (audit 03).**
- `app/layout.tsx`: `metadataBase` fallback is `https://cap.so`; `openGraph.url` is a `railway.app` URL. Replace both with the data365 production domain (env-driven), and localize `description`.

### B. Navigation & IA

**B1 — Separate destinations from actions in the sidebar (audit 04).** File: `app/(org)/dashboard/_components/Navbar/Items.tsx`.
- Remove "New recording" and "Install extension" from the nav list.
- Add a full-width **primary record button** at the top of the sidebar (below the logo row): accent background, white text, 8–10px radius, content centered: a 9px filled circle + label `Yangi yozuv`. It opens the existing WebRecorderDialog / record route.
- Nav groups (labels are 10.5px uppercase mono-ish, muted):
  - `Asosiy`: `Yozuvlar` (caps, with count badge right-aligned), `Uchrashuvlar` (meetings, with count), `Ulashilgan` (shared/spaces), `Tahlil` (analytics)
  - `Boshqarish`: `Kengaytma` (extension), `Sozlamalar` (settings)
- Keep the existing StorageIndicator, styled as a small bordered box pinned above the user footer: row `Xotira` / `4.2 / 10 GB` (11px, muted, mono feel) + 4px progress bar in accent color.

**B2 — Unified naming via i18n (audit 05).** Update next-intl message files: nav.instructions → `Yozuvlar`, meetings → `Uchrashuvlar`, shared → `Ulashilgan`, analytics → `Tahlil`, settings → `Sozlamalar`, extension → `Kengaytma`, newRecording → `Yangi yozuv`. Remove remaining "Instructions"/"Caps" strings from UI copy.

**B3 — Compact top bar (audit 06).** File: `_components/Navbar/Top.tsx`.
- Reduce to ~52px total height (`py-2.5`): page title 16px semibold + item count in 11.5px muted (e.g. `Yozuvlar` + `24 ta`), search field right-aligned (not centered, ~200–260px wide, pill), then notification bell (34px circle, bordered) and avatar.
- Remove `text-2xl` title and the large `lg:py-[19px]` padding.

**B4 — Meetings page title consistency (audit 07).** Files: `Top.tsx`, `dashboard/meetings/Meetings.tsx`.
- Add `"/dashboard/meetings": "Uchrashuvlar"` to the titles map (via i18n).
- Remove the in-page `<h1>Meeting Recordings</h1>` from `Meetings.tsx`.

**B5 — Mobile tab bar (audit 08).** File: `_components/MobileTab.tsx`.
- Replace the 3 icon-only tabs with 4 labeled tabs (icon 22px + 10px label, active = accent): `Yozuvlar` (/dashboard/caps), `Uchrashuvlar` (/dashboard/meetings), `Tahlil` (/dashboard/analytics), `Profil` (settings/account).
- Move the organization switcher out of the tab bar into the Profil screen/sheet.
- Keep 44px+ hit targets and safe-area padding.

### C. Library (Caps & Meetings)

**C1 — Quiet cards (audit 09).** Files: `dashboard/caps/components/CapCard/*`.
- Card = thumbnail (16/10, duration pill bottom-right, 11px mono on dark scrim) + body (title 14.5px/600, then ONE meta line 12px muted: `{owner} · {views} ko'rish · {relative date}`).
- Remove the always-visible analytics row and the row of quick-action icon buttons. All actions (copy link, share, download, settings, password, trim, analytics, delete) move into ONE `⋯` button (26px, top-right of the thumbnail, surface bg + border) opening the existing DropdownMenu.
- Keep multi-select behavior (checkbox appears on hover / when selection active).

**C2 — Date grouping (audit 10).** Files: `dashboard/caps/Caps.tsx`, `dashboard/meetings/Meetings.tsx`.
- Group cards under headers `Bugun`, `Shu hafta`, `Oldinroq` (11px uppercase, letter-spacing .1em, muted, mono). Group client-side from `createdAt`.
- Keep pagination but prefer larger pages (e.g. 30) so grouping is meaningful.
- Optional filter chips row above the grid (`Hammasi` + folder names) as shown in 3A.

**C3 — Localized, task-focused empty states (audit 11).** Files: `EmptyCapState.tsx`, `Meetings.tsx` empty block.
- Layout: centered; 64px rounded (18px) accent-wash square with play glyph; title 18px/700; subtitle 13.5px muted, max-w ~400px; buttons row.
- Copy (caps): title `Birinchi yozuvni yarating`; subtitle `Uchrashuvni yozing yoki tayyor videoni yuklang — xulosa, bo'limlar va vazifalarni AI avtomatik tayyorlaydi.`; primary `Yangi yozuv`, secondary `Video yuklash`.
- Copy (meetings): title `Hozircha uchrashuv yozuvlari yo'q`; subtitle `Chrome kengaytmasi orqali Google Meet uchrashuvini yozing — tahlil avtomatik keladi.`; primary `Kengaytmani o'rnatish`.

### D. Share page (`app/s/[videoId]`) & AI

**D1 — Unify AI into one right panel (audit 12).** Files: `Share.tsx`, `_components/Sidebar.tsx`, `BelowVideoTabs.tsx`, `AIFab.tsx`, `AIChatPopup.tsx`.
- Right panel (lg:w-80/96, bordered card, self-start, sticky) with tabs: `Xulosa` | `Transkript` | `Izohlar` (13.5px, active = accent text + 2px accent bottom border).
  - Xulosa tab: AI badge (`data365 AI` pill in accent-wash), summary paragraph (13.5px/1.65), then `Vazifalar · N` list (bordered rows: 16px checkbox square, task text 12.5px/500, assignee/due chip in accent-wash).
  - Transkript tab: existing TranscriptPanel (single instance — see D3).
  - Izohlar tab: existing Comments/Activity.
- **Persistent AI input pinned to the panel bottom** (all tabs): input pill `AI ga savol bering…` + 36px accent send button. Submitting opens/streams into the AI chat view (reuse AIChatPopup logic inline in the panel rather than a floating popup).
- Remove the floating `AIFab` orb (and its scroll-hide logic / `z-index: 2147483002`).
- Below the video keep: title, meta row, action buttons (`Yuklab olish`, primary `Havolani nusxalash`), and chapters as a wrapping row of chips (chip: bordered pill, 12px, mono accent timestamp + name; click = seek).

**D2 — Default tab = summary (audit 13).** `BelowVideoTabs.tsx` (or the new panel): initial tab must be `summary`, not `transcript`.

**D3 — One transcript instance (audit 14).** Remove the `hideTranscriptTab` xl-breakpoint duplication hack; transcript lives only in the right panel tab.

**D4 — Tabs through the design system (audit 15).** Rebuild the tab bar with Tailwind classes / a shared Tabs component; no inline `style` objects, no JS `onMouseEnter` hover — use `hover:` classes.

### E. Auth & modes

**E1 — Login polish (audit 16).** File: `app/(org)/login/form.tsx`.
- Email placeholder `tim@apple.com` → `siz@kompaniya.uz`.
- Card: white surface (`bg-gray-1`/white) with `border-gray-4`, radius 16px, padding ~36px; brand mark 44px; title `data365 ga kirish` (20px/700); subtitle `Jamoa yozuvlari va AI tahlillar uchun hisobingizga kiring` (13.5px muted); inputs full-width, 11px/14px padding, radius 10px; primary full-width `Kirish`; link `Parolni unutdingizmi?` (12.5px, accent).

**E2 — Dark mode via tokens (audit 17).** `app/globals.css`.
- Replace the hand-patched `--text-primary` fix with proper semantic tokens that flip under `.dark`.
- Soften `::selection`: use accent-wash background with default text color instead of the pure black/white inversion, in both modes.

---

## Design Tokens

Colors (semantic; light / dark):
- accent: `#005cb1` / `#2e9dff`; accent-fg: `#fff`; accent-wash: `#e0edff` / `rgba(46,157,255,.15)`
- bg (content panel): `#f7f7f7` / `#141416`; surface (cards/sidebar): `#fff` / `#1c1c1f`; surface-2: `#fbfbfb` / `#18181b`
- text: `#202020` / `#ededef`; muted: `#6b6b6b` / `#909096`; border: `#e8e8e8` / `#2b2b30`
- danger dot: `#e5484d`
(Map these onto the existing Radix scale — gray-1/2/4/11/12 — rather than introducing raw hex where a Radix token already matches.)

Type (Neue Montreal): page title 16/600 (top bar), section headers 11/600 uppercase ls .1em, card title 14.5/600, meta 12 muted, body 13.5/1.55–1.65, empty-state title 18/700. Timestamps/counters: monospace fallback (`ui-monospace`) 11–12px.

Spacing & shape: card radius 12px, buttons/inputs 10px, chips/pills 999px; card body padding 12–15px; content padding 20–28px; grid gap 22px; top bar height ~52px; sidebar 220–240px.

## Interactions & Behavior

- Card `⋯` menu: opens existing DropdownMenu; card hover = subtle border-color shift (gray-4→gray-6), no lift.
- Chapter chip click → seek video (existing `handleSeek`).
- AI input: Enter submits; response streams in panel; keep existing timestamp-link behavior from `ai-chat-timestamps.ts`.
- Tabs: URL `?tab=` sync as today, default `summary`.
- Sidebar record button: same handlers as current "New recording" item.
- Preserve all existing keyboard shortcuts (multi-select, `c` for comment).

## State Management

No new state systems. Reuse existing React Query / Effect RPC. Date grouping is a pure client-side derivation. Removing AIFab means the AI panel open/close state moves into the share-page right panel (a `tab`-like local state).

## Assets

No new assets. Reuse existing LogoBadge, FontAwesome/Lucide icons, Rive empty-state animation (keep it, just replace the copy around it).

## Files in this bundle

- `data365 Redesign.dc.html` + `support.js` — open in a browser. Section **4A** = full audit + improved Login + Empty state. Section **3A** = improved library (light/dark), share page with unified AI panel, mobile screens. (Sections 1A–2B are earlier explorations — ignore.)

## Suggested implementation order

1. A1–A3 (tokens/font/meta — low risk, high consistency win)
2. B1–B5 (nav/topbar/mobile)
3. C1–C3 (library)
4. D1–D4 (share page — biggest chunk, do last, test client links)
5. E1–E2
Test both themes and mobile after each phase; run the existing QA flows (`QA_FLOWS.md`).
