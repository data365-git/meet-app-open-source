# QA_FLOWS — cap-v2 (Ustoz) — RUN 6 (Contabo prod)

Analysis-only map. Source: App Router tree `apps/web/app/**`, share components `apps/web/app/s/[videoId]/_components/**`. Focus of the DRIVEN portion = anonymous, prod-safe surfaces; auth-gated tree mapped but marked `Unverified` (see QA_PLAN COVERAGE PRE-FLIGHT).

---

## Table A — Platform Map

| Area | Screen/Route | Entity | Main user actions | Related screens | Risk |
|---|---|---|---|---|---|
| Entry | `/` | — | redirect (→ login or dashboard) | /login | High |
| Auth | `/(org)/login` | Session | credentials login, Google OAuth, OTP | /signup, /dashboard | Critical |
| Auth | `/(org)/signup` | User | register | /login | High |
| **Share (CORE)** | **`/s/[videoId]`** | Video | watch, seek, read AI summary/tasks/chapters/transcript, chat, switch language, (owner) replace-with-audio | /embed, /s/[id]/edit | **Critical** |
| Share edit | `/s/[videoId]/edit` | Video | rename/trim (owner) | /s/[id] | High |
| Embed | `/embed/[videoId]` | Video | watch (iframe) | /s/[id] | Medium |
| Legal | `/privacy`, `/terms` | — | read | footer | Low |
| Invite | `/invite/[token]` | Invite | accept org invite | /login | High |
| Dashboard | `/(org)/dashboard` | Org/Video | list caps, folders, spaces | caps, meetings | Critical (Unverified) |
| Record | `/(org)/dashboard/caps/record` | Recording | screen record → upload | caps | Critical (Unverified) |
| Import | `/(org)/dashboard/import/{file,loom}` | Video | upload file / import Loom | caps | High (Unverified) |
| Meetings | `/(org)/dashboard/meetings` | Video | list meetings | share | High (Unverified) |
| Caps CRUD | `/(org)/dashboard/caps` | Video | list, open ⋮ (delete, replace-with-audio) | share | Critical (Unverified) |
| Settings | `/(org)/dashboard/settings/**` | Org/User | members, permissions, storage, workspace | — | High (Unverified) |
| Analytics | `/(org)/dashboard/analytics`, `/billing/ai-spend` | Usage | view spend/analytics | — | Medium (Unverified) |
| Admin | `/admin/**` (replace-video, reprocess-video, reset-password) | Video/User | admin ops | — | High (Unverified) |
| Messenger | `/messenger`, `/messenger/[id]` | Message | chat | — | Medium (Unverified) |
| API | `/api/health`, `/api/playlist`, `/api/videos/:id/*`, `/api/cron/*` | — | health, playback, AI, cron | — | Critical |

## Table B — Entity Lifecycle Matrix

| Entity | Create | Read/List | Edit | Delete/Archive | Manage/Configure | Missing logic | Priority |
|---|---|---|---|---|---|---|---|
| Video (Cap) | ✅ record/import (Unverified) | ✅ dashboard list + share (share driven) | ⚠️ rename/trim (Unverified) | ✅ delete recording (Unverified, unsafe) | ✅ replace-with-audio T4b (owner ⋮; Unverified) | replace-with-audio irreversible — confirm dialog present (code) | Critical |
| AI analysis | ✅ generate (paid; Unverified) | ✅ tabs on share (driven) | ⚠️ re-analyze (Unverified) | ❌ no delete of analysis alone | ✅ Tez/Arzon speed mode (Unverified) | old videos show "Boshqa" until re-analyzed (known) | Critical |
| Chat (RAG) | ✅ ask (Unverified — sends to Gemini) | ✅ history on share (driven UI) | — | ⚠️ no clear-chat affordance (known) | — | dead i18n keys aiChatTitle/aiClearChat | Medium |
| Session/User | ✅ signup (Unverified) | — | ✅ settings (Unverified) | — | — | — | High |
| Org/Members | ✅ invite (Unverified) | ✅ members (Unverified) | ✅ roles (Unverified) | ✅ remove (Unverified) | ✅ permissions | — | High |

## Table C — Flow Inventory (execution list for Step 3)

| # | Flow | Trigger | Steps | Expected result | Oracle | Risk (L×I) | Edge cases | Gap type | Critical? | Smoke? |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Health endpoint | GET /api/health | load | `{status:ok, checks:{db:ok,storage:ok}}` | Purpose/Spec | L×H | db/storage down | H | YES | YES |
| F2 | Root redirect | GET / | load | redirect to /login (anon) or dashboard | User expect | M×H | already-auth | C | YES | YES |
| F3 | Login page render | GET /login | load | form (email/pwd) + Google + OTP visible, no console err | Consistency | M×C | dark, mobile, RTL name | H | YES | YES |
| F4 | Share page render (valid id) | GET /s/<id> | load | video title + player + AI tabs render, network 200, no console err | Spec/Purpose | M×C | slow AI, no-AI video | C | YES | YES |
| F5 | Share player playback | /s/<id> → play | click play | video plays from R2 (readyState≥3, currentTime advances) | Purpose | M×H | HLS vs mp4, audio-only | H | YES | YES |
| F6 | AI tabs switch | /s/<id> tabs | click Xulosa/Vazifalar/Transkript/Matn | each tab renders content; deep-link `?tab=` | Consistency | M×H | empty/processing state | H | — | YES |
| F7 | Transcript timestamps | /s/<id> Transkript | click a timestamp | player seeks to that time | Purpose | M×M | 0s, end, missing vtt | H | — | — |
| F8 | Chat UI (no send) | /s/<id> chat | open chat variant | FAB/inline opens dialog; input present; does NOT auto-send | Consistency | M×M | ?variant=modal/inline | I | — | — |
| F9 | Dock / slim bottom bar | /s/<id> scroll player off-screen | scroll | slim control bar appears (play/seek/title/expand/close), NO stray video pixels | User expect/History | M×H | mobile vs desktop, audio | I | — | YES |
| F10 | T4b owner-gating leak-check | /s/<id> anon | inspect | replace-with-audio control hidden/inert for anon (no owner action leak) | Spec/Security | L×H | a11y tree exposure | F | YES | YES |
| F11 | Language picker | /s/<id> | switch uz/ru/en | UI strings change; no crash | Consistency | L×M | missing key fallback | H | — | — |
| F12 | Legal pages | /privacy, /terms | load | content renders (not 404) | Spec | L×L | — | C | — | — |
| F13 | Embed view | /embed/<id> | load | player renders in iframe context | Purpose | L×M | invalid id | C | — | — |
| F14 | Invalid share id | /s/doesnotexist | load | clean not-found, not a 500/crash | Error-handling | M×H | empty id, `../`, injection | H | YES | YES |
| F15 | 404 route | /nonexistent | load | not-found page, no crash | Error-handling | L×M | — | H | — | YES |
| F16 | Password/Auth overlay | /s/<protected-id> | load | password/otp overlay gates content | Security | L×H | (no known protected id) | F | — | — |
| — | Dashboard/record/import/settings/admin | login | — | — | — | — | — | — | Unverified | — |

## Table D — Technique-Derived Cases

| Target (field / entity) | Technique | Derived cases to run | Expected |
|---|---|---|---|
| Share `videoId` path param | Equivalence + Boundary + Malicious | valid id · empty `/s/` · nonexistent `/s/zzzzzzzzzzzzz` · special `/s/..%2f..` · injection `/s/' OR 1=1` · very-long 200-char | valid → renders; all invalid → clean 404/not-found, never 500/stacktrace |
| `?tab=` query on share | Equivalence | `?tab=summary` · `?tab=tasks` · `?tab=transcript` · `?tab=chat` · `?tab=bogus` | known → that tab; bogus → safe default, no crash |
| `?variant=` chat | State/pairwise | `?variant=modal` · `?variant=inline` · none | modal→FAB dialog; inline→in-body; none→default |
| Language × theme (share) | Pairwise | (uz,light) (ru,dark) (en,mobile) | strings + theme consistent, no missing-key literal shown |
| Login email field | Boundary + Malicious | empty · very-long · emoji · `' OR 1=1` · no-@ | invalid → inline validation, no 500 (render/validation only — NO submit that could lock accounts) |
| Player state (share) | State-Transition | play→pause→seek(0)→seek(end)→replay | each transition valid; no dead controls after dock |
| T4b control (anon) | State/Security | anon load → find owner control in DOM/a11y | present-but-inert only; no functional leak |

## Gaps found in mapping (pre-drive)
- **F10/T4b (Gap F):** prior runs noted the hidden T4b button stays in the a11y tree (no `aria-hidden`) — potential Low a11y/leak. Verify this run.
- **Chat (Gap A/I):** no clear-chat affordance anywhere; dead i18n keys `aiChatTitle`/`aiClearChat`.
- **AI state sync (Gap D):** old videos display category "Boshqa" until re-analyzed — stale until action.
- **`logic-hole`:** none newly identified from anonymous surface; decision-table for AI-speed (Tez/Arzon) is Unverified (auth+paid).
- **Auth-gated tree (untestable this run):** all dashboard/record/import/settings/admin CRUD marked `Unverified` — NOT a claim of correctness.

---
**Counts:** Table C rows = 16 driven-scope (+1 Unverified auth cluster). Critical = F1,F2,F4,F10,F14 (+F16). High-risk = F3,F5,F6,F9. Smoke = F1,F2,F3,F4,F5,F6,F9,F10,F14,F15 (10). Derived-case targets (Table D) = 7. logic-holes = 0 new. Gap types present: A, D, F, H, I.
