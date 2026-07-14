# QA Report — cap-v2 (Ustoz) — RUN 6 (Contabo prod `data365.duckdns.org`) — 2026-07-13

Target: LIVE PRODUCTION deploy (Contabo/Coolify). Evidence: Browser pane against the public URL — DOM state-reads, computed styles, network, console, a control IntersectionObserver — plus code root-cause reads. Anonymous/read-only only (prod safety; no writes/deletes/AI-runs). Every verdict below is backed by a read state value, not a screenshot (screenshots timed out — renderer busy with the video/backdrop-blur; state-reads are the stronger evidence per techniques §7).

## Coverage
- **Flows total (Table C driven-scope): 16** (+ 1 large Unverified auth cluster: entire dashboard/record/import/settings/admin tree).
- **Driven with evidence: 12 (75%)** — F1,F2,F3,F4,F5,F8,F10,F11,F12,F13,F14,F15.
- **Partially driven / blocked by app state: 2 (12%)** — F6 (tabs locked by processing), F9 (dock not activating).
- **Unverified (needs real auth / non-processing video / real device): ~13% of driven-scope + the ENTIRE auth-gated app** — login-required CRUD, recorder capture, paid AI runs, T4b server-side authz, RAG chat actual answer, language-switch effect.
- ⚠️ **STEADY-STATE CAVEAT (oracle-flagged):** the only anon-reachable video (`fm3pz7yref328m7`) is in the **"optimizing/processing"** state. Several PASSes are valid only for that state; a fully-processed (COMPLETE) video was NOT reachable anonymously, so steady-state tab-switching + dock were not confirmable.

## Results

| Flow # | Name | Status | Oracle | Evidence / state value read | Notes | Critical? | Gap |
|---|---|---|---|---|---|---|---|
| F1 | /api/health | ✅ | Purpose | `{status:ok, checks:{db:ok,storage:ok}}` | DB+R2 healthy | Y | — |
| F2 | Root `/` anon | ✅ | User-expect | login "data365 ga kirish" rendered, 0 console err | anon→login | Y | — |
| F3 | /login form | ✅ (note) | Consistency | email+password textbox, "Kirish" submit, 0 err | forgot-pwd = `mailto:` personal gmail (Low) | — | H |
| F4 | Share render | ✅ | Spec | real title + summary + 8 chapters + 3 tasks, 0 err | off Contabo DB/R2 | Y | — |
| F5 | Playback | ✅ | Purpose | video readyState=4, dur 3171s, R2 src, play→ct 0→0.76s | steady-state playback | Y | — |
| F6 | AI tabs switch | ❌ | Consistency/User-expect | click Transkript (UI + JS `.click()`) → aria-selected stays "Xulosa"; "optimizing" label true; chat enabled (transcript ready) | **tabs are locked to summary while AI-gen marked processing (`SharePanel.tsx:119`) — but they still LOOK clickable → dead-click, no disabled cue/feedback.** Transcript exists yet is unreachable. | Y | H/D |
| F8 | Chat UI (no send) | ⚠️ Unverified | Consistency | textarea present, enabled, ph "AI ga savol bering…" | not sent (safety); enabled DURING processing = inconsistent state, may error on unanalyzed video | — | I |
| F9 | Dock / slim bar (mobile) | ❌ | History/User-expect | played + scrolled off (top −735, isPlaying), wrapper stayed `position:relative`; NO `fixed bottom-2` bar. Control fresh IO on same slot DID fire (isIntersecting:false) → env OK, app-side non-activation | owner-prioritized feature; caveat = only tested on processing video | — | I |
| F10 | T4b anon-gating | ✅ (caveat) | Spec/Security | replace-with-audio btn opacity:0, pointer-events:none, **aria-hidden:true**, disabled:false | anon can't see/click; prior a11y gap FIXED. **Server-side authz for the mutation UNVERIFIED** (client-hide ≠ access control) | Y | F |
| F11 | Language picker | ✅ (shallow) | Consistency | "Til sozlamalari" button present; no raw i18n key leak in body | switch EFFECT not exercised → functionally unverified | — | — |
| F12 | /terms | ✅ | Spec | "Terms of Service", real dated ToS content | prior footer-404 now renders | — | — |
| F13 | /embed/[id] | ✅ | Purpose | `<video>` readyState=4, minimal embed | works | — | — |
| F14 | Invalid/malicious ids | ✅ | Error/Security | `/s/zzz…`, `/s/' OR 1=1`, `/s/..%2f..%2fetc%2fpasswd` → clean "restricted", no 500/leak/stacktrace | injection + traversal safe (strong) | Y | — |
| F15 | Unknown route | ✅ (note) | Error | `/this-route…xyz` → falls to login, no crash | no distinct 404 (soft-wrong, Low) | — | H |
| — | Auth-gated tree (dashboard/record/import/settings/admin) | ⏭️ Unverified | — | not reachable anon; unsafe on prod | NOT a claim of correctness | — | — |

## Summary
- Total driven-scope flows: 16
- Passed ✅: 10 (F1,F2,F3,F4,F5,F10,F11,F12,F13,F14)  · of which 2 shallow/caveated (F10 server-authz, F11 effect)
- Failed ❌: 2 (F6, F9)
- Unverified ⚠️/⏭️: 4 (F8 chat-send, F15-as-404 nit is a pass, language-effect, entire auth tree)

## Prioritised failures (most severe first)
1. **[High] F6 — Flagship demo video: Transkript / Vazifalar / Matn tabs are dead-locked with no feedback.** On `/s/fm3pz7yref328m7` only "Xulosa" is reachable; the other tabs still look clickable but swallow clicks (aria-selected never moves). Root: `SharePanel.tsx:119` forces summary while `aiProcessing` (AI-generation status = QUEUED/PROCESSING) — yet the full summary/chapters/tasks already render and the transcript is ready (chat is enabled). So the AI-gen status is stale/stuck (or a re-analysis is re-running) on a video that visibly has its output. **Impact:** any viewer (incl. the IT team seeing the demo) cannot open the transcript/tasks/refined-text; the page reads as "optimizing" indefinitely. **Repro 3/3** across reloads. **Two sub-issues:** (a) stuck/re-processing status on a done video — owner/admin should check this video's AI status in the dashboard and re-analyze or use "continue-paid"; (b) design: locked tabs give no disabled cue → dead-click; and a genuinely-ready transcript shouldn't be hidden just because AI *generation* re-runs.
2. **[Medium–High] F9 — Docked slim control bar never appears (mobile).** Playing player scrolled fully off-screen → no `fixed bottom-2` mini-bar; wrapper stayed `relative`. A control IntersectionObserver on the same slot fired correctly → not a headless artifact; the app did not activate the dock under its own trigger. Owner specifically chose this feature. Caveat: only testable on the processing-state video → **re-confirm on a fully-processed video on a real phone before final sign-off.**
3. **[Low] F3 — "Parolni unutdingizmi?" is a `mailto:` to a personal Gmail** (`mirkomilovabrorwork@gmail.com`), not a real reset flow; also publicly exposes the owner's personal email.
4. **[Low] F15 — No distinct 404** (unknown routes fall through to login/home; likely 200 for a non-existent path).
5. **[Info/Low] F10 — Owner control is CSS-hidden + still in DOM;** anon visibility is correctly gated (incl. aria-hidden) but the **server-side rejection of the replace-with-audio mutation for a non-owner is UNVERIFIED** (couldn't test safely on prod). Confirm the action is authz-guarded server-side, not just hidden.

## Strong positives (evidence-backed)
- Health green (db+storage) on the migrated Contabo stack; real content served off the migrated DB + R2.
- Steady-state playback from R2 solid (readyState 4, currentTime advances).
- Input handling safe against SQLi + path-traversal (clean "restricted", no 500/leak).
- T4b anon a11y-gating fixed (aria-hidden now present — prior Low resolved).
- 0 console errors on every driven route; no raw i18n key leaks; legal pages render; embed works.

## Independent oracle review
- **Agreements:** F1,F2,F4,F5,F12,F13,F14 PASS; F3/F15 PASS-with-Low-note. **10 agreements.**
- **Disagreements the oracle raised → adopted (driver did NOT overrule in its own favour):**
  - **F6:** oracle rejected any "by-design, so PASS" framing — a click-eating control with no feedback is a **High UX defect**, not a pass. → Report grades F6 **❌ High** (was leaning "Unverified-by-design").
  - **F9:** oracle killed the "processing state exonerates it" excuse (control IO proves the mechanism works) → stays **❌** pending a processed-video re-test, not Unverified-away.
  - **F8:** oracle flagged chat-enabled-during-processing as an inconsistency, presence ≠ pass → graded **⚠️ Unverified** (not ✅).
  - **F10:** oracle: opacity:0 + in-DOM is presentation not authorization → added the **server-side authz UNVERIFIED** caveat.
- **Common thread (oracle):** F6+F9+F8 all trace to the tested video's processing/optimizing state, which the app handles inconsistently (summary works · tabs dead-locked · dock absent · chat open). **Steady-state (fully-processed video) was not reachable anonymously — required before full sign-off.**
