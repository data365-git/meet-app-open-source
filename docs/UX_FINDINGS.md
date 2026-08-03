# UX/UI Analysis — Ustoz (2026-06-21)

Method: persona-walk of every screen via the preview browser (:3001) as a brand-new
non-technical Uzbek user. Desktop 1280, mobile 375, OS-dark emulation. Judged against
~/.claude/DESIGN_PRINCIPLES.md (at-a-glance clarity, colour-as-signal, one primary action,
light+dark, no AI-slop) + memory feedback_design_simple_clear.

Screens walked: dashboard (/dashboard/caps), Organization Settings, share page /s/[id]
(Summary / Tasks / Transcript / Refined + AI chat), recorder dialog, mobile share page.

## Dev-only artefacts — NOT bugs (ignore, absent in production)
- TanStack DevTools dark overlay panel ("General — Configure general behavior of the devtools panel").
- "Compiling …" black pill (Next.js/Turbopack dev indicator).
- HMR / RSC-payload console noise.

## Findings (ranked by how much they hurt at-a-glance clarity / professionalism)

### HIGH
1. **Half-English UI vs Uzbek content.** Dashboard, Settings, recorder dialog, share-page
   tab labels and section headings are all English ("New Folder", "Import Video",
   "Record in Browser", "Storage", "Organization Settings", "Full Screen", "System Audio",
   "Start recording", "Summary/Tasks/Transcript/Refined", "TRANSCRIPT", "Next Steps",
   "Comments", "No comments yet", "Leave a comment", "View analytics"). Content is Uzbek,
   chrome is English → app feels unfinished/unlocalized to the teacher + his students/clients.
   Locked decision allows UI-string i18n (only transcript translation is dropped). → translate UI to Uzbek.
2. **"Meeting cost $0.0200" shown to viewers on the share page.** It is the FIRST, most
   prominent card in the right sidebar of /s/[id], visible to anyone who opens the link.
   Leaks internal AI/processing cost to students/clients; unprofessional + confusing.
   → hide cost from viewers; admin/owner-only.
3. **Recorder defaults "System Audio — Off".** Risk: silent recording → transcription
   fails with NO_AUDIO (the exact prior bug). A fix was meant to default it ON. → verify &
   force System Audio ON by default (mic off to avoid echo). Core-feature risk, not cosmetic.

### MEDIUM
4. **"Request permission" badges are RED** on Camera/Mic in the recorder. Red = danger in the
   design language; this is a neutral "grant access" prompt → reads as an error/broken.
   → neutral or amber colour + clearer wording ("Ruxsat berish").
5. **No automatic dark mode.** App stays light even when the OS is dark (dashboard tested).
   Owner principle = support light+dark. → decide: keep light-only or add dark.
6. **Share page wastes desktop width.** Content ~900px, ~380px empty right margin on wide
   screens. → centre the layout or widen for balance.
7. **macOS traffic-light dots + "Pro" badges** (recorder window chrome; "Shareable link icon Pro").
   Skeuomorphic/irrelevant for a self-hosted free app; "Pro" implies paid features that don't
   exist here → mild confusion. → remove dots; drop/neutralise "Pro" badges.

### LOW / cosmetic
8. Some video thumbnails are blank gray placeholders next to real ones → looks unfinished.
9. Storage label "1.7 MB / 10 GB · 100% free" — "100% free" wording is slightly ambiguous.

## What is GOOD (do not touch)
- AI chat panel (frosted dark popup): fully Uzbek, clear greeting + quick-action chips
  (Qisqacha xulosa / Vazifalar ro'yxati / Follow-up xat / Asosiy qarorlar). Well done.
- Share page overall matches the blue mockup; sticky video works; transcript click-to-seek,
  bold key terms, speaker avatars.
- Dashboard + Settings are clean, well-organised, professional; mobile share page is readable
  (tabs fit, full-width video, large legible transcript).
