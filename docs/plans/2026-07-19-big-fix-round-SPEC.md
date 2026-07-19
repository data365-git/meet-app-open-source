# BIG FIX ROUND — full executable spec (2026-07-19, session n)

> **Purpose: any fresh session (Opus or other) continues from THIS file alone.**
> Approved by owner in plan mode; independently plan-reviewed (Fable, verdict SHIP-WITH-FIXES,
> all 10 must-fixes folded in). Mirror of the approved plan + live progress state.
> Companion docs: `docs/plans/2026-07-19-onboarding-i18n.md` (ready catalog),
> `docs/RUNBOOK.md` §3a (deploy), `docs/OWNER_QA_SCRIPT.md` (owner gate),
> `docs/qa/SESSION_INJECTION_NOTES.md` (authed prod verify). `PIPELINE_MAP.md` is STALE — never use.

## 🎯 GOAL
Production-ready for the owner's IT team. #1 = **a meeting must NEVER fail to record, and the
recording must contain the OTHER participants' voices.** Owner's real Meet test FAILED because the
site served a STALE extension zip (packaged 07-18 13:41; the 5 audio-guarantee commits landed
16:59–00:41 after). Everything below flows from that incident + 11 more defects he listed.

## OWNER DECISIONS (locked — do not re-ask)
- Onboarding step 4 "Invite your team" (Stripe pricing) → **REMOVE from wizard** ("yashir").
- Meeting default = **full-screen video + Meet-tab audio** (he presents slides in Meet); Meet-tab-only stays secondary.
- Transcript drift → **Gemini-only** improvement. NO ElevenLabs in the pipeline (it may be used as a MEASURING stick only).
- Design (AI chat + panels dark + AI status UI) = **his delivered files** (below), implement faithfully; where files leave gaps, extend in THEIR style.
- Two deploys: **Deploy A after Wave 0** (owner starts real meeting QA early), **Deploy B after Waves 1-2.5**.

## DESIGN ASSETS (owner-delivered; durable copies in Downloads)
- `C:\Users\mirko\Downloads\ADHD-do'st GitHub AI chat1.zip` (v2, supersedes v1) → `handoff/`:
  - `AIChatPopup.tsx` + `ai-chat.css` → replace `apps/web/app/s/[videoId]/_components/` versions; i18n `aiChat` block for uz/ru/en in its README; optional chat prompt patch for `app/api/video/ai/chat/route.ts` (TL;DR + sections format).
  - `handoff/panels/` → replace `BelowVideoTabs.tsx` + `panels/{Summary,Transcript,Tasks,RefinedTranscript}Panel.tsx` (dark-mode token swap, purple→blue accent). Its README also flags: `globals.css` has an UNLAYERED `body,html{color:#000;background:#f2f2f2}` rule that beats `@layer base` theming — strip color/bg from it.
  - `handoff/status/README.md` → granular AI-status contract. ⚠️ Its stage list (embedding-centric, weights 5/20/15/50/10) is the designer's GUESS — take the UI SHAPE, map the REAL stages (transcribe→summary→refined; embedding is only the chat index).
- `C:\Users\mirko\Downloads\AI Status.dc.html` → visual sample for the status card: "Hozir: <stage>" + detail line ("16 bo'lakdan 5-si yuborilmoqda") + weighted % bar + ETA + step list (done=green ✓ / active=accent+spinner+n/m / future=dimmed), CSS-var light/dark tokens, reduced-motion respected.

## PROGRESS STATE (as of writing)
- ✅ Zip-staleness guard DONE: `scripts/check-extension-zip-freshness.mjs` (history + `--staged` modes, `SKIP_ZIP_CHECK=1` escape) + local `.git/hooks/pre-commit` calling it. Proven: history mode currently FAILS on the stale zip (correct until Wave 0 repackages).
- ✅ Prod server sized for Wave 1 compress: 4 cores / 8GB (5GB avail), load ~0.4. ffmpeg via `ffmpeg-static` (already used in prod by transcription). SSH: `ssh -i ~/.ssh/hetzner_ustoz root@169.58.12.255`.
- ✅ STATE.md top block updated (session n).
- 🔄 IN FLIGHT: two Sonnet subagents editing the working tree (NOT committed). If the session died mid-flight: run `pnpm --filter @cap/web exec tsc --noEmit` + `pnpm build` in `apps/browser-extension`, finish/fix per the two specs below, review diffs, then proceed. Known mid-work diagnostics seen (must be ZERO before commit): popup.ts import/local conflict `populateDeviceSelect`; upload.ts Uint8Array→BodyInit overload + unused `durationInSecs` vars; sw.ts `MessageBase`→`Record<string,unknown>` casts (5×) + unused `computeDurationInSecs`; web-recorder-dialog unused `onClose`. (FormEvent/MutableRefObject deprecation ✶-warnings in Welcome/OrganizationSetup/Top.tsx are pre-existing noise — ignore.)
- Git: branch `qa-fixes`; `cd1bd6e` (404 uz fix) committed NOT deployed; the ~75 long-standing untracked scratch files + QA docs stay untracked (repo norm).

---

# WAVE 0 — sacred recorder + quick wins → Deploy A (ONE zip build, ONE manifest bump)

## 0.A Extension subagent spec (in flight — finish/redo per this)
Scope: `apps/browser-extension/` only. Line numbers ≈ anchors; re-locate by content.
1. **Meeting filing (mis-filed as Recording today).** HARD CONSTRAINT from adversarial review: `state.mode` is the control-flow discriminator for STOP(~sw.ts:591)/PAUSE(~639)/RESUME(~693)/CANCEL(~766)/INSTRUCTION_CANCEL(~753)/tabs.onRemoved(~1695-1724)/watchdogs(~907,938) — **keep `state.mode="instruction"`** for the full-screen meeting flow. Thread **meetingId only**: popup (parse from Meet tab URL) → START_INSTRUCTION msg → `ArmingState.meetingId` (exists, state.ts~28) → recorder.html URL param via `openInstructionRecorder`(sw.ts~60-88) → RECORDER_STARTED fallback(~1204). At the `initializeUpload` call (~1226): `initializeUpload(meetingRequired ? "meeting" : mode, meetingId)`. Popup recording label branches on the meeting flag (~popup.ts:667), NOT on state.mode. `upload.ts initializeUpload("meeting", id)` already titles "data365 Meeting — <id>" + sends extensionContext correctly — don't restructure. Verify: non-Meet instruction still files as Recording; stop/pause/cancel routing untouched.
2. **4 clicks → 2.** Popup auto-fires START_INSTRUCTION(meeting)+closes ONLY when idle AND signed-in AND isMeetTab&&meetingId (any other state → normal popup, else stop/pause unreachable; guard double-fire). Recorder page meeting variant gains the two popup-only affordances: mic enable+device dropdown (persist in chrome.storage.local, wire deviceId into its getUserMedia) and quiet secondary "Faqat Meet tabini yozish" (cancel arming → START_MEET). Primary button = single "Boshlash" (picker→checks→start already chained). DO NOT touch tab-audio liveness checks / hasRemoteAudio warning / "Mijoz ovozi olinmadi. Baribir boshlaymizmi?" modal — they ARE the guarantee. Update meet-detect.ts nudge copy (~581-611) to the shorter flow.
3. **Bitrate:** recorder-page.ts~660 + offscreen/recorder.ts~203: video 600_000→**1_500_000**, audio 96_000→**128_000** (1.5Mbps transparent for 720p slides; 2.5M would quadruple upload against owner's slow uplink).
4. **durationInSecs at complete** (fixes seek bar pre-AI): server already accepts it (`multipart.ts` ~590-593 and ~680-687). Extension complete call (`api.ts` ~122-124) must include rounded elapsed seconds (recording state startedAt/pausedAccumMs family). Smallest plumbing that produces a real value.
Verify: `pnpm build` clean; typecheck clean; STOP/PAUSE/CANCEL/onRemoved unaffected (report explicitly).

## 0.B Web subagent spec (in flight — finish/redo per this)
Scope: `apps/web/` only.
1. **Onboarding i18n + remove step 4.** Execute `docs/plans/2026-07-19-onboarding-i18n.md` exactly, minus keys of the removed page (`invite*`,`billing*`,`getStarted`,`checkout*`,`perUser*`,`alreadyPro`,`somethingWrong`,`stepInviteTeam`). Removal blast-radius (ALL in same change): `[...steps]/layout.tsx`~20-42 `ordered`+firstIncomplete redirect (else new users perma-redirect to a deleted step = hard lock — THE critical file) · `[...steps]/page.tsx`~16,31-32 switch · `Stepper.tsx` path map~26, steps array~46-50 (5→4), prop type~16, MobileStepper hardcoded "/5"~144 → steps.length, id renumber · `CustomDomainPage.tsx`~25 push→`/onboarding/download` · delete `InviteTeamPage.tsx`+route dir. LEAVE `UserCompleteOnboardingStep` RPC + invite-accept writers untouched. ⚠️ Stepper trap: `currentStep===step.name` string-compare — compare by stable id/path, translate only the label (or identical t() calls both sides); verify highlight per step. All client components → `useTranslations("onboarding")`; insert namespace before `"common": {` in all 3 message files; CustomDomain desc via `t.rich` `<domain>` tag.
2. **Navbar "New recording" = 1 step:** `RecordVideoPage.tsx` auto-open `WebRecorderDialog` on mount (add optional defaultOpen/controlled prop; don't break Caps.tsx trigger usage), delete FAQ block (~37-86), onClose→`router.push("/dashboard/caps")`.
3. Delete dead `Top.tsx:44` `"/dashboard/shared-caps"` map entry (keep :45).
Verify: tsc 0 · vitest green · 3 locales parse, `onboarding.stepOrganization` present, `inviteTitle` absent · grep 0 onboarding literals + zero `invite-team` refs (outside the untouched RPC/invite files).

## 0.C Finishing steps (main session)
1. Review both diffs (CRLF check: `git diff --shortstat` vs `-w`). Fix the diagnostics listed in PROGRESS.
2. `cd apps/browser-extension && pnpm build && pnpm package` (AFTER last src edit) → bump `manifest.json` version first → verify new `apps/web/public/365-extension.zip` → `node scripts/check-extension-zip-freshness.mjs` passes.
3. Gates: tsc 0 · vitest · locales parse · extension build clean.
4. Commit (wave-0 commits; zip staged with extension src or pre-commit hook blocks).
5. **Deploy A** per RUNBOOK §3a (~40 min). Live-verify: onboarding 4-step uz walk via minted session (SESSION_INJECTION_NOTES.md — local dev DB is DEAD, never claim local walk), 404 uz page, live zip version = manifest bump.
6. Tell owner: install new zip → run OWNER_QA_SCRIPT steps 1+6 (solo 3-min playback; 2-person Meet remote-voice + files under **Meetings**).

# WAVE 1 — playback & upload core (web-only)
1. **Post-upload finalize** — insertion point EXISTS: `startVideoProcessingWorkflow` (`lib/video-processing.ts`) already transitions `videoUploads` to phase="processing" (this blocks manual AI start via transcribe guard `workflows/transcribe.ts:27-58` AND makes CapVideoPlayer show processing state — the race answer) then fires `processVideoWorkflow` (`workflows/process-video.ts`, currently just deletes the row). Implement its real body: `optimizeRemoteVideoToMp4` (`lib/video-convert.ts` — probe→copy/compress decision→faststart mp4, returns metadata.durationSec; ⚠️ `FFMPEG_TIMEOUT_MS=5min` must be parametrized: ~10min copy / ~40min compress) → upload result over `result.mp4` in R2 → `videos.duration = durationSec` → delete videoUploads row. Wire the EXTENSION complete path into it (multipart.ts ~694-698 currently deletes the row directly — switch to startVideoProcessingWorkflow) and ensure the IMPORT finalize sets mode="multipart" (singlepart escape transcribe.ts:54-58). VP9/Opus input → strategy "compress" (isBrowserSafeMp4Codec=false) → also fixes iPhone playback for meetings; timestamps survive re-encode (timeline unchanged).
2. **Trim real:** remove Pro gate `save-edits.ts:143-148`; replace `workflows/edit-video.ts` throw with ffmpeg keepRanges (-ss/-to) implementation. **Post-AI trim desync guard:** if transcript/AI artifacts exist, deterministically remap cue+chapter timestamps across keepRanges + update duration; if unclean → mark stale + surface re-run. Never leave cues on the pre-trim timeline.
3. **Upload speed:** route import + web-recorder buffered-raw through multipart (16MB parts, 3 parallel, per-part retry + stall timeout — mirror `instant-mp4-uploader.ts`); single PUT only <50MB + add `xhr.timeout`. Web bitrate raise (`useWebRecorder.ts:1089` 600k→1.5M/128k) lands IN THE SAME COMMIT as buffered-raw multipart (500MB Blob on single PUT = OOM/loss risk).
Gates: tsc 0 · vitest (video-convert.test now covers live code) · fresh recording seek-to-middle pre-AI · 200MB import trim → stored file is trimmed length · playwright smoke.

# WAVE 2 — AI pipeline surface
1. **Status granularity:** `/api/video/ai/route.ts` add `transcriptionChunksCompleted/Total` + `aiStageChunksCompleted/Total` to all 3 response branches (metadata already in scope ~line 87). `GenerateAiPanel` reads them from the poll; drop `router.refresh()` 6s hack (`ShareVideo.tsx:295-305`). `CapCard.tsx`: one uz line while AI runs (stage + "Bo'lak 5/16", reuse `use-ai-status.ts`). **Restyle per the design status contract + `AI Status.dc.html`** (real stages: transcribe→summary→refined).
2. **Price honesty:** drop `billingMonth` filter for video scope (`get-monthly-spend.ts:77-99`); set `NEXT_PUBLIC_USD_TO_UZS` on prod; MeetingCostPanel adds "bepul kvota bilan tejaldi: ~X so'm" (re-price $0 free-tier events via `packages/utils/src/ai-pricing.ts` rates, label "taxminan" — events lack audio/text split); rename "Xulosa" bucket (it aggregates summary+chapters+title). Answer embedded: 1500 so'm was REAL paid spend; free-tier share now visible.
3. **Drift (Gemini-only autoresearch):** Scope `workflows/transcribe.ts` chunking + `lib/audio-extract.ts` anchoring + prompt. Metric: max+mean cue drift on owner's real 42-min video; ground truth = Scribe manual action as measuring stick if `ELEVENLABS_API_KEY` on server, else 10 ffmpeg-cut known-offset snippets text-matched. Success max ≤10s (stretch ≤5s); plateau stop after 3 flat iterations. Ranked directions: (1) per-chunk linear rescale (`actualChunkDuration/lastCueEnd` — cue clock runs fast within chunk, re-anchors at boundaries, proven in 8b98ce6 analysis); (2) 6min→4min chunks; (3) silence-anchor fallback robustness; (4) prompt anchor "audio is exactly N seconds". History: 8b98ce6 (15→6min), 949f41f (silence-anchored cuts) — intact, not regressed; ~11s was best-case math, 3s was ElevenLabs (excluded).
Gates: tsc 0 · vitest · computed before/after drift numbers · granular status visible in a real AI run.

# WAVE 2.5 — owner's design implementation (web-only)
1. **AI chat:** drop in `handoff/AIChatPopup.tsx` + `ai-chat.css`; add `aiChat` i18n block (uz/ru/en from handoff README); ensure share page is inside `NextIntlClientProvider`; apply the chat-route prompt patch (TL;DR+sections). Base = closest existing variant; DELETE the other `?variant=` twin in the same change. Old LiquidGlassContainer import removed (file stays).
2. **Panels dark:** drop in `handoff/panels/*` replacements (token swaps only, logic unchanged — verify by diff that parsing/scroll-spy/task-toggle/VTT logic is byte-identical); strip `color`/`background-color` from the unlayered `body,html` rule in `globals.css` (the layered `bg-background text-foreground` takes over).
3. Walk every share+dashboard+onboarding screen light+dark mobile 375px; screenshots; fix contrast breaks in the file's style.
Gates: tsc 0 · screenshots match design · unused chat variant deleted.

# WAVE 3 — Deploy B + verify + closeout
1. Deploy B (RUNBOOK §3a): Waves 1-2.5, web-only (no second zip — 0.3/0.6/durationInSecs rode the Wave-0 zip; `node scripts/check-extension-zip-freshness.mjs` must pass).
2. Live verify (Browser pane, mobile, screenshots): fresh-recording seek pre-AI · granular AI status · price panel free-tier line · >100MB import trim · onboarding · zip version.
3. Kill stale Tailscale funnel on owner's PC (APPROVED): stop old `next start` PID on :3000 + `tailscale funnel off`; verify `data365.taildef23b.ts.net` stops answering. (⚠️ that host = owner's own PC serving a dead-DB copy; never judge prod by it — prod = `data365.duckdns.org`.)
4. STATE.md: rewrite top block (goal board, prune done, OWNER TODO refresh).
5. OWNER GATE (only true "production ready"): OWNER_QA_SCRIPT steps 1+6 on the new zip — remote voice audible + filed under Meetings. Until step 6 passes, the recorder is NOT "ready".

# STANDING RULES FOR THE EXECUTOR
- Sonnet subagents do the DOING per specs; the main session reviews every diff (reviewer ≠ author). Commit per workstream; CRLF check before each commit; pre-commit zip guard active.
- Never claim "tayyor" on anything live-observable without walking it on `data365.duckdns.org` (Browser pane, mobile viewport, screenshot proof).
- Deploy = RUNBOOK §3a only. Never push to main without owner approval (main carries the purge-trash cron; not Coolify-deployed).
- Uzbek to owner, short; English in repo. One dars max per task, only on a real trigger.
