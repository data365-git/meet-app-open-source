# Remaining data365 work - specs for GLM (2026-09-25)

Two independent jobs. Run each in its OWN worktree/branch. Rules for both:
- Node: `$env:Path = "C:\Program Files\nodejs;" + $env:Path`. If `@cap/*` packages resolve into another checkout, run `pnpm install --offline --frozen-lockfile` inside the worktree.
- Run ONLY the test files you touch while working; run root `pnpm typecheck` (must exit 0) and the full `pnpm --filter @cap/web run test` ONCE at the end. Known flaky under load: `upload-cap-button-fast-path`, `import-upload-cancel` - if one fails, re-run it alone and report.
- Every new test must FAIL when its fix is reverted: revert the fix line, run the test, copy the failure message into the report, restore.
- Never weaken or delete an existing assertion. No refactors, no files outside the listed scope. No CRLF churn, no BOM.
- Commit on the branch with a message ending `Co-Authored-By: GLM-5.3 via Claude Code <noreply@anthropic.com>`. Do NOT push, do NOT deploy, do NOT edit docs/STATE.md.
- REPORT (under 25 lines): sha, per item file:line, the RED messages, typecheck exit, suite counts, anything not done.

---

## JOB 1 - finish `fix/processed-marker` (lost-upload self-recovery)

Worktree: `D:\vibecoding\ustoz-github\.claude\worktrees\agent-ac9e53f115b67a643` (branch `fix/processed-marker`, HEAD `2a64c83`). First run `git status`: an earlier agent was interrupted mid-edit (route.ts imports `ROWLESS_UPLOAD_CUTOFF` that may no longer exist). Finish or revert its half-done edit so the tree typechecks.

Background: `processVideoWorkflow` now writes `metadata.processedAt` when a run finishes and `metadata.processingRunAt` just before it deletes the `video_uploads` row. The cron `apps/web/app/api/cron/recover-stale-ai-jobs/route.ts` relaunches "rowless" videos (no upload row, transcriptionStatus NULL, no processedAt, stale, raw-upload.* present, rowlessRelaunchAttempts < 2).

1. Replace the hand-set date with a data fact. Admit rowless videos ONLY where `JSON_EXTRACT(metadata,'$.processingRunAt') IS NOT NULL` (SQL, route.ts ~:726-742) and in the JS re-check (~:93-111) `if (!extra.processingRunAt) return false`. Only new-code runs write that field, so older videos are never touched. Delete `ROWLESS_UPLOAD_CUTOFF` from `stale-job-helpers.ts` and every use. Tests: a video with no processingRunAt -> untouched; stale processingRunAt + no row + no processedAt + raw present -> relaunched.
2. Tests that are currently blind:
   - `__tests__/unit/process-video-progress.test.ts`: record the ORDER of DB calls in the mock; assert the processingRunAt write happens BEFORE the video_uploads delete. (A reviewer moved the stamp to the end of the run and every test still passed.)
   - `__tests__/unit/recover-stale-rekick.test.ts`: assert the quota re-kick calls `transcribeVideo("vid-quota-1","owner-1",true,true,false)` exactly (5th arg false).
3. `apps/web/workflows/process-video.ts` ~:342 `clearProcessingProgress`: in the SAME update also set `processingRunAt` to now, so the gap between clearing progress and writing processedAt never looks stale on a run longer than 30 minutes. Test it.
4. `apps/web/actions/admin/replace-video.ts` (~:38) uploads straight to result.mp4 and writes no processedAt. Write `processedAt` (same JSON_SET shape as `markProcessingFinished` in process-video.ts) where that admin flow finishes successfully. If you cannot find where it finishes, STOP and report instead of guessing.

---

## JOB 2 - honest AI status on the recording page (owner order)

New branch `fix/honest-ai-status` from `qa-fixes` HEAD, new worktree. Owner's words: "pul tugasa pul tugadi desin - nima muammoligini va aniq statusni ko'rsatsin, yolg'on va bugsiz." Owner confirmed: the recording page ALWAYS shows the real reason and what happens next; never a bare "failed" and never a false "done". NO balance banner (owner said no).

Current state (measured, file:line):
- S1 transcription ERROR + `metadata.transcriptionError.code='QUOTA'`: already honest (`GenerateAiPanel.tsx:571-603`, `transcription-error-message.ts:16-22`, messages `*.json:578-579`). Gap: after `quotaRetryAttempts >= MAX_QUOTA_RETRY_ATTEMPTS` (12, `api/cron/recover-stale-ai-jobs/stale-job-helpers.ts:51`) the text still promises automatic retry, which is false.
- S2 budget refusal: `lib/transcribe.ts:379-382` returns "AI budget exceeded"; generate route passes it as HTTP 500 raw English (`api/videos/[videoId]/generate/route.ts:199-200,224-225`); panel shows it raw (`GenerateAiPanel.tsx:206`, shown :688/725/769); lost on reload.
- S3 COMPLETE with `metadata.transcriptionGaps` [{startSec,endSec}]: no UI reads it.
- S4 PROCESSING + `metadata.aiQuotaWaiting`: shows the normal running stepper.
- S5 summary `aiGenerationStatus='ERROR'` with `aiGenerationError` "AI budget exceeded" or a quota/402 message (`workflows/generate-ai.ts:270-274,399-414`): panel shows generic "AI analysis failed. AI generation error."

Build (owner/admin sees reason + numbers; public share viewers see a neutral line without money numbers, like S1 already does):
1. Server: expose on the status the panel already polls (`apps/web/actions/videos/get-status.ts`) - `transcriptionErrorCode`, `quotaRetriesExhausted` (attempts >= 12), `transcriptionGaps`, `aiQuotaWaiting`, `aiGenerationErrorCode` ('BUDGET' | 'QUOTA' | 'OTHER', classify with the existing `isQuotaLikeAiError` and BudgetExceededError text - no second classifier), and for the owner only `aiBudget: {spentUsd, capUsd}` when the org/user monthly cap is reached (reuse `lib/ai-cost-guard.ts` helpers `getAiBudgetCapsMicros` + monthly spend). Generate route: on budget refusal return HTTP 402 with `{code:'AI_BUDGET_EXCEEDED'}` instead of 500 + raw text.
2. UI texts (add keys to `apps/web/messages/en.json`, `uz.json`, `ru.json`; Uzbek below is the owner-approved wording, write en/ru equivalents):
   - S1 exhausted: "AI hisobida mablag' tugadi va avtomatik urinishlar tugadi. Hisob to'ldirilgach, 'Qayta urinish' tugmasini bosing."
   - S2 (owner): "Oylik AI chegarasi to'ldi (${spent} / ${cap}). Admin sozlamalarda chegarani oshirishi kerak." Public: "AI tahlil vaqtincha to'xtatilgan."
   - S3: under the transcript: "Bu joylarda matn yo'q: 1:42:41-1:47:01, ... (jimlik bo'lishi mumkin)." Format times h:mm:ss.
   - S4: "Bepul AI navbati kutilmoqda - o'zi davom etadi."
   - S5 BUDGET: same as S2. S5 QUOTA: "AI hisobida mablag' tugadi - xulosa yozilmadi. Hisob to'ldirilgach, 'Qayta urinish' tugmasini bosing." S5 OTHER: keep current text.
3. Tests (jsdom, style of `__tests__/unit/upload-placeholder-percent.test.ts`): one test per state S1-exhausted, S2 owner, S2 public, S3, S4, S5 BUDGET, S5 QUOTA - each renders the panel with that status and asserts the exact key/text; plus a route test that budget refusal returns 402 + code. Each RED when its mapping is removed.
