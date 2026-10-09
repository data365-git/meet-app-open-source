# AI-Analysis Status UI — Design Plan (for Fable review)

**Goal:** the AI-analysis *status/processing* view on the share page must look **excellent** — calm, glance-clear, trustworthy — and show **each step clearly** (owner directive 2026-07-13). Code-only (no backend change); reuse the data the panel already receives.

**Component:** `apps/web/app/s/[videoId]/_components/GenerateAiPanel.tsx`, the `if (isRunning)` block (lines 238–448). Renders inside `SharePanel` — full-width on mobile, sticky right column ≥1280px.

**Constraints (facts):**
- Available data: `transcriptionStatus`, `aiGenerationStatus`, `aiProcessingStep` (unreliable during transcript), `aiMode` (fast/cheap), `aiQuotaWaiting`, `transcriptionChunksCompleted/Total`, `aiStageChunksCompleted/Total`, `processingStartedAt`, `aiProcessingStartedAt`, `duration`, `computeEtaMinutes(...)`.
- Real tracked stages = **3**: Transkript (chunk N/M) → Xulosa (summary, chunk N/M) → Aniqlashtirish (refined). Tasks/Chapters are NOT separately tracked → do NOT invent fake sub-steps.
- Design system: Radix gray scale (`gray-1..12`, `border`), brand tokens `--brand`, `--brand-wash`, `--brand-fg`. Tailwind. Must work **light + dark** and honor `prefers-reduced-motion`.
- Owner design law: glance-clear & calm · ONE accent as signal · one primary action · no AI-slop · plain 12-yr-old copy.

---

## What's mediocre now (Supermodel critique of the current block)
1. **No single focal point.** Header badge, ETA pill, mode card, stepper, fine-counter, status row, and a 6-bar skeleton all shout at once → busy, not calm. The user can't tell at a glance "what is happening right now."
2. **Progress is fake-feeling.** The active step is an indeterminate `animate-pulse` ring + shimmer bars. We HAVE `N/M` — but it's buried as a tiny text line, not a real progress indicator. "aniq ko'rsatilsin" is unmet: the user can't see *how far along* the current step is.
3. **Redundant status.** The header badge label, the stepper's current label, and the status row all restate the same thing three times.
4. **Mode card competes.** The Tez/Arzon card + "continue paid" button sit ABOVE the stepper with equal weight, pulling the eye away from progress.
5. **Skeleton is noise.** 6 pulsing bars imply "content loading here" but the content appears in the tabs, not this panel → decorative AI-slop.
6. **Stepper cramped on mobile.** 4 circles + labels in a 340px-wide sticky panel → tight, labels risk truncation.

---

## Proposed design (calm, one focal point, real progress)

**Layout = a single quiet card, vertical rhythm, one accent.** Top→bottom:

1. **Focal line (the ONE thing):** big, human, present-tense — *"Hozir: audio matnga o'girilmoqda"* (verb per stage). ~15–16px, `font-semibold`, `gray-12`. This replaces the triple-restated status. One spinner dot to its left. Nothing competes with this line.

2. **Determinate progress bar** directly under the focal line — the core of "aniq ko'rsatilsin":
   - When `N/M` known → a real filled bar `width = completed/total`, brand fill on `gray-3` track, smooth width transition. Caption right-aligned: `3/12`.
   - When total unknown (transcript starting) → a slim indeterminate shimmer (single, tasteful) — NOT the 6-bar skeleton.
   - ETA folded in as quiet caption: *"~2 daqiqa qoldi"* (`gray-10`), only when computable; never alarming.

3. **The 3-stage timeline** (Transkript → Xulosa → Aniqlashtirish) as a **compact horizontal stepper**, but restyled to be *quiet reference*, not the hero:
   - Done: small filled brand dot + `✓`, label `gray-11`.
   - Current: brand ring dot, **single** soft pulse (reduce-motion → static ring), label `gray-12 font-semibold`.
   - Pending: hollow `border` dot, label `gray-9`.
   - Connector line fills brand as stages complete.
   - Mobile: shorten labels (Transkript/Xulosa/Aniqlash) or stack dot-over-label; guarantee no truncation at 340px.

4. **Mode as a subtle footnote, not a card:** a single small chip — `Tez` or `Arzon` — right-aligned in the header, `gray-10`. The **"Pullikda davom et"** button appears ONLY in cheap+quota-waiting, as a quiet secondary button at the BOTTOM (one primary action, de-emphasized). Quota-waiting note = gentle **amber** text (not red).

5. **Error** = its own amber/red state (already exists), unchanged in scope.

6. **Kill the decorative skeleton** — the determinate bar + timeline already communicate "working." Removes the biggest slop source.

**Motion budget (anti-slop):** exactly TWO motions — (a) the active progress bar's width transition, (b) one soft pulse on the current stage dot. Everything else static. `prefers-reduced-motion` → no pulse, instant width. No spinners multiplying.

**Color budget:** brand accent = the ONLY color that means "active/progress." Gray = structure. Amber = waiting/quota. Red = error. Verified in light AND dark (Radix scale handles both; check `--brand-wash` contrast on dark).

**Hierarchy test:** squint → you see (1) the focal verb line + (2) the progress bar. Everything else recedes. That's the calm.

---

## Copy (uz, plain; en/ru mirror)
- Focal verbs by stage: Transkript → *"Audio matnga o'girilmoqda"* · Xulosa → *"Xulosa yozilmoqda"* · Aniqlashtirish → *"Matn aniqlashtirilmoqda"*.
- Progress caption: `{completed}/{total}` · ETA: *"~{minutes} daqiqa qoldi"*.
- Mode chip: *Tez* / *Arzon*. Quota-wait: *"Bepul navbat kutilmoqda — biroz sekinroq"*.
- Reuse existing i18n keys where present (`aiFineTranscribing`, `aiFineStageProgress`, `aiEta`, `aiModeCheapQuotaWaiting`); add focal-verb keys.

## Scope / non-goals
- Code-only in `GenerateAiPanel.tsx` (+ i18n uz/ru/en). No backend, no new tracked steps.
- Must not regress the `SharePanel` tab-lock reconciliation (#1) — this panel is the "processing" surface those tabs point to.
- Deliverable: the redesigned running-state block; gate tsc/vitest/build; live-verify at next Contabo redeploy.

## Open questions for the reviewer
1. Is the 3-stage horizontal timeline the right primitive, or is a **single big progress ring** (one circle, % + stage name inside) cleaner for glance-reading on mobile?
2. Determinate bar vs. a percentage number vs. both — which reads as "excellent" without feeling like a file-download?
3. Anything here that still reads as AI-slop / generic-dashboard?

---

## ✅ FINAL DIRECTION (Fable-approved 2026-07-13 — supersedes the horizontal-stepper layout above)

Fable approved the **philosophy** (kill skeleton · determinate bar · demote mode · strict motion/color budgets) but **replaced the layout**: NOT a horizontal stepper, NOT a ring. Build exactly this.

**Primitive = a VERTICAL 3-row stage list; the active row IS the focal line and holds the bar.** Width-agnostic (identical at 340px and full-width — zero mobile truncation). Reads top→bottom like the pipeline runs. Merges "focal line" + "timeline" into one element (no double-restate).

```
┌ card: rounded-xl border-border bg-gray-2, p-4 ────────┐
│ AI tahlil                                    [Tez]     │  header: 12px gray-11 medium · mode chip gray-10 border-full. NO pill/wash/spinner.
│                                                        │
│ ●(filled brand + check-icon) Transkript                │  DONE row: 16px filled --brand dot, --brand-fg check ICON (not "✓" text); label 13px gray-11
│                                                        │
│ ◉(brand ring + 6px center) Xulosa yozilmoqda           │  ACTIVE row = focal: verb phrase 15px font-semibold gray-12 (largest on card)
│    ▓▓▓▓▓▓▓▓░░░░░░░░  h-1 bar (track gray-5, fill brand) │    bar indented to label (26px). motion-safe:transition-[width] duration-700
│    3/12                      ~2 daqiqa qoldi           │    caption: left N/M · right ETA-words. both 12px gray-10 tabular-nums
│                                                        │
│ ○(hollow border-2) Aniqlashtirish                      │  PENDING row: hollow border dot; label 13px gray-9
│                                                        │
│ Bepul navbat kutilmoqda — biroz sekinroq    (amber-11) │  cheap+quota only, 12px, ONLY amber on card
│ [ Pullikda davom etish ]                     2° btn    │  cheap+canGenerate only; border gray-5, NEVER brand-filled; the only button
└────────────────────────────────────────────────────────┘
```

**Rules (locked):**
- **Rows** `gap-3`, **no connector lines** (whitespace + dot states carry sequence).
- **Indeterminate** (transcript, total unknown): 30%-width brand segment sliding L→R ~1.6s infinite; reduce-motion → static 25% fill + caption "Boshlanmoqda…". Replaces ALL shimmer/skeleton — delete the 6-bar skeleton entirely.
- **No %** anywhere (coarse + download-feel). N/M + ETA-in-words only.
- **Motion budget = exactly 2:** bar width transition + indeterminate slide. **No dot pulse, no spinners** in running state (the filling bar is the liveness signal). Gate width with `motion-safe:`.
- **Color budget:** brand = active dot + bar fill + done dots ONLY. `--brand-wash` used **nowhere** in this state (dark-mode glow risk). Amber-11 = quota line. Red-11 = error (existing).
- **Bar 4px** (`h-1`) not fat; **track `gray-5`** not gray-3 (invisible on gray-2 card).

**Traps to bake into the task (Fable):**
1. `--brand-wash` retired here (light-only token → dark glow/vanish). 2. Track `gray-5`+, check both modes. 3. **ETA monotonic non-increasing** per stage (keep min seen); under 1 min show "Oz qoldi" not "~0 daqiqa". 4. Stage boundary (12/12 → 0/8): vertical list solves the "backwards jump"; don't animate the new bar from the old width. 5. File-download feel cure = thinner/quieter, never more chrome. 6. `motion-safe:` on width — explicit checklist item. 7. **Terminal frame:** on final poll mark all 3 done (no 99%-forever bar) before the panel swaps to content.

**Build target:** rewrite the `if (isRunning)` block in `GenerateAiPanel.tsx` to this; add focal-verb i18n keys (uz/ru/en); keep using existing `computeEtaMinutes`, chunk counts, mode, quota flag. Gate tsc/vitest/build. Live-verify at next Contabo redeploy.
