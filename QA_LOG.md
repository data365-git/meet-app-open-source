# QA_LOG — 2026-07-19 full QA+polish (prod data365.duckdns.org, build d5b0f5a)

| flow | oracle | evidence | state-read | verdict |
|---|---|---|---|---|
| share: public video delivery | purpose (video watchable) | qa-evidence/video-delivery-state.json | video.readyState=4, buffered=9.57s, playlist 302→signed R2 | OK (delivery); play-tick=Unverified — pane renderer throttled, owner device gate |
| share: restricted video access control | security spec (no unauth stream) | qa-evidence/restricted-access-control.txt | restricted &videoType=mp4 → 401 (+headers); public control → 302 signed | OK |
| share: denied view i18n (live) | claim (d5b0f5a) + user expectation | qa-evidence/denied-view-live.txt | h1="Bu video maxfiy", 0 console errors | OK |
| share: player UI localization | product consistency | qa-evidence/player-ui-uz.txt | 11 controls all Uzbek | OK |
| public HTTP surface (12 paths) | spec + history | qa-evidence/http-audit.txt | all 200/307, latency<0.7s, sec headers present | OK — findings: no true 404 (307→login), HSTS 1d, CSP frame-ancestors cap.so |
| locale matrix 3×3 | claim (NEXT_LOCALE) | qa-evidence/locale-probe.txt | 9/9 lang attr + strings match cookie | OK |
| OG/crawler metadata | comparable product (Loom) + privacy spec | qa-evidence/og-metadata.txt | restricted og:title generic, no name leak | OK — findings: video NAME template English ("Recording"), robots UA-flip by design |
| auth: dashboard renders (minted session) | spec (gated pages need session) | qa-evidence/authed-dashboard-caps.html | GET /dashboard/caps → 200 with valid sessionVersion; wrong version → 307 login | OK |
| auth: dashboard account settings i18n | product consistency | qa-evidence/authed-dashboard-settings-account.html | visible labels Uzbek (Hisob/Sozlama/Parol/Til/Chiqish); only <title> English | OK — finding: page <title> "Settings — data365" English (minor) |
| auth: session validation (sessionVersion) | security spec (auth-options.ts:47) | qa-evidence/session-validation.txt | token sessionVersion≠authSessionVersion → getCurrentUser returns null → 307 | OK |
| login: wrong-credentials error path | security (no user enumeration) | qa-evidence/login-enumeration.txt | nonexistent-email 401 == existing-email-wrong-pass 401 (no enumeration) | OK |
| 404 page copy (polish) | user expectation (Uzbek-first) | apps/web/app/not-found.tsx | was English "Oops…" → now "Kechirasiz, bu sahifa topilmadi" | FIXED (ships next deploy) |
| FINDING video-name template English | product consistency | qa-evidence/video-name-finding.md | DB names "data365 Recording/Meeting/Upload —" English placeholder, AI-replaced | SURFACED — coupled to generate-ai regex, NOT auto-fixed |
| 404 page live (local dev) | claim (cd1bd6e) | qa-evidence/notfound-live-uz.html | HTTP 404 + 'Kechirasiz, bu sahifa topilmadi' | OK |
| FINDING onboarding wizard i18n gap | product consistency (Uzbek-first) | qa-evidence/onboarding-live.html | live /onboarding/welcome mixes English ("Welcome to data365","Invite your team","Skip to dashboard","Organization","Continue") with Uzbek | SURFACED — feature-sized (5-page wizard × 3 locales), owner decision |
| FINDING shared-caps dead route | spec/history | qa-evidence/shared-caps-finding.md | /dashboard/shared-caps → 404; Top.tsx:44 title-map entry, NO Link to it anywhere | SURFACED minor — dead code, not user-reachable |
| public sec headers (all 7 paths) | security spec | qa-evidence/headers-all-paths.txt | HSTS+CSP+X-Frame+nosniff+Referrer+Permissions on every path | OK — note: /login CSP=cap.so, others 'self'; HSTS 1d |
