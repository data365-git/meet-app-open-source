# Task 002 — Phase 2: Chrome extension sign-in + Meet recording

## Goal
Make the Chrome MV3 extension (`apps/browser-extension`) sign-in work reliably (the teacher failed 10–20×) and make the Google-Meet "Record now?" popup actually record. Owner decisions (LOCKED):
- **Deploy target = a NEW Railway URL** (`*.up.railway.app`). The manifest `externally_connectable` already allows `https://*.up.railway.app/*`, so any new Railway subdomain's OAuth callback will reach the extension — the missing piece is making the SERVER URL configurable and not hardcoded to the OLD instance.
- **Auth = BOTH methods.** Primary = "Sign in with Cap" button (OAuth-style callback). Secondary = API-key paste, kept as an always-available, clearly-visible fallback so sign-in never dead-ends.

This is mostly CODE + extension BUILD verification. E2E sign-in cannot be tested in this environment (needs Chrome + a deployed server) — leave that to the owner; produce a test checklist (section "Owner test steps").

## Verified background (from diagnosis — confirm exact lines before editing)
- Extension dir: `apps/browser-extension` (MV3). manifest `externally_connectable`: `https://web-production-e6fe4.up.railway.app/*`, `https://*.up.railway.app/*`, `http://localhost:3000/*`.
- Hardcoded OLD default server URL `https://web-production-e6fe4.up.railway.app` in THREE places: `src/background/state.ts:86` (DEFAULT_SETTINGS.apiBaseUrl), `src/popup/popup.ts:758`, `src/options/options.ts:3`.
- Sign-in (OAuth callback): popup `src/popup/popup.ts:~443`, options `src/options/options.ts:~361-371` open `${apiBaseUrl}/extension/callback?extensionId=${chrome.runtime.id}`; the web page mints a `cak_` key and posts it back via `chrome.runtime.sendMessage` → handled in `src/background/sw.ts:~489-508` (`CAP_EXTENSION_TOKEN` → saves apiKey + apiBaseUrl).
- API-key manual paste: `src/popup/popup.ts:~447-504` validates via `GET ${apiBaseUrl}/api/extension/me` with `Authorization: Bearer <key>`.
- Settings stored in `chrome.storage` (`capExtSettings`): `src/background/state.ts` DEFAULT_SETTINGS (apiBaseUrl, apiKey, autoRecordOnMeet, autoRecordCountdownSec, soundEnabled, ...).
- Meet popup: `src/content/meet-detect.ts` — `renderDefaultNudge()` (~539-586) "Record now" button → `sendToBackground({type:"MEET_NUDGE_RECORD_NOW"})`; handled `src/background/sw.ts:~285-317` → `chooseDesktopMediaAsync()` → `ensureOffscreenDocument()` → `sendToOffscreen(START_CAPTURE)`. Sounds: `soundDroplet`/`soundChime`/`playAudio` (~87-147), gated by `settings.soundEnabled`.
- Server CORS (already OK): `apps/web/app/api/utils.ts:~124-149` allows any `chrome-extension://` origin + `CAP_BROWSER_EXTENSION_ORIGIN` env. The web callback page: `apps/web/app/extension/callback/CallbackClient.tsx` (mints `cak_` key, sends message, shows the key for manual paste on failure at ~156-177).

## Changes required

### A. Configurable server URL (single source of truth)
1. Create one shared constant for the default base URL, e.g. `src/shared/config.ts` exporting `DEFAULT_API_BASE_URL`. Replace ALL THREE hardcoded occurrences (state.ts, popup.ts, options.ts) to import it. Keep the value as the existing railway URL for now (owner will set the real new-railway URL in the options UI, or change this one constant before building) — but it MUST be overridable at runtime via settings.
2. In the OPTIONS page, make the "Server URL" field PROMINENT and clearly labelled (e.g. "Cap server address") near the top, with the current value pre-filled and a Save that persists to `chrome.storage`. After saving a new URL, both sign-in methods must use it.
3. Do NOT remove `https://*.up.railway.app/*` or `http://localhost:3000/*` from `externally_connectable` (the new railway domain relies on the wildcard; localhost for dev). If a non-railway custom domain is ever used it would need adding here — leave a short code comment saying so.

### B. Both auth methods, smooth (no dead-end)
1. PRIMARY — "Sign in with Cap" button: keep the OAuth callback flow. Ensure it uses the configurable `apiBaseUrl`. After clicking, if no `CAP_EXTENSION_TOKEN` arrives within ~20s, show a clear inline message: "Couldn't sign in automatically — paste your key below instead" and reveal the API-key field.
2. SECONDARY — API-key paste: make this field ALWAYS visible (or one obvious click away) in BOTH popup and options, with a one-line hint on where to get the key (the `/extension/callback` page shows it). Validate via `/api/extension/me`; on success show a clear "Connected as <name/email>" state; on failure a specific error (bad key vs wrong server URL vs network).
3. Surface real errors — never fail silently. If `apiBaseUrl` is unreachable, say "Can't reach the server — check the address". If 401, "Key not accepted — sign in again or paste a new key".
4. Confirm the `cak_` hashed-key flow still works end to end (extension sends `Authorization: Bearer cak_...`; server `apps/web/app/api/extension/me/route.ts` hashes + matches). Do not break legacy keys.

### C. Google-Meet "Record now?" actually records
1. Trace the `MEET_NUDGE_RECORD_NOW` → record chain in `sw.ts`. Identify why clicking "Record now" may not start recording. Likely causes — fix whichever are real: (a) NOT SIGNED IN (no `apiKey`) → recording can't upload; instead of silently doing nothing, the nudge/flow must detect "not signed in" and prompt sign-in (open the popup/options or show a message) BEFORE attempting capture; (b) desktop picker cancel handled as a silent no-op → log + surface; (c) `ensureOffscreenDocument()` / `sendToOffscreen` failure swallowed → surface.
2. Make the record action robust: precondition-check (signed in + on a Meet tab) → start capture → clear error if any step fails. The auto "Record now?" nudge that "appears but doesn't record" must either record or tell the user why.
3. This applies to BOTH meeting and instruction recordings — ensure the same start-capture path works off-Meet too (the popup "Record" button).

### D. Popup sound + UI polish
1. Owner says the nudge sound is unpleasant. Make it subtler (lower gain / shorter / softer tone) and ensure it strictly respects `settings.soundEnabled` (default could stay on but gentle). Keep `soundEnabled` toggle in options.
2. Light polish of the Meet nudge card (`renderDefaultNudge`) — clean spacing, clear primary "Record now", secondary "Later"/"Dismiss"; no layout breakage on Meet.

## Files NOT to touch
- The share page (`apps/web/app/s/[videoId]/`), the AI pipeline, DB schema. This task is the extension + (only if strictly needed) the extension-facing web endpoints already named.

## Gates (run from repo root; report exact output)
- Build the extension: find its build script (check `apps/browser-extension/package.json` — likely `pnpm -C apps/browser-extension build` or a vite/esbuild script) and run it; it MUST build with no errors and emit `dist/`.
- `pnpm typecheck` at repo ROOT must stay GREEN (do NOT use `-F @cap/web` — no-op false-green).
- Do NOT run git.

## Acceptance criteria
1. No hardcoded old-railway URL remains except as the single `DEFAULT_API_BASE_URL` constant; server URL is settable in options and used by both auth methods.
2. Both auth methods present and reachable in popup + options; OAuth failure cleanly falls back to visible API-key paste; errors are specific, never silent.
3. Meet "Record now" either records or clearly states why (esp. not-signed-in); no silent no-op.
4. Sound is subtler + respects the toggle.
5. Extension builds clean; root typecheck green.

## Owner test steps (the implementer writes these, the OWNER runs them after deploy)
Produce a short checklist the owner follows in Chrome after deploying to the new railway URL: load the unpacked extension, set the server URL, try button sign-in, try key-paste fallback, open a Meet and click Record now, verify a recording + share link is produced.

## Reporting
Final report: every file changed + one line; the build command + its result; root typecheck tail; the Owner test steps; anything that needs the live deployed URL to verify; any deviation + why.
