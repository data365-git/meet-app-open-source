# data365 Final QA Report

Generated: 2026-07-01 02:28 Europe/Warsaw  
Target: https://capweb-production-dd85.up.railway.app  
Primary share video: `/s/2t4a58an7acz3bb`; long-video chat pass: `/s/xqmcnsvq66m5yt6`

## Gate Results

| Gate | Result | Evidence |
|---|---:|---|
| `pnpm tsc -b` | PASS | Exit 0. |
| `pnpm --filter @cap/web run test` | PASS | Vitest suite exit 0. |
| `pnpm --filter @cap/web build` | PASS with warning | Build exit 0; Turbopack warned that `next.config.mjs -> lib/audio-extract.ts -> workflows/transcribe.ts -> lib/transcribe.ts -> api/videos/[videoId]/generate` traces unexpectedly broad filesystem state. |

## Part A - Static Review Findings

### HIGH

1. `apps/web/app/s/[videoId]/_components/ShareVideo.tsx:802`, `apps/web/app/s/[videoId]/_components/AIChatPopup.tsx:288`, `apps/web/app/s/[videoId]/_components/AIChatPopup.tsx:551`, `apps/web/app/api/video/ai/chat/route.ts:125-128`  
   Defect: anonymous users can open the full AI chat panel and type into the input, but the server rejects chat with `401 Unauthorized`.  
   Failure scenario: a guest clicks the floating `data365 AI` button on a public share page, sees prompt suggestions and a textarea, submits a question, then receives an auth failure instead of the required "sign in to use AI chat" state. Live evidence: `docs/qa-screenshots/23-targeted-anon-ai-chat.png`; targeted API returned `401 {"error":"Unauthorized"}`.

2. `apps/web/lib/translate-ai.ts:507-516`, `apps/web/lib/translate-ai.ts:537`, `apps/web/lib/translate-ai.ts:579`, `apps/web/lib/translate-ai.ts:595`  
   Defect: translation metadata updates are read-modify-write JSON writes with no compare-and-swap, row lock, JSON patch, or transaction.  
   Failure scenario: owner starts RU and EN generation close together; both workers read the same metadata, then the later completion overwrites the earlier language's `aiTranslationStatus`, `aiSummaryByLanguage`, or `transcription.{lang}.vtt` pointer status. This causes silent loss of generated AI work and can leave a language appearing ungenerated or stuck.

3. `apps/web/app/api/video/metadata/route.ts:27-64`  
   Defect: editable video metadata is merged into a stale full JSON object and written back wholesale.  
   Failure scenario: owner edits title/default language while AI generation, task state, or translation completion writes metadata. The last writer can drop concurrent fields such as `aiSummaryByLanguage`, `aiGenerationStatus`, task completion state, or generated title because the update spreads the earlier `result.metadata`.

### MEDIUM

4. `apps/web/app/(org)/login/form.tsx:111-200`  
   Defect: the login page has valid credential fields and signup/terms/privacy links, but no visible forgot-password or OTP recovery path.  
   Failure scenario: a legitimate user who forgot a password cannot self-recover from `/login`, failing the required password/forgot-flow release criterion. Live evidence: `docs/qa-screenshots/05-auth-forgot-password-flows-render.png`.

5. `apps/web/app/api/settings/billing/guest-checkout/route.ts:5-24`  
   Defect: unauthenticated billing checkout accepts caller-supplied `priceId` and `quantity` and creates a Stripe Checkout session without local allow-list validation.  
   Failure scenario: an unauthenticated caller can create checkout sessions against arbitrary Stripe price IDs or extreme quantities if Stripe accepts them. I did not execute billing/payment per safety rules.

6. `apps/web/app/api/video/ai/chat/route.ts:153-155`  
   Defect: 429 returns raw `"Rate limit exceeded"` JSON; the UI path was not observed to convert this into the required calm busy message.  
   Failure scenario: during a Gemini/rate-limit spike, users see a generic failure instead of an actionable "busy, try again" message.

### LOW

7. `apps/web/app/(org)/login/form.tsx:165-172`  
   Defect: invalid credentials work, but the automation initially missed the Uzbek-only message because there is no stable alert/test id.  
   Failure scenario: future localization/style changes can break auth regression automation. Live screenshot proves current user-visible error works: `docs/qa-screenshots/01-auth-invalid-credentials.png`.

8. `apps/web/next.config.mjs` build trace warning via `apps/web/lib/audio-extract.ts`  
   Defect: production build warns that Turbopack traced broad filesystem state through the AI generation route.  
   Failure scenario: deployment artifact can become oversized or include unintended files if the dynamic path usage is not constrained.

## Part B - Live Playwright QA Matrix

| Feature | Result | Evidence | Notes |
|---|---:|---|---|
| Valid login | PASS | `docs/qa-screenshots/02-auth-valid-owner-login-session.png` | Owner login succeeded; `/api/video/ai?videoId=2t4a58an7acz3bb` returned 200. |
| Invalid login | PASS | `docs/qa-screenshots/01-auth-invalid-credentials.png` | Shows `Email yoki parol noto'g'ri.` |
| Session persistence | PASS | `docs/qa-screenshots/03-auth-session-persists-across-navigation.png` | Session survived dashboard/share navigation. |
| Logout | PASS | `docs/qa-screenshots/22-auth-logout.png` | Signout path reachable. |
| Signup form + role assignment | PASS | `docs/qa-screenshots/04-auth-signup-form-renders-role-assignment-path.png` | Signup fields render; static review confirms self-signup joins default org as `member`, never admin. |
| Forgot/password flow | FAIL | `docs/qa-screenshots/05-auth-forgot-password-flows-render.png` | No forgot-password/OTP recovery affordance visible on login. |
| Web recorder UI | PASS | `docs/qa-screenshots/19-recording-and-ingest-entry-points.png` | Recorder page renders expected controls; actual capture is headless/browser-permission limited. |
| Extension record/sign-in paths | SKIPPED | `docs/qa-screenshots/19-recording-and-ingest-entry-points.png` | Browser extension flows cannot be exercised in headless Chromium against the live web app. |
| File/Loom import entry points | PASS | `docs/qa-screenshots/19-recording-and-ingest-entry-points.png` | `/dashboard/import` exposes import options. |
| Share playback/layout desktop | PASS | `docs/qa-screenshots/06-share-playback-layout-guest-desktop.png` | Public share page renders video and controls. |
| Play/seek/speed/volume | PASS | `docs/qa-screenshots/07-share-playback-play-seek-speed-volume-fullscreen-controls.png` | Video duration ~64s; HTML5 seek, playbackRate 1.5, volume applied. Fullscreen API is headless/browser-gated. |
| Mobile share viewport | PASS | `docs/qa-screenshots/08-share-layout-mobile-viewport.png` | Mobile view renders without server error. |
| Dark theme parity | FAIL | `docs/qa-screenshots/09-share-layout-dark-theme.png` | `emulateMedia({ colorScheme: "dark" })` still produced light shell; body background `rgb(242, 242, 242)`. |
| Empty/loading/error states | PARTIAL | `docs/qa-screenshots/16-ai-chat-anonymous-sign-in-prompt.png` | Loading spinner observed during media optimization; no destructive/error-state mutation performed. |
| Owner controls vs guest | PASS | `docs/qa-screenshots/10-share-owner-controls-visible-guest-controls-hidden.png` | Owner sees share/status/overflow controls. Guest has public share/download only; no delete/edit owner action observed. |
| Captions/CC | PASS | `docs/qa-screenshots/23-targeted-anon-ai-chat.png` | CC toggle is present (`Taglavhalarni yoqish`); captions are backed by translated transcript cues. Full visual caption text overlay was not stable in headless screenshot. |
| Transcript renders/search/copy/download | PASS | `docs/qa-screenshots/11-transcript-tab-renders-search-copy-download-affordances.png` | Transcript tab shows search, Copy, TXT, SRT; no visible `WEBVTT`/`**` leakage. Clipboard write throws in headless without permission. |
| Transcript accordion | PASS | `docs/qa-screenshots/13-summary-chapters-tasks-refined-panels-render.png` | Chapters start as rows with chevrons and timestamps. Selector miss in first run was automation-only. |
| Summary tab | PASS | `docs/qa-screenshots/13-summary-chapters-tasks-refined-panels-render.png` | `Xulosa` tab present. |
| Chapters seek | PARTIAL | `docs/qa-screenshots/13-summary-chapters-tasks-refined-panels-render.png` | UI affordance visible; precise title-vs-time seek distinction was not reliably automated. |
| Tasks owner persist/read-only guest | PARTIAL | `docs/qa-screenshots/14-tasks-owner-toggle-persists-guest-read-only.png` | Task tab present; the automated toggle selector missed localized controls, so persistence was not conclusively verified live. |
| Refined transcript | PASS | `docs/qa-screenshots/13-summary-chapters-tasks-refined-panels-render.png` | `Tozalangan matn` tab present. |
| Language picker owner | PASS | `docs/qa-screenshots/15-language-picker-owner-guest-behavior-guest-translate-403.png` | Owner label shows `O'zbekcha`; generation/switching affordance text present. |
| Language picker guest | PASS | `docs/qa-screenshots/15-language-picker-owner-guest-behavior-guest-translate-403.png` | Guest translate POST returned 403; no visible generate affordance. |
| Generated language switching | PARTIAL | `docs/qa-screenshots/15-language-picker-owner-guest-behavior-guest-translate-403.png` | Existing Uzbek/Russian content visible; I did not force a new paid language generation because the video already had generated language data and the UI state was sufficient for authz checks. |
| AI chat logged-in long answer | PASS | `docs/qa-screenshots/17-ai-chat-logged-in-grounded-answer-citations-on-long-video.png` | Long-video prompt streamed an answer with timestamp-like citations; bubble layout did not overlap in screenshot. |
| AI chat anonymous prompt | FAIL | `docs/qa-screenshots/23-targeted-anon-ai-chat.png` | Guest sees full chat panel and input, not a sign-in prompt; API returns 401. |
| AI chat 429/busy path | PARTIAL | `docs/qa-screenshots/17-ai-chat-logged-in-grounded-answer-citations-on-long-video.png` | Route has a 429 branch, but I did not force production rate limit. Static finding notes message gap. |
| Comments/activity | PASS | `docs/qa-screenshots/18-comments-activity-sharing-embed-render.png` | Activity/comment panel renders. I did not post a real comment to avoid polluting owner data. |
| Sharing dialog | PASS | `docs/qa-screenshots/10-share-owner-controls-visible-guest-controls-hidden.png` | Share/status controls render. I did not save public/space/password mutations on real data. |
| Embed view | PASS | `docs/qa-screenshots/18-comments-activity-sharing-embed-render.png` | `/embed/2t4a58an7acz3bb` renders media. |
| Dashboard caps/spaces/settings/members/activity/analytics/billing | PASS | `docs/qa-screenshots/20-dashboard-owner-pages-and-links-resolve.png` | Checked `/dashboard/caps`, `/dashboard/spaces/browse`, org settings/members/activity, analytics, billing: all 200. |
| Terms/privacy links | PASS | `docs/qa-screenshots/20-dashboard-owner-pages-and-links-resolve.png` | `/terms` and `/privacy` return 200. |
| Console errors | FAIL | `docs/qa-screenshots/21-cross-cutting-console-errors-on-key-pages.png` | Captured invalid-login 401 resource and clipboard write failures on share pages. The 401 is expected network behavior; clipboard errors should be handled silently/toast. |
| Keyboard/focus | PARTIAL | `docs/qa-screenshots/05-auth-forgot-password-flows-render.png` | Login fields focus; broader keyboard traversal was not exhaustively asserted. |
| New-user clarity | FAIL | `docs/qa-screenshots/05-auth-forgot-password-flows-render.png`, `docs/qa-screenshots/23-targeted-anon-ai-chat.png` | Missing recovery path and anonymous AI input undermine first-run clarity. |

## Failed Repros

1. Forgot/password flow missing: open `/login`; observe email/password fields, signup link, terms/privacy, but no forgot-password/OTP recovery link.
2. Anonymous AI chat mismatch: open `/s/2t4a58an7acz3bb` in a fresh context; click the floating bottom-right AI button; observe full chat UI and input. POST `/api/video/ai/chat` as guest returns 401.
3. Dark theme parity: load `/s/2t4a58an7acz3bb` with Chromium dark color scheme; page shell remains light (`rgb(242,242,242)` body).
4. Clipboard console errors: open share page in headless/default browser permissions; clicking/copying paths triggers `Failed to execute 'writeText' on 'Clipboard': Write permission denied.`

## Must Fix Before Release

1. Add a guest-specific AI chat state: either hide/disable the input with a localized sign-in CTA, or allow chat intentionally with rate/cost controls. Current UI and API disagree.
2. Add a visible forgot-password/OTP recovery route from `/login`, or remove the release requirement and product copy promising recoverability.
3. Replace wholesale metadata JSON writes with atomic JSON patching/transactional compare-and-swap for AI translation, AI generation, task state, and user metadata edits.
4. Fix dark-theme parity on share pages and verify screenshots for desktop/mobile.
5. Catch clipboard permission failures and show a non-error fallback/toast; do not emit unhandled console errors.
6. Validate guest checkout `priceId`/`quantity` against an allow-list before creating Stripe sessions.
7. Add stable Playwright selectors/test ids for share tabs, transcript accordions, tasks, language picker, and AI chat auth state.

## Verdict

**SHIP-WITH-FIXES**

Do not ship as a polished final release until the must-fix list is addressed. Core playback, login, dashboard navigation, owner AI chat, translation authz, public share viewing, transcript rendering, and embed all work on the live deployment. The blockers are concentrated in release-readiness and data-integrity risk: guest AI chat UX, missing recovery flow, metadata write races, dark-mode parity, and unhandled clipboard errors.
