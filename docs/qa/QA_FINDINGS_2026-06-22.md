# QA Findings — 2026-06-22 (live deploy capweb-production-dd85.up.railway.app)

Method (owner directive): write ALL bugs down first → fix holistically in one pass → re-verify.
Status legend: [ ] open · [x] fixed+verified · [~] fix written, not yet verified.

## A. SIDEBAR LAYOUT — overlapping text (owner's headline complaint)
- [ ] **A1 (High) ROOT CAUSE — bottom group overlaps Spaces list.** `Navbar/Items.tsx` `<nav className="flex flex-col justify-between w-full min-h-full">` has two flex children: top group (`mt-5` nav items + `<SpacesList/>`) and bottom group (`pb-4 mt-auto` `<StorageIndicator/>` + `<SidebarUser/>`). With `justify-between` + `min-h-full`, when total content > sidebar height the top group (flex-shrink:1) gets COMPRESSED and its content overflows downward, rendering ON TOP of the pinned bottom group. Measured live: StorageIndicator card rect 440–509 overlaps "Browse spaces" rect 439–459 (overlap=true; no absolute/sticky involved). The earlier `h-full`→`min-h-full` fix (commit 96bcc38) helped the upper nav items but did NOT fix this.
  - **Holistic fix:** restructure the sidebar to 3 zones — FIXED top (logo + org switcher), SCROLLABLE middle (nav items + SpacesList, `flex-1 min-h-0 overflow-y-auto`), FIXED bottom (StorageIndicator + SidebarUser, `shrink-0`). Remove `justify-between`; the middle is the only scroller. Files: `Navbar/Items.tsx` + `Navbar/Desktop.tsx` (the wrapper currently does the scrolling — move the scroll to the middle zone only).
- [ ] **A2 (Low)** org switcher (top of sidebar) scrolls UNDER the fixed page header when the sidebar overflows (org name rect top=37 sits above the 57px header). The 3-zone fix (fixed top) resolves this too.

## B. EXTENSION (owner: make "Install Extension" actually install; extension also missing from this Chrome)
- [ ] **B1 (High)** No public install path. The extension is the unpacked build at `apps/browser-extension/dist` (gitignored). There is no Chrome Web Store listing, so a button cannot one-click-install. Plan: (a) provide a downloadable packed extension (zip of `dist`) served by the app + a short "how to load unpacked" instructions page, and point "Install Extension" / "Download the extension" there; (b) rebuild `dist` on this machine and load it into the owner's Chrome (owner deleted it). Also set the extension's default API base URL to the live Railway URL before building.

## C. AI / GEMINI (owner: use the free-trial Gemini key)
- [ ] **C1 (High)** AI is wired as a MANUAL one-button flow (admin-gated) but no server Gemini key is set → AI can't run. Owner authorized using the free-trial key (in local `.env`: `GEMINI_API_KEY=AQ.Ab8RN6…`). Action: set `GEMINI_API_KEY` in Railway @cap/web, then verify the full flow on the seeded test video `xg7yh84kpggh4q8`: click Start-AI → transcription → Summary/Transcript/Refined populate + distinct + % progress + graceful error.

## H. AI GENERATION SKIPPED — non-standard transcript VTT (HIGH, real bug, found 2026-06-22)
- [ ] **H1 (High)** After clicking Start-AI on the seeded video, transcription COMPLETED (accurate VTT produced + stored in R2) but `aiGenerationStatus="SKIPPED"` → no Summary/Refined/Chapters. ROOT CAUSE: `lib/gemini-transcribe.ts` prompt tells Gemini to use timestamp format `**[HH:MM:SS]**` AND "WebVTT cues" (conflicting) → Gemini emits one-line cues like `**[00:00:00.000 --> 00:00:05.500]** text` (timestamp+text on the SAME line, markdown brackets). Code saves it AS-IS (only checks `startsWith("WEBVTT")`). Then `generate-ai.ts parseVttWithTimestamps` treats any line containing `-->` as a timestamp-only line and never extracts the same-line text → 0 segments → `fetchTranscript` returns null (text<10) → `markSkipped`. This ALSO breaks HTML `<track>` captions (invalid WebVTT) and likely the Transcript tab.
  - **Fix:** in `gemini-transcribe.ts`, NORMALIZE Gemini output to standard WebVTT regardless of the format it returns (handle `**[start --> end]** text`, `[start --> end] text`, `**[ts]** text`, and already-standard), strip markdown, re-emit `i\nstart --> end\ntext\n\n`. ALSO harden `parseVttWithTimestamps` to capture trailing text on a `-->` line. Verify: re-run AI on `xg7yh84kpggh4q8` → Summary/Transcript/Refined populate + captions valid.

## D. PLAYBACK (already fixed earlier — keep verified)
- [x] **D1** video 500 → fixed via CAP_AWS_* env (root cause: t3-env runtimeEnv ≠ process.env). Player buffers + plays. (Transient browser↔R2 503 = edge hiccup, player retries; not server-reproducible.)

## E. BRANDING / DEAD LINKS (commit 96bcc38 did the main pass; verify on new build + Codex to list residuals)
- [~] **E1** user-facing "Cap"→"365" done across login/signup/invite/share/embed/dashboard/settings; logo + <title> keep "data365". VERIFY new build renders "365" everywhere.
- [ ] **E2 (Low, deferred)** desktop-app leftovers not in the teacher flow: MobileMenu `/download`, `install-cli.sh`/`.ps1` cap.so, `api/download` redirect, `cap-desktop://` deeplink (api/desktop/session); cap.so backend proxies (collection-password, loom rate-limit, send-download-link); storage S3-docs link now `#`.

## FIX STATUS — commit eeb4ba7 pushed (2026-06-22), redeploy in progress
- [~] A1 sidebar overlap — FIXED: removed `justify-between`, `shrink-0` on top+bottom groups (Items.tsx). Verify live after redeploy.
- [~] A2 org switcher under header — improved by the same change. Verify.
- [~] H1 AI SKIPPED — FIXED: `normalizeToWebVtt()` always emits standard WebVTT (gemini-transcribe.ts) + hardened `parseVttWithTimestamps` (generate-ai.ts) + fixed prompt. Codex-reviewed (1 cue-settings edge fixed). Verify live: re-run AI → Summary/Transcript/Refined populate.
- [x] C1 Gemini key — SET in Railway (free-trial, owner-authorized); AI transcription verified running (Gemini works).
- [~] E1 branding — DONE incl. residual page <title>s (record, collection), recorder logo aria → 365/data365.
- [~] B1 extension — dist REBUILT with live URL; fallback URL fixed in config.ts. REMAINING: load into owner's Chrome (guided); optional in-app download page (deferred feature).
- [ ] E2/G1/G2 — deferred (desktop dead-links, MySQL region, cron) — documented, not blocking teacher flow.

## F. CODEX STATIC AUDIT (task b6cqipzf0) — FAILED to run (Windows sandbox shell error -1073741502, couldn't read files). Not blocking: the exhaustive Sonnet audit + live diagnosis already produced the full list; Codex DIFF reviews (which DID run) covered the actual changes (playback, branding, VTT, sidebar) and found only minor/cosmetic items.

## G. INFRA / OWNER-PHYSICAL
- [ ] **G1 (Med)** MySQL service has "Invalid region sfo blocking deployments". DB is Online now; do NOT change region (volume move risks the live DB). Flag to owner; fix only with a planned migration.
- [ ] **G2 (Low)** Railway native cron for stale-PROCESSING-job recovery (vercel.json crons don't run on Railway) — reliability nice-to-have.
