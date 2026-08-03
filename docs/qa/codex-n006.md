# Codex N006 — hash the legacy extension/desktop API keys (backward-compatible)

You are fixing a confirmed HIGH security bug in the Ustoz app (self-hosted Cap fork; Next.js 16, Drizzle + MySQL, Effect on the backend). Repo root is the current directory.

## The bug (N006)
The `authApiKeys` table stores the bearer token IN PLAINTEXT: the column `authApiKeys.id` literally IS the secret the extension/desktop app sends in the `Authorization: Bearer <token>` header. Anyone with read access to that table gets working credentials. (Note: the NEWER `developerApiKeys` system is already hashed via `apps/web/lib/developer-key-hash.ts` `hashKey()` — copy that exact HMAC approach.)

## The fix — make new keys hashed, keep old keys working (NON-BREAKING)
Design decided already — implement EXACTLY this, do not redesign:

1. **Shared hash util.** `Auth.ts` lives in `packages/web-backend` and CANNOT import from `apps/web/lib`. Create a new file `packages/web-backend/src/authApiKeyHash.ts` exporting `export async function hashAuthApiKey(token: string): Promise<string>` that uses the SAME HMAC-SHA256-over-NEXTAUTH_SECRET algorithm as `apps/web/lib/developer-key-hash.ts` (read that file and mirror it; get the secret from `@cap/env` `serverEnv().NEXTAUTH_SECRET`; return lowercase hex). Export it from the package's public entry if there is a barrel (check `packages/web-backend/src/index.ts` and how other modules are exported — match that).

2. **Minting — `apps/web/app/api/extension/mint-key/route.ts`.** Change so that:
   - The token returned to the client is a fresh secret with a recognizable prefix: `const token = "cak_" + <32 random bytes as hex>` (use `crypto.randomUUID()`-style randomness, e.g. `crypto.getRandomValues` over 32 bytes → hex).
   - The DB stores `id = await hashAuthApiKey(token)` (NOT the plaintext). Import `hashAuthApiKey` from `@cap/web-backend` (or the correct package specifier used elsewhere in apps/web — grep for existing `@cap/web-backend` imports to confirm).
   - Because the plaintext can no longer be recovered from the DB, the "return the existing key" branch must change to ROTATION: when the user already has key(s), DELETE the user's existing `authApiKeys` rows, then insert the new hashed one, and return the new plaintext `token`. (This is intentional: the extension re-mints at login and stores the fresh token; only-shown-once.)
   - Response shape stays `{ token, email }`.

3. **Validation — TWO call sites, both must accept BOTH formats:**
   - `apps/web/app/api/utils.ts` `getAuth()` (~line 75): currently `if (authHeader?.length === 36) { lookup by authApiKeys.id == authHeader }`. Change to:
     - if `authHeader?.startsWith("cak_")` → `const id = await hashAuthApiKey(authHeader)` (import from the shared util) → look up `authApiKeys` by `id == id`.
     - else if `authHeader?.length === 36` → KEEP the existing legacy plaintext lookup (so old keys still work).
     - else → fall through to `getCurrentUser()` as today.
   - `packages/web-backend/src/Auth.ts` `HttpAuthMiddlewareLive` (~line 67-88): same dual logic inside the Effect generator. For the `cak_` branch, hash with `hashAuthApiKey` (it returns a Promise — wrap with `Effect.tryPromise` / `yield*` it appropriately, matching the existing Effect style in this file) then query `authApiKeys` by `id`. Keep the existing 36-char legacy branch unchanged. Keep the existing fail-closed `Option.isNone → Unauthorized`.
   - Remove the stale `// TODO(security): migrate API keys to hashed storage` comment in Auth.ts once done.

4. Do NOT change the `authApiKeys` schema (no new columns) — we reuse `id` to hold the hash for new keys. Do NOT touch `developerApiKeys` (already secure). Do NOT touch git.

## RULES
- Minimal, type-safe, match existing patterns. No `as any`, no `@ts-ignore`.
- After edits, run the REAL typecheck from repo root: `pnpm.cmd typecheck` (runs `next typegen && tsc -b`). Node PATH may need `C:\Program Files\nodejs` prepended. Do NOT use `pnpm -F @cap/web typecheck` (no-op).
- Report: files changed, typecheck result, and anything you could not do safely + why.
