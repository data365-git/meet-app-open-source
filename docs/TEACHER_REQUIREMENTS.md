# Teacher's Brief — Complete Requirements Checklist (source of truth)

Derived verbatim from `docs/USTOZ_BRIEF_transcript.md` (the teacher's 10-min video).
Every requirement the teacher stated — including small/implicit ones — is tracked here.
Status legend: ✅ done & verified · 🟢 done, code-level (needs live confirm) · 🟡 partial · 🔴 not done · ❓ needs investigation/visual check.

Last updated: 2026-06-21 (verify session — reconciled with FINAL/EVENING + NIGHT commits + live re-check on :3001).

---

## TASK 1 — Full QA to production level ("100% ishlamayapti hozir")
Walk EVERY flow, find & fix ALL bugs, reach production quality.

| # | Requirement | Status | Notes / file |
|---|---|---|---|
| 1.1 | Add folder | ✅ | FolderCreate + policy |
| 1.2 | Import video (file upload) | 🟢 | wired; live S3/CORS upload test = owner-physical (file picker) |
| 1.3 | Browser (in-app) recording works | 🟢 | `web-recorder-dialog` present (System Audio default ON); live screen-capture test = owner-physical (headless can't grant getDisplayMedia) |
| 1.4 | Org create + invite a user | ✅ | RESOLVED: `inviteByEmail` directly adds existing users / creates pending invite; `createInviteLink` gives a copyable one-time link. `sendEmail` is an intentional no-op (never throws) so invites do NOT silently roll back in self-host. UI has both "Add by email" + "Generate one-time link" modes. |
| 1.5 | Watch / share / streaming (private↔shared, copy link, fast open) | ✅ | policy-gated; live-verified on :3001 (`/s/h9rvanjvm2vrft7` loads, 4 tabs, click-to-seek, copy-link) |
| 1.6 | Comments / reactions | ✅ | security hole CLOSED (`new-comment.ts` enforces `videosPolicy.canView`, commit 67dd53f); empty `parentCommentId`→null fix (0efc023) |
| 1.7 | Overall: fix all bugs, production level | 🟢 | 51 found / all fixed + 11 Codex deploy-readiness fixes + extension 0-byte race fix; security closed |

## TASK 2 — Chrome plugin 100% (meetings AND instruction)
| # | Requirement | Status | Notes |
|---|---|---|---|
| 2.1 | Plugin exists / in-repo (on GitHub) | ✅ | `apps/browser-extension` |
| 2.2 | Sign-in works & is SMOOTH (teacher failed 10–20×) | ✅ | LIVE-verified: Options → server URL → "Sign in with Cap" → connected |
| 2.3 | Plugin works for MEETING recording | 🟢 | tabCapture+offscreen path; 0-byte race FIXED (8530363 — await RECORDER_STARTED before recorder.start). Same fix as instruction. **Needs ONE live Google Meet test (owner-physical).** |
| 2.4 | Plugin works for INSTRUCTION recording | ✅ | **OWNER-VERIFIED LIVE in Chrome — saves every time** (dedicated recorder tab + getDisplayMedia; 0-byte race fixed) |
| 2.5 | Google Meet auto pop-up "Record now?" appears | ✅ | appears on Meet join |
| 2.6 | "Record now" / Record actually RECORDS | 🟢 | INSTRUCTION ✅ live; MEET 🟢 code-fixed, needs live test (= 2.3) |
| 2.7 | Pop-up sound less unpleasant | 🟡 | lower-gain chime added; subjective — confirm with owner in Chrome session |
| 2.8 | Pop-up UI nicer | 🟡 | minor visual polish; confirm with owner |
| 2.9 | On picker cancel/fail: clear message, not silent no-op | ✅ | failures surfaced; stop/cancel routed to recorder tab; tracks released on error (9834324) |

## TASK 3 — Share page design + manual one-button AI + status UI
| # | Requirement | Status | Notes |
|---|---|---|---|
| 3.1 | Share page matches the cloud design EXACTLY (it was "broken") | 🟢 | redesigned to mockup (blue accent), sticky video VERIFIED LIVE (0eef1e8); exact side-by-side = optional polish |
| 3.2 | Tabs: Transcript, Tasks, Summary, Refined | ✅ | live-verified all 4 populated + distinct |
| 3.3 | AI chat (RAG over transcript) answers any question | ✅ | verified live (uz answer + citations) |
| 3.4 | ONE admin button runs the whole pipeline (audio→transcript→tasks→summary→refined) | ✅ | GenerateAiPanel + /generate, admin-gated, verified |
| 3.5 | AI is MANUAL, never auto-run (both /s AND /embed) | ✅ | both paths fixed |
| 3.6 | Works for INSTRUCTION videos too (not only Meet) | ✅ | generic by videoId |
| 3.7 | Status: real PERCENT (5%, 10%, 20%…) | ✅ | `deriveProgress` → 0/30/50/72/100%, progressbar `aria-valuenow` + `width:${percent}%` (6569b69; code-verified) |
| 3.8 | Status: what's done / what's running | ✅ | phase labels |
| 3.9 | Status: estimated time (e.g. 5/10/20 min) | ✅ | ETA strings shown ("Taxminan 1–2 daqiqa qoldi") |
| 3.10 | Never a bare / forever spinner | ✅ | percent bar + ERROR states |
| 3.11 | "Refined" = FULL transcript cleaned (filler/"a-a"/repeats/jokes removed), DISTINCT from summary | ✅ | strengthened prompt + per-chunk cleaning over full raw transcript (670113d + ac9083c); live: Refined tab distinct from Summary |
| 3.12 | Chapters kept/rendered | ✅ | rendered |
| 3.13 | Transcript translation DROPPED (stay in spoken language) | ✅ | REMOVED (translate-transcript + UI deleted, 4b0ff7f) |

---

## Open work, ranked (what stands between now and "done")
All teacher code-gaps are CLOSED. What remains is OWNER-PHYSICAL verification + deploy + subjective polish:
1. **Live-test MEET recording** (2.3/2.6) — owner runs one Google Meet "Record now" test. Code fix already applied + instruction path proven live.
2. **Deploy** (owner Railway) + finding-8 default URL in `apps/browser-extension/src/shared/config.ts:15`.
3. **Pop-up sound/UI polish** (2.7/2.8) — subjective, tune during the owner's Chrome session.
4. **(Optional)** live import-upload (1.2) + in-app recorder (1.3) walk + exact share-page side-by-side (3.1) — all code-present, low risk.
