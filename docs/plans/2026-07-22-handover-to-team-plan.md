# Handover-to-team — finish plan (grill-with-docs, 2026-07-22)

_Goal (owner's words): finish all important work and HAND THE PROJECT OVER TO THE CLIENT._

## DECISIONS (grill, 2026-07-22) — BINDING
- **H1 — Client = the owner's own INTERNAL IT team.** Not an external paying customer. So still: no domain purchase, no email, no billing, no multi-tenant hardening. (Re-confirms 2026-07-18 D1.)
- **H2 — Definition of DONE (owner's words):** (a) the post-recording **AI results** — summary, chapters, action items, AI chat — work **flawlessly, error-free**; (b) **meetings/recordings are captured accurately, no drops**; (c) **no money waste, no malfunction**; (d) reach this by having **Fable write a full LIVE test plan first, then execute it with agents**; (e) **timestamp fixed**; (f) **new Gemini models evaluated on price + power.**
- **H3 — Timestamp: FREE path, target ~5-10s (or better).** Measure the deployed anchor fix, then 3-minute chunks + grid-warp. NO paid ElevenLabs Scribe unless free genuinely can't reach a usable bar. (STATE's open timing decision, resolved free-first.)
- **H4 — "AI dashboard" = the post-recording AI results** on a recording (summary / chapters / action items / AI chat). Not a separate admin analytics screen.

## EXECUTION ORDER (CONFIRMED by owner 2026-07-22 — start Phase 1 after /clear)
1. **Fable writes a comprehensive LIVE test plan** — every flow end-to-end on the deployed build: record a Meet → upload → transcribe → AI results (summary/chapters/tasks/chat) → share/watch → member access/onboarding → empty/error/loading states → cost/no-waste checks. Marks which steps a machine can do vs which need the owner's real device.
2. **Execute the plan with agents** against prod (data365) → a ranked defect list (bugs, wrong/empty AI results, waste, malfunctions). (Owner-device-only steps — the real 2-person Meet capture — are flagged for him.)
3. **Fix everything found** so recording + AI results are flawless and nothing wastes money; each fix Fable-reviewed and deployed (the established plan→build→review→review-of-review→deploy chain).
4. **Timestamp fix (free)** — measure anchor fix, then 3-min chunks + grid-warp; verify live; target ~5-10s.
5. **New-model eval** — test the worthwhile new Gemini models on a 10-min uz clip (price + accuracy), report keep-or-switch. (3.5-flash-lite already tested 2026-07-22: cheaper+faster but weaker on uz names/terms → keep 3-flash-preview; will extend to the other candidates.)
6. **Final handover readiness** — re-verify all green + a short quick-start for the team; the human-only gate stays the owner's real 2-person Meet test on v0.5.2.

## HONEST NOTES
- Machines cannot do the real 2-person Meet capture — that stays an owner-device step. Everything else a machine can, I do + prove.
- This is a multi-phase effort (several waves of QA → fix → re-verify), not one session. Each wave stays reviewed before deploy.
- Cost discipline: QA is read-only where possible; any paid Gemini call (model eval, one timestamp re-transcribe) is budgeted and run once, not looped.

## STATUS
- [x] **Owner CONFIRMED (2026-07-22): "cleardan keyin men aytgan tartibda ishlab bu loyihani yakunlaymiz."** The shared understanding above is agreed. Execution starts AFTER /clear.
- **▶ FRESH SESSION STARTS HERE:** begin **Phase 1 — spawn Fable (model: fable) to write the comprehensive LIVE test plan** (every flow end-to-end on the deployed build `d150c49` / data365.duckdns.org; mark machine-doable vs owner-device steps). Then Phase 2 (agents execute) → 3 (fix, each Fable-reviewed + deployed) → 4 (timestamp free) → 5 (model eval) → 6 (handover readiness). Follow the established chain: plan → Fable plan-review → build → my review → Fable review-of-review → deploy. Do NOT re-grill — the decisions H1–H4 are settled.
