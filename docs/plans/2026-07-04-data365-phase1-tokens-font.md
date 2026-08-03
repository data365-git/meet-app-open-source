# data365 redesign — PHASE 1 spec: tokens + font + infra

Source of truth: `apps/web/scratchpad/data365-design/.../README.md` (§Global rules, §Design tokens, §5.6).
This phase = README §8.1 "Tokens + font + infra — one commit, app-wide."
Owner decisions (2026-07-04): full phased redesign; new design wins visuals; AI/cost items are a separate track.

## Goal
Lay the design foundation — ONE accent, ONE font (Geist), a documented semantic-token MAPPING,
and infra cleanup — app-wide, in one reviewable commit, WITHOUT breaking the existing
shadcn (HSL `@layer base`) and Radix-colors token systems already in `globals.css`.

## ⚠️ Critical reconciliation (why we deviate from the README's literal tokens)
The README proposes flat tokens `--accent`, `--border`, `--muted`, `--secondary`, etc.
`apps/web/app/globals.css` ALREADY has:
- A working brand token: `--brand` = `#005cb1` (light) / `#2e9dff` (dark), plus `--brand-wash`, `--brand-fg`
  — these already equal the README's `--accent*` values.
- A legacy `:root` block with `--primary: var(--brand)`, `--secondary: var(--brand)`, plus extra shades
  `--primary-2/3`, `--secondary-2/3`, `--tertiary*`, `--filler*`.
- A shadcn `@layer base` block redefining `--primary`, `--secondary`, `--muted`, `--accent`, `--border`,
  `--input`, `--ring`, … as HSL triplets used by shadcn/@cap/ui utilities (`bg-accent`, `border-border`, …).

Therefore introducing README's `--accent`/`--border`/`--muted` as NEW meanings would COLLIDE with shadcn
and break components. **Rule: do NOT create `--accent` or `--border`. Map README roles onto the tokens that
already exist** (`--brand*` + Radix `gray/red/green/amber` scales). Mapping table below is binding for ALL
later phases too.

### Binding token map (use these in every component, all phases)
| README role | USE in code | Never use |
|---|---|---|
| accent / brand | `--brand` (class `bg-brand`,`text-brand` if defined; else `var(--brand)`) | new `--accent`, raw `#005cb1`, `blue-9` |
| accent wash | `--brand-wash` | new `--accent-wash` |
| accent fg (on accent) | `--brand-fg` | |
| page bg | Radix `gray-1`/app `--bg` if added | raw `#f7f7f7` |
| surface / card | `gray-1` (light #fff) | raw `#fff` in components |
| surface-2 | `gray-2` | |
| text | `gray-12` | raw `#202020` |
| muted text | `gray-11` | shadcn `--muted` (that's a bg), raw `#6b6b6b` |
| border | `gray-4` (rest) / `gray-6` (hover) | new `--border`, raw `#e8e8e8` |
| error | Radix `red-9` | raw `#e5484d` |
| error wash | Radix `red-3` | |
| success | Radix `green-9` | |
| warning | Radix `amber-9` | |
Rationale: matches the app's existing Radix convention; zero collision; values already ~match README hexes.

---

## Task A — Font swap to Geist (SAFE, self-contained)
Files: `apps/web/app/layout.tsx`, the AI-chat css (path from map §E), `apps/web/package.json`.

Steps:
1. Add dependency: `geist` (pnpm, filter @cap/web). Confirm it installs offline/registry-OK before proceeding.
2. `layout.tsx`: remove the 6-weight `localFont` NeueMontreal block; instead
   `import { GeistSans } from "geist/font/sans";` and set `<html className={GeistSans.className …}>`.
   (Mono per README = `ui-monospace` stack via Tailwind `font-mono`; do NOT need GeistMono.)
3. Remove the now-unused `localFont` import if nothing else uses it.
4. AI-chat css: replace the `-apple-system…` `font-family` with `font-family: inherit;`.
5. Do NOT delete the NeueMontreal `.otf` files in this commit (surgical; note as later cleanup).

Verify:
- `grep -ri "NeueMontreal\|localFont" apps/web/app` → 0 (except the retained public/fonts assets).
- Run app; computed `font-family` on `body` and on an AI-chat bubble both resolve to Geist.
- `tsc` 0, `next build` success.

## Task B — Consolidate accent (collision-safe)
File: `apps/web/app/globals.css` + the ai-chat css.
1. Keep `--brand`, `--brand-wash`, `--brand-fg` exactly as-is (light + `.dark`).
2. In ai-chat css: delete the local `--accent: #2563eb` (README §Global rule 3); repoint its usages to `--brand`.
3. Leave the shadcn `@layer base` block UNTOUCHED (it's a separate, working system).
4. Do NOT rename shadcn `--accent`/`--border`.

Verify: `grep -r "#2563eb\|--accent: *#" apps/web` → 0 in components/css we own.

## Task C — Remove legacy competing shades  (FINALIZED — rule-based)
**KEEP** `--primary` and `--secondary` (they are `var(--brand)` aliases — harmless, and widely referenced
via `text-primary`/`bg-primary`/`bg-secondary`). Do NOT delete these.
**REMOVE** only the numbered extra shades + their helper classes from `globals.css`:
`--primary-2`, `--primary-3`, `--secondary-2`, `--secondary-3`, `--tertiary`, `--tertiary-2`, `--tertiary-3`,
and classes `.bg-gradient`, `.bg-dark`, `.bg-animated`, `.muted-custom-bg`, `.muted-custom-bg-2`.
Execution (Sonnet does the sweep as STEP 1, before editing):
1. `grep -rn` each removed token/class across `apps/web` + `packages/ui`; record every usage with file:line.
2. Remap each usage per the binding table: gradients / `--secondary-2/3` → solid `--brand`;
   `--tertiary*` washes → `--brand-wash` (or Radix `gray-2`); `.bg-dark` → `bg-[var(--brand)]`.
3. THEN delete the token defs + helper classes from globals.css.
4. Do NOT touch the shadcn `@layer base` block (`--accent`/`--border`/`--muted`/`--primary` HSL) — separate system.
⚠️ SAFETY VALVE: if any removed token has >15 usages or an ambiguous remap, do NOT delete it — instead alias it
to `var(--brand)` in `:root` and leave usages, and LIST it in the report. Prefer no-breakage over purity.
Report the full usage sweep + what was remapped vs aliased.

## Task D — Infra (README §5.6)
File: `apps/web/app/layout.tsx`, `Navbar/Items.tsx`.
1. `metadataBase`/`openGraph.url`: already env-driven with a railway fallback — replace the hard fallback
   `https://capweb-production-dd85.up.railway.app` with a data365 env var default (no behavior change if env set).
2. `Navbar/Items.tsx`: `DEVELOPER_DASHBOARD_ALLOWED_EMAILS=["richie@cap.so"]` → env-driven list.
3. `::selection` already uses `--brand-wash` + `inherit` — leave as-is (README §5.6 satisfied).

## Global success criteria (gate before commit)
- `pnpm --filter @cap/web exec tsc --noEmit` → 0 errors.
- `pnpm --filter @cap/web run test` → no NEW failures (known flake: developer-credits-checkout).
- Local `pnpm --filter @cap/web exec next build` → SUCCESS. (STATE lesson: `"use server"`/build-only
  breakages escape tsc+vitest — a real build is mandatory before any push.)
- Manual: home + dashboard + one share page render in BOTH light and dark with no missing-token / unstyled
  flashes; Geist visibly applied; no raw competing-blue left (`grep` clean).

## Out of scope (later phases)
Sidebar/shell (§1), library cards (§2), watch page (§3), system states (§4), auth/analytics/extension (§5).
AI/cost track (Arzon/Tez chooser, STT A/B, context-speaker) — separate, not here.

## Delegation
- Task A, B, D: well-specified → Sonnet (newest gen). Single committer.
- Task C: finalize spec (Opus) after map → then Sonnet executes the remap.
- Review: Jarvis reads the full diff + runs the gate; FRESH-Opus adversarial review before any deploy.
- No deploy without owner approval + confirming no live AI/transcribe job is running.
