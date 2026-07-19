# Authenticated QA without typing a password — researched 2026-07-19

Why this exists: to QA the authenticated dashboard, an agent needs a logged-in session.
Typing credentials into a login form is off-limits (assistant safety rule) and the owner's
real password must never be handled. The professional QA alternative is to mint a session
server-side. This file records what was learned so it is never re-derived from scratch.

## Confirmed facts (measured against the live container)

**Cookie the app expects** — `packages/database/auth/auth-options.ts:228-238`:
```
name:    next-auth.session-token          <-- NOT the __Secure- prefix, explicitly overridden
options: httpOnly: true, sameSite: "none", path: "/", secure: true
```

**`NEXTAUTH_SECRET` is set** in the running app container (verified: `SECRET_SET`).

**BLOCKER FOUND:** `next-auth/jwt` is **not requireable inside the container**.
```
docker exec <app> sh -c "cd /app/apps/web && node -e 'require(\"next-auth/jwt\")'"
  -> Error: Cannot find module 'next-auth/jwt'
find / -path "*next-auth/jwt/index.js"   -> no results
```
The Next.js **standalone** build webpack-bundles next-auth (and `jose`) into the server
chunks; they do not exist as resolvable node_modules. So the easy path
(`encode()` from next-auth) is unavailable. Do not retry it — this was already tested.

## The working approach (written, not yet executed end-to-end)

Mint the JWE by hand with **pure node crypto**, run **inside the container** so the secret
never leaves the server. Script saved at `docs/qa/mint-jwe.js` (also copied from the
scratchpad). NextAuth v4 session tokens are JWE compact, `alg: "dir"`, `enc: "A256GCM"`,
key derived by HKDF-SHA256:

- ikm  = `NEXTAUTH_SECRET`
- salt = empty
- info = `NextAuth.js Generated Encryption Key`
- len  = 32 bytes

Then AES-256-GCM with a 12-byte IV, AAD = the base64url protected header, and the compact
serialization `header..iv.ciphertext.tag` (empty encrypted-key segment for `dir`).

**Claims to put in the token** — mirror what the jwt callback produces (see auth-options):
`{ id, email, name, picture, isAdmin, sessionVersion }` plus `iat` / `exp`.

**Important behavioural note discovered while reading the callbacks:** the jwt callback only
re-queries the database when `user || !token.id`. A minted token that already carries `id`
is therefore trusted per-request without a DB round-trip — but server components that call
`getCurrentUser()` do hit the DB, so a **real user row must exist** for pages to render.

## Test-user situation in production (observed 2026-07-19)

`SELECT id,email,isAdmin FROM users` on the live `capdb` returned **4 rows**:
- `25s3fqp7e7vc5p0` — `admin@ustoz.uz` — isAdmin 1
- `8p1ka4dp1q2c7gx` — `mirkomilovabrorwork@gmail.com` — isAdmin 1
- `khc8kfjxtw7s7fk` — `mirkomilovabror7@gmail.com` — isAdmin 1
- `qa0pool0loop000` — `qa.pool.loop@data365-test.uz` — **isAdmin 0**

⚠️ The last one is a **pre-existing QA leftover** (NOT created this session — no user was
created; the session ended before any write). Two follow-ups for whoever picks this up:
1. It can be reused as the "requester" test subject (isAdmin 0, and worth checking it has no
   `organizationMembers` row — that would live-prove the C2 fix).
2. If it is not needed, delete it — a stale test account on production is exactly the kind of
   thing that should not outlive its purpose.

## Constraint to respect

No account creation through the signup form and no password entry by the assistant. Exercising
the signup **server action / endpoint** programmatically and then inspecting the resulting DB
rows is the sanctioned way to prove the signup behaviour (this is what the audits did too).

## Cleanup obligation

Anything created for QA on production (users, sessions, videos) must be deleted when the run
ends. Nothing was created in the 2026-07-19 session.
