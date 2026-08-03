# Codex — N006: harden API-key auth WITHOUT breaking existing keys

RULES: own ONLY `packages/web-backend/src/Auth.ts` (and a direct helper only if strictly required); no other files; no git; no typecheck/build. DB changes ADDITIVE only. Minimal + type-safe.

CONTEXT: `packages/web-backend/src/Auth.ts` (~67-83) authenticates an API key when `authHeader.length === 36` by looking up `authApiKeys.id = authHeader` (the plaintext UUID is both id and secret). Problems: (a) no `revokedAt`/`expiresAt` check, (b) a 36-char value that does NOT match a key falls THROUGH to session auth (confused-deputy).

IMPORTANT — do NOT break existing keys: the browser extension and desktop app already use these plaintext UUID keys (see `extension/mint-key`). Do NOT switch to hashed-only lookup (that would invalidate every existing key).

FIX (non-breaking hardening only):
1. Reject revoked/expired keys: if the `authApiKeys` row has a non-null `revokedAt` or an `expiresAt` in the past, treat as UNAUTHORIZED (do not authenticate). If those columns do not exist, you MAY add them as NULLABLE additive columns (default null) and filter on them.
2. Fix the confused-deputy: if the header looks like an API key (36 chars) but no matching/valid key row is found, REJECT as unauthorized — do NOT fall through to session auth.
3. Do NOT change to hashed key storage in this task (separate breaking migration). Leave a comment: `// TODO(security): migrate API keys to hashed storage (breaking — requires re-issuing keys)`.

REPORT: files changed, exactly what you added, and confirm existing valid keys still authenticate. No git/typecheck.
