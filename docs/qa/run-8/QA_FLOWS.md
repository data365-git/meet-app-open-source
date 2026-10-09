# QA Flows — Ustoz Run 8

## Core journeys

| Journey | Happy path | Required edge states | Run 8 coverage |
|---|---|---|---|
| Anonymous entry | `/` redirects to `/login`; login and signup render | invalid input, keyboard, locale, legal links, auth failure | Live read-only render; no submit |
| Requester access | signup creates an account without an organization; pending screen; admin approve/revoke | duplicate signup, denied access, revoked API keys/session | Code/test evidence only; production writes unsafe |
| Meeting recording | start recorder/extension, capture, stop, multipart finalize, dashboard appearance, full playback | permission denied, picker cancel, offline, service-worker eviction, browser restart, duplicate start, late tail upload | Unit/attack tests; real-device path remains owner-physical |
| Import | local/Loom import, processing, dashboard | invalid file, upload failure, retry/restart | Unverified; production upload unsafe |
| Library | caps/folders/meetings/spaces, open and organize recordings | loading, empty, invalid ID, permissions, delete confirmation | Anonymous invalid-ID only; auth required |
| Public watch | `/s/[videoId]`, player, tabs, transcript/captions, share/embed | private/password/email gate, processing, media failure, mobile, keyboard | Safe live read-only subset if a public ID is available |
| AI | admin starts analysis; results appear; guest AI chat is capped | spend cap, 429, polling, retry, guest limit | No paid/write actions; static and prior-test evidence only |
| Settings/admin | account, members, access, activity, API keys, storage | revoked user, password reset, destructive confirmation, session expiry | Read-only audit; no production mutations |

## Safe live routes

- `/`, `/login`, `/signup`, `/privacy`, `/terms`
- `/api/health` and `/api/status` by a read-only HTTP request
- invalid `/s/<id>` and `/embed/<id>`
- a confirmed public share page: playback, pause/seek, read-only tabs, captions, transcript navigation, mobile/desktop layout, console logs

## Unsafe or inaccessible live actions

- Login attempts, valid signup submit, invitations, approvals, comments, reactions, chat sends, paid AI, imports, uploads, recording, delete, account erasure, settings changes, billing, callback/token flows
- Loading the unpacked extension or granting camera/microphone/screen permissions without owner approval

## Existing automated coverage

- Web: 117 Vitest files discovered in the fresh full run, covering actions, API logic, media processing, transcripts, access, and recorder helpers.
- Extension: focused durability/retry/race tests in `src/background/sw.test.ts` and `upload.test.ts`.
- Playwright: five tests only (`auth.spec.ts`, `share.spec.ts`), desktop Chromium, local port 3001. Credentials and share fixtures are hardcoded/stale-risk; it is not a production-safe suite.

## Product gaps versus test gaps

### Product gaps

- Account deletion does not yet erase the complete data inventory or require the owner-approved typed phrase.
- Meet-tab-only capture can silently fall back to video-only.
- Upload cancellation and repeated restart recovery still have known queue/finalization hazards.

### Test gaps

- No automated real-browser recording/playback-to-end proof.
- No mobile E2E, permission-denied, offline/restart, service-worker eviction, requester approval, import, AI polling, or account-erasure E2E.
- Current live deployment is not the current `94af12d` HEAD, so production browsing cannot prove the newest extension fixes.
