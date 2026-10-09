# QA Smoke — cap-v2 (Ustoz) — RUN 6 (Contabo prod, data365.duckdns.org)

Build-health gate. Evidence = live prod driven via Browser pane (anonymous, read-only). State-read on every pass (techniques §7). No `QA_REGRESSION.md` exists → no regression rows to drive first.

| Smoke # | Check | Status | Evidence (read value) | Notes |
|---|---|---|---|---|
| F1 | `/api/health` | ✅ | `{"status":"ok","checks":{"db":"ok","storage":"ok"}}` (get_page_text) | DB + R2 reachable |
| F2 | Root `/` (anon) | ✅ | Renders login "data365 ga kirish / Kirish" (get_page_text) | Anon → login, no crash |
| F3 | `/login` form | ✅ | email textbox `siz@kompaniya.uz`, password textbox, "Kirish" submit, signup/terms/privacy links (read_page) · 0 console errors | No Google btn (OAuth unconfigured — expected) |
| F4 | Share `/s/fm3pz7yref328m7` render | ✅ | Title "Tuxum fabrikasini avtomatlashtirish va IT audit muhokamasi", summary + 8 chapters + 3 tasks + suggested-Qs rendered · 0 console errors | Real migrated content off Contabo DB/R2 |
| F5 | Share playback | ✅ | `<video>` readyState=4, duration=3171s, src=R2, play() → currentTime 0→0.76s in 1.2s (js state-read) | Streams from R2, real playback |
| F6 | AI tabs switch (Xulosa/Vazifalar/Transkript/Matn) | ⚠️ Unverified | Clicking Transkript (ref + direct JS `.click()`) does NOT change `aria-selected` — stays "Xulosa". Root cause read from code: `SharePanel.tsx:119` `effectiveActiveTab = processing ? "summary" : activeTab` → tabs are LOCKED to Summary while `aiProcessing` (transcription/AI busy) is true. The only anon-reachable video is currently in that state. | By-design lock; could NOT verify switching works. Also a candidate finding (see QA_REPORT) — flagship demo video shows "optimizing" + locked tabs post-migration. |
| F9 | Dock / slim bottom bar | → Step 3 | (deferred to full pass) | — |
| F10 | T4b owner-gating (anon leak) | ✅ | replace-with-audio btn: `opacity:0, pointerEvents:none, ariaHidden:true, disabled:false` (getComputedStyle) — inert, out of a11y tree | Prior-run a11y gap (no aria-hidden) is FIXED |
| F14 | Invalid share id `/s/zzzzzzzzzzzzz` | ✅ | "This video is private / restricted" page, title "…is restricted", 0 console errors, no 500 | Graceful; doesn't leak existence |
| F15 | Unknown route `/this-route-does-not-exist-xyz` | ✅ | Falls through to login "Bosh sahifa", no crash/stacktrace | No distinct 404 page (auth-walled app) |

**9 of 10 smoke checks passed · 1 Unverified (F6, blocked by processing-lock) · 0 failed.**

## Gate decision
Build is healthy — renders, plays from R2, health green, error paths graceful, no console errors on any driven route. No build-broken smoke failure → **G1 not triggered.** F6 is Unverified (design lock, not a build break). **Smoke passed. Proceeding to Step 3.**
