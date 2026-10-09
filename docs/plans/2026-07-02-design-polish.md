# Design Polish & Consistency Pass — Implementation Plan

> **For agentic workers:** Execute one phase per agent, in order. The visual reference is `docs/design-handoff-2026-07/data365 Redesign.dc.html` (open in a browser; sections **4A** = audit + Login + Empty state, **3A** = library/share/dark/mobile; ignore 1A–2B). The handoff README (`docs/design-handoff-2026-07/README.md`) holds the full audit rationale. THIS plan supersedes the README where they disagree — this plan was verified against the live codebase on 2026-07-02.

**Goal:** Implement the 17-item design audit (single brand accent, unified naming/nav, quiet cards, unified share-page AI panel, login/dark polish) while keeping the existing visual language and ALL recently-shipped behaviors.

**Architecture:** Pure UI/polish pass — no new state systems, no API changes. Semantic `--brand` token layered onto the existing Radix scale; component restructures reuse existing handlers/components (WebRecorderDialog, DropdownMenu, TranscriptPanel, AIChatPopup logic).

**Tech Stack:** Next.js (`apps/web`), Tailwind + Radix colors, next-intl (`messages/{en,ru,uz}.json`), Neue Montreal via next/font/local.

## Global Constraints

- Repo `D:\vibecoding\ustoz-github`, branch `qa-fixes`. **push = auto-deploy → NEVER push**; the main session pushes once at the very end (combined with the pipeline-hardening stream).
- **One committing agent at a time** on this repo (coordinated by the main session). Verify every commit with `git show --stat HEAD` right after committing.
- Gate per phase: ROOT `pnpm tsc -b` exit 0 + `pnpm --filter @cap/web run test` no new failures. Windows PATH: `$env:Path="C:\Program Files\nodejs;"+$env:Path`.
- All user-facing copy through next-intl (`messages/en.json`, `ru.json`, `uz.json` — ALL THREE), never hardcoded. Uzbek strings below are exact; write natural en/ru equivalents.
- Colors ONLY via tokens (new `--brand*` or existing Radix `--gray-*`/`--blue-*` vars) — no new raw hex in components.
- **PROTECTED (do not break, do not remove):** `LanguagePicker` (⋮ menu over the share video), `LocaleSwitcher` (dashboard Top bar, line ~109 of Top.tsx), `SettingsSectionNav` (consolidated Settings), multi-select on caps, all keyboard shortcuts, WebRecorderDialog handlers, anon-vs-owner gating on the share page.
- ⚠️ `app/globals.css` ALREADY has a Tailwind-layer `--accent` (HSL, lines ~941/968) used by shadcn-style components. **Do NOT touch it.** The new semantic token is named `--brand`.
- Do not touch `apps/web/workflows/*` or `apps/web/lib/{gemini-transcribe,restore-russian-script,translate-ai,audio-extract,concurrency}.ts` — a parallel hardening stream owns those files.
- No UTF-8 BOM. Match existing code style. Surgical diffs.

## Executor routing (set by the main session)

| Phase | Executor |
|---|---|
| A (tokens/font/meta/dark) | Codex |
| B (nav/topbar/mobile) | Codex |
| C (library cards/grouping/empty) + E1 (login) | Sonnet |
| D (share page) | Opus |
| Final review | Codex `review` + main session |

---

## Phase A — Brand token, fonts, metadata, dark/selection (audit 01, 02, 03, 17)

**Files:** `apps/web/app/globals.css`, `apps/web/app/s/[videoId]/_components/ai-chat.css`, `apps/web/app/s/[videoId]/_components/BelowVideoTabs.tsx`, `apps/web/app/layout.tsx`, plus a conservative brand-blue sweep in components.

1. **globals.css** — in `:root` next to `--primary` (line ~18):
   ```css
   --brand: #005cb1;
   --brand-fg: #ffffff;
   --brand-wash: #e0edff;
   ```
   and in the `.dark` block:
   ```css
   --brand: #2e9dff;
   --brand-wash: rgba(46, 157, 255, 0.15);
   ```
   Then point `--primary: var(--brand);` and `--secondary: var(--brand);` (the four-blues problem: #005cb1, #2eb4ff, blue-9, local #2563eb → ONE source).
2. **globals.css `::selection`** (lines ~141-149): both modes → `background: var(--brand-wash); color: inherit;` (kill the pure black/white inversion).
3. **globals.css dark text fix** (lines ~55-57): keep `--text-primary: var(--gray-12)` under `.dark` but move it into the main `.dark` token block with a comment marking it as the semantic text token (no behavior change — this is consolidation, not removal).
4. **ai-chat.css** (lines ~4-15): replace `--accent: #2563eb;` with `--accent: var(--brand);` (keeps all internal `var(--accent)` usages working) and replace the `font-family: -apple-system, ...` line with `font-family: inherit;`.
5. **BelowVideoTabs.tsx** (line ~87-88): delete the inline `fontFamily` style on the tablist.
6. **layout.tsx**: line ~45 `metadataBase` fallback `https://cap.so` → `https://capweb-production-dd85.up.railway.app` (keep the env-first chain); line ~52 `openGraph.url` hardcoded `cap-web-production-3166.up.railway.app` → `process.env.NEXT_PUBLIC_WEB_URL ?? "https://capweb-production-dd85.up.railway.app"`; line ~47 description → `"data365 — uchrashuv yozuvlari va AI tahlil platformasi"`.
7. **Brand sweep (conservative):** grep components for `var(--blue-9)`, `var(--blue-10)`, `text-blue-9`, `bg-blue-9` etc. used as BRAND/CTA accent (primary buttons, active states, links-as-actions) → switch to `var(--brand)` / arbitrary-value Tailwind (`text-[var(--brand)]`, `bg-[var(--brand)]`). Leave informational blues (charts, info badges) alone. When in doubt, leave it.

**Verify:** `pnpm tsc -b` = 0 · full unit suite no new failures · `grep -r "#2563eb" apps/web/app` = 0 hits · report the sweep's changed-file list.
**Commit:** `design: single brand accent token, inherited fonts, data365 metadata (audit 01-03,17)`

## Phase B — Sidebar, top bar, mobile tabs (audit 04-08)

**Files:** `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx` (nav list at lines ~88-145), `Navbar/Top.tsx`, `_components/MobileTab.tsx`, `messages/{en,ru,uz}.json`.

1. **Items.tsx (B1):** remove `newRecording` and `installExtension` from the nav LIST. Add at the top of the sidebar (below the logo row) a full-width primary record button: `bg-[var(--brand)] text-[var(--brand-fg)]`, radius 10px, centered content = 9px filled circle (`<span class="size-[9px] rounded-full bg-current/  ">` styled white) + `t("newRecording")`; onClick = the SAME handler the removed "New recording" item used (WebRecorderDialog / record route — reuse, don't reinvent). Group the remaining items with muted 10.5px uppercase group labels: `Asosiy` → Yozuvlar (caps, keep count badge if present), Uchrashuvlar, Tahlil; `Boshqarish` → Kengaytma (the old installExtension destination), Sozlamalar, (admin-only Developers stays here). Keep StorageIndicator, restyled as a small bordered box pinned above the user footer: row `Xotira` / `X / Y GB` (11px muted `font-mono`-feel) + 4px progress bar `bg-[var(--brand)]`. Group-label i18n keys: `navGroupMain` = uz `Asosiy`, `navGroupManage` = uz `Boshqarish`.
2. **i18n (B2):** uz values → instructions: `Yozuvlar`, meetingRecordings: `Uchrashuvlar`, analytics: `Tahlil`, settings: `Sozlamalar`, installExtension: `Kengaytma`, newRecording: `Yangi yozuv`, storage: `Xotira`. Mirror sensible en/ru. Sweep any remaining user-visible "Instructions"/"Caps" strings in nav/titles to the new terms.
3. **Top.tsx (B3):** height → ~52px (`py-2.5`, drop `lg:py-[19px]` at line ~85); title `text-base font-semibold` (drop `lg:text-2xl` at line ~100) + item count `11.5px` muted next to it where a count is available (caps/meetings pages — pass-through prop; if plumbing a count is invasive, ship title-only and note it); search field right-aligned pill ~200-260px (not flex-1 centered); notification bell = 34px bordered circle. **Do not move/remove LocaleSwitcher (line ~109).**
4. **Titles (B4):** ensure the Top.tsx title map covers `/dashboard/meetings` → i18n `Uchrashuvlar`, `/dashboard/caps` → `Yozuvlar`, `/dashboard/analytics` → `Tahlil`. (Verified: Meetings.tsx has NO in-page h1 — the README's removal item is stale, skip it.)
5. **MobileTab.tsx (B5):** 3 icon-only tabs → 4 labeled tabs (icon 22px + 10px label, active = `text-[var(--brand)]`): `Yozuvlar` /dashboard/caps · `Uchrashuvlar` /dashboard/meetings · `Tahlil` /dashboard/analytics · `Profil` /dashboard/settings/account. Move the OrgsMenu trigger out of the tab bar (into the settings/Profil screen top or an existing header slot). Keep ≥44px hit targets + safe-area padding.

**Verify:** tsc 0 · unit suite · `pnpm --filter @cap/web exec vitest run __tests__` no new failures · manually list which routes each tab/nav item points to in the report.
**Commit:** `design: sidebar record button + grouped nav, compact top bar, labeled mobile tabs (audit 04-08)`

## Phase C — Library cards, grouping, empty states (audit 09-11) + E1 login (audit 16)

**Files:** `apps/web/app/(org)/dashboard/caps/components/CapCard/{CapCard,CapCardAnalytics,CapCardContent}.tsx`, `caps/Caps.tsx`, `dashboard/meetings/Meetings.tsx`, `caps/components/EmptyCapState.tsx`, `app/(org)/login/form.tsx`, `messages/{en,ru,uz}.json`.

1. **Quiet cards (C1):** card = thumbnail (16/10, duration pill bottom-right: 11px mono on dark scrim) + body: title `14.5px/600` then ONE meta line `12px` muted: `{owner} · {views} ko'rish · {relative date}`. REMOVE the always-visible `CapCardAnalytics` row and standalone quick-action buttons; ALL actions move into the existing ⋯ DropdownMenu, triggered by a 26px button top-right of the thumbnail (surface bg + border). Add an `Analitika` item to that menu (link to `/dashboard/analytics?capId=...`) so nothing is lost. Keep multi-select checkbox behavior exactly (hover / selection-active). Card hover = border `gray-4→gray-6`, no lift/shadow.
2. **Date grouping (C2):** in `Caps.tsx` (and Meetings.tsx if it uses the same grid) derive groups client-side from `createdAt`: `Bugun` / `Shu hafta` / `Oldinroq` — header style 11px uppercase, letter-spacing .1em, muted. Raise page size `limit = 15` → `30` (line ~87). i18n keys `groupToday`/`groupThisWeek`/`groupEarlier`. (Filter chips row = optional, SKIP unless trivial — FoldersDropdown already exists.)
3. **Empty states (C3):** `EmptyCapState.tsx` — keep the Rive animation, replace copy via i18n: title `Birinchi yozuvni yarating` (18px/700), subtitle `Uchrashuvni yozing yoki tayyor videoni yuklang — xulosa, bo'limlar va vazifalarni AI avtomatik tayyorlaydi.` (13.5px muted, max-w-[400px]), primary `Yangi yozuv`, secondary `Video yuklash` (reuse existing record/upload handlers). Meetings empty block: title `Hozircha uchrashuv yozuvlari yo'q`, subtitle `Chrome kengaytmasi orqali Google Meet uchrashuvini yozing — tahlil avtomatik keladi.`, primary `Kengaytmani o'rnatish`.
4. **Login (E1):** `form.tsx` line ~131 placeholder `tim@apple.com` → `siz@kompaniya.uz`. Card: white surface `bg-gray-1 border border-gray-4` radius 16px padding ~36px; brand mark 44px; title `data365 ga kirish` (20px/700); subtitle `Jamoa yozuvlari va AI tahlillar uchun hisobingizga kiring` (13.5px muted); inputs full-width radius 10px; primary full-width `Kirish` (`bg-[var(--brand)]`); keep the EXISTING mailto forgot-password link (lines ~183-190), restyled 12.5px `text-[var(--brand)]`, label `Parolni unutdingizmi?`. All via i18n.

**Verify:** tsc 0 · unit suite (CapCard/Caps tests if any) · report: which actions ended up in the ⋯ menu (must be a superset of what the removed buttons offered).
**Commit (two):** `design: quiet cap cards, date grouping, task-focused empty states (audit 09-11)` · `design: login polish (audit 16)`

## Phase D — Share page: unified AI right panel (audit 12-15) — HIGHEST RISK, LAST

**Files:** `apps/web/app/s/[videoId]/Share.tsx`, `_components/{Sidebar.tsx,BelowVideoTabs.tsx,AIFab.tsx,AIChatPopup.tsx,ShareVideo.tsx}` (+ ai-chat.css as needed), `messages/{en,ru,uz}.json`.

1. **Right panel (D1):** one bordered, self-start sticky card (`lg:w-80 xl:w-96`) with tabs `Xulosa` | `Transkript` | `Izohlar` (13.5px; active = `text-[var(--brand)]` + 2px bottom border). Xulosa = AI badge pill (`data365 AI`, brand-wash bg) + summary body + existing `Vazifalar · N` list. Transkript = the ONE TranscriptPanel instance. Izohlar = existing Activity/Comments (current Sidebar content). Pinned to the panel bottom on ALL tabs: AI input pill placeholder `AI ga savol bering…` + 36px brand send button; submitting streams the answer inline in the panel (reuse AIChatPopup's logic/hooks inline — keep its gating: guest sees the existing "tizimga kiring" CTA).
2. **Remove AIFab** (floating orb, z-index 2147483002, scroll-hide) — its entry point is replaced by the pinned input. Delete dead code your removal orphans; leave AIChatPopup logic that the inline panel reuses.
3. **Below the video:** title, meta row, actions (`Yuklab olish`, primary `Havolani nusxalash`), and chapters as wrapping chip row (bordered pill, 12px, mono brand timestamp + name; click = existing `handleSeek` → seek+PLAY). **The ⋮ LanguagePicker over the video stays exactly where it is.**
4. **Default tab (D2):** initial tab = `summary` (BelowVideoTabs.tsx line ~52 currently defaults to `transcript`), `?tab=` URL sync stays.
5. **One transcript (D3):** remove the `hideTranscriptTab` xl-duplication hack (prop at line ~20, `xl:!hidden` at ~116).
6. **Clean tabs (D4):** tab bar with Tailwind classes only — no inline style objects, no `onMouseEnter` hover JS (lines ~110-115); use `hover:` classes.

**REGRESSION CHECKLIST — every item must still work after D (these are live-verified behaviors from 2026-07-02; breaking one = the phase fails):**
1. Transcript cue/pill click → video seeks AND plays.
2. Chapter title click → seek+play; summary mundarija (TOC) items clickable.
3. Word-level karaoke highlight advances during playback (timeupdate wiring survives the panel move).
4. Refined tab: current chapter highlight + auto-follow scroll.
5. ⋮ LanguagePicker menu over the video: language switch still swaps analysis + captions; generate gated to owner/admin.
6. Task checkboxes: owner can toggle, persists after reload; read-only for non-editors.
7. Anonymous visitor: chat input replaced by "tizimga kiring" CTA; no generate/re-analyze controls.
8. AI answer timestamps clickable (ai-chat-timestamps.ts behavior) and answer streams.
9. Comments/reactions still postable from the Izohlar tab.
10. Light + dark + mobile (panel stacks below video on small screens), 0 console errors.

**Verify:** tsc 0 · unit suite · run the dev server and walk the checklist yourself with Playwright/preview on a real share link before committing; paste the checklist with pass/fail per item into the report.
**Commit:** `design: unified share-page AI panel, summary-first tabs, no floating orb (audit 12-15)`

---

## Final (main session)

1. Full gate: `pnpm tsc -b` + full vitest.
2. Codex independent review of the whole design diff (visual-regression risks, dead code, i18n key coverage in ALL three locales, protected-features intact).
3. Combined push with the pipeline-hardening stream (one deploy), then live QA: dashboard + share page, light/dark/mobile, the Phase D checklist on the LIVE build, `QA_FLOWS.md` smoke.
4. Update `docs/STATE.md`.
