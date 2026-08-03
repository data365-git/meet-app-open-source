# Codex — Ustoz full final review + 100% Playwright QA

> Paste everything below the line into the Codex app (with this repo connected as the working project).
> Written so Codex acts as a senior engineer doing an exhaustive, evidence-based release review.
> Codex should DISCOVER the relevant files itself (search the repo) — paths below are hints, not a fixed list.

---

You are a SENIOR release engineer. Do an EXHAUSTIVE, adversarial final review of **Ustoz** (a self-hosted Cap fork — AI video recording + sharing, Uzbek/Russian-first; Next.js 16 monorepo, web app in `apps/web`, shared packages in `packages/*`, a Chrome MV3 extension in `apps/browser-extension`) and a **100% live Playwright QA of every user-facing feature**. Treat it like signing off a production release written by junior AI agents — be adversarial, verify with REAL evidence, never trust "it should work." **Find the files yourself** (grep/read the repo); do not wait to be told where things are.

## Environment
- Repo: this project. Windows host. Node (bash): `export PATH="/c/Program Files/nodejs:$PATH"`. Package manager `pnpm`.
- Gates: typecheck `pnpm tsc -b` (must exit 0); unit tests `pnpm --filter @cap/web run test`; build `pnpm --filter @cap/web build`. (Note: one unit file, developer-credits-checkout, can time out only under full-suite parallel load but passes in isolation — treat that specific case as pre-existing flakiness, not a regression.)
- Live: `https://capweb-production-dd85.up.railway.app` · admin `admin@ustoz.uz` / `<redacted — rotated 2026-07-14>` (login `/login`, next-auth credentials).
- Test videos (admin-owned, AI COMPLETE): `xqmcnsvq66m5yt6`, `4xjzrz767sy3d5n`, `d70sd1qrj7n7xb4`; public share `2t4a58an7acz3bb`.
- Playwright (`@playwright/test`, chromium installed). Drive TWO contexts: authenticated owner + fresh anonymous. NOTE: after many rapid logins the share page may transiently render anonymous (next-auth timing) — before testing owner-only behavior, VERIFY the session is live (an owner-only control is present, or `GET /api/video/ai?videoId=...` returns 200); retry login if not. The default Playwright config targets `localhost:3001`; for live testing point `baseURL` at the Railway URL.
- AI features call Gemini (real spend) — owner authorized limited QA spend. Prefer OPENING then CANCELLING the cost-confirm dialog over confirming; do at most 1–2 real generate/reprocess runs total.

## SAFETY (must follow)
- You may click/type in the app, but DO NOT perform destructive real-world actions (no deleting videos/orgs/members, no real invites/emails, no billing/payment, no rotating secrets). Describe-and-skip any destructive-only test.
- If you toggle real owner data (e.g. a task checkbox), RESTORE it afterward.
- Never weaken a test or the product to make something pass. Evidence = screenshots + measured DOM/network, not assumptions.
- Do NOT commit, push, or deploy. Review + test + report only.

## Recent changes to scrutinize FIRST (this branch, HEAD ~`112c812`, branch `qa-fixes`) — locate each in code, verify correct + regression-free
1. **Chapter-aligned refined transcript**: after AI generation, the summary chapters and the "refined transcript" chapters must ALWAYS be the SAME set (equal count). There is a helper that filters summary chapters to those that produced refined content — find it, and hunt for ANY remaining path where the two lists can diverge (that was the intermittent "incomplete/chala analysis" bug). Also check the underlying refined generator that drops empty-time-window chapters.
2. **Retry-AI / reprocess**: the video "generate" API now accepts a `{ reprocess: true }` body that re-runs AI on the EXISTING transcript even when analysis is COMPLETE, by threading a `force` flag that bypasses two "already generated" guards. VERIFY authz hard: only the video owner or an org admin can force a reprocess; anonymous / other-org / member users MUST be blocked. Confirm the separate older `retry-ai` route (ERROR/SKIPPED only) still works. Confirm a forced reprocess still respects the AI budget guard.
3. **Owner "re-analyze" UI on the share page**: shown VISIBLY only when the analysis looks incomplete; otherwise tucked in a discreet overflow (⋮) menu; never shown to non-owners. Verify the visibility logic and that clicking it opens the cost dialog and posts `{reprocess:true}`.
4. **In-recording camera toggle** (web recorder) and **extension pause/resume** (service worker `paused` state + badge) — code-review level (need a real device); verify the camera toggle only flips track.enabled and cannot stop the recording, and the extension pause actually flips popup state.
5. **UI polish**: AI `**bold**` renders as dark-grey semibold (NOT link-blue); the site language switcher uses real SVG flags (not emoji/letters). Find and confirm.

## PART A — Static review (read the code, discover files yourself)
Per finding give file:line + a concrete failure scenario:
- **Security/authz**: every API route + server action — gated correctly (owner vs org-admin vs member vs public guest)? Can a guest trigger paid AI (transcribe/generate/translate/chat/**reprocess**) or mutate another user's data (tasks, title, sharing, settings)? Org-less / deleted / tombstoned edge cases. Secret handling, input validation, open-redirect, SSRF, injection.
- **Correctness**: AI pipeline (transcription, summary/chapters/tasks, refined transcript, multi-language translation, chat RAG citations), metadata read-modify-write races / silent data loss, LLM-JSON truncation on long (2h) videos, R2 key correctness, statuses never stuck (PROCESSING forever). Known-open to confirm or fix: an empty-shell result can be marked COMPLETE on a retry when a stale summary/aiSummary exists; a stale `aiGenerationError` string persists after a later successful COMPLETE.
- **Frontend**: effect loops, stale closures, optimistic-state clobber on re-render, blob-URL leaks, hydration, i18n keys present in en/ru/uz.
- **Trash/soft-delete**: deleting is soft (kept, recoverable at the data layer) but there is NO restore UI and NO 7-day purge cron — confirm and flag the gap.
- **Quality**: dead code, missing tests for new behavior, maintainability.

## PART B — 100% live Playwright QA
Exhaustively test EVERY feature, owner AND anonymous where relevant. For each: steps, expected vs actual, PASS/FAIL, screenshot. Don't sample — cover all.

**Auth & account**: login (valid + invalid), session persists across nav, logout, signup form + role, password/forgot render.

**Recording & ingest** (where headless allows; else verify UI opens + buttons enable): web recorder dialog opens, mic/system-audio/**camera** toggles, start/stop enable states. Extension sign-in/record (describe headless limits). File import entry points.

**Share page — playback & layout**: video plays (mp4 playlist), seek/speed/volume/fullscreen. Light AND dark. Mobile (≤640px) + desktop. Empty/loading/error states. Owner controls present for owner, absent for guest.

**Share page — captions/CC**: enabling CC shows captions on video, matches selected language, off hides them.

**Share page — transcript (Matn)**: cues render; search filters + highlights + count; copy; download TXT + SRT (clean, no `**`/WEBVTT leak); accordion collapses; clicking chapter TITLE expands without seeking; clicking cue TIME seeks; chapter headers match selected language.

**Share page — summary / chapters / tasks / refined**: summary renders (bold = grey semibold, copy); chapters seek; tasks checkbox PERSISTS across reload for owner, DISABLED for guest; refined transcript accordion + language-correct + **chapter count equals summary chapter count**.

**Share page — multi-language picker**: owner label = video's actual default language; opening lists other languages with "+ generate" and generated ones as instant switches; generating (~30s) switches summary + refined + cues + captions + chapter headers; switching back instant; guest can switch generated languages but has NO generate affordance and translate API returns 403.

**Share page — AI chat**: logged-in → grounded answer with clickable `[h:mm:ss]` citations that seek; long answer bubbles must not overlap and text stays inside the bubble. Anonymous → "sign in to use AI chat" (not a generic error). 429 → calm "busy" message.

**Share page — re-analyze**: owner on a GOOD analysis sees NO alarming panel (only a discreet ⋮ menu with "Qayta analiz"); owner on an incomplete analysis sees a visible re-analyze prompt; guest sees neither.

**Share page — comments / activity / sharing / embed**: comments post + render; activity panel; sharing dialog (public/space/password) saves; embed renders with unblocked controls.

**Dashboard (owner)**: caps list, Spaces, org settings (incl. AI language), members/permissions/activity, analytics, billing/Pro upsell. Nav + mobile hamburger. Every link resolves (no 404s like `/terms`).

**Cross-cutting**: light/dark parity, mobile parity, keyboard/focus, no console errors on key pages, every visible CTA has a working path (walk each screen as a brand-new user — clear at a glance?).

## OUTPUT
1. PART A findings — ranked (CRITICAL/HIGH/MEDIUM/LOW), file:line, defect, failure scenario.
2. PART B results — a table of every feature: PASS/FAIL + evidence (screenshot filename) + note. List every FAIL with repro.
3. A prioritized "must-fix before release" list + final verdict: SHIP / SHIP-WITH-FIXES / DO-NOT-SHIP.
Do not fix anything — review + test + report only.
