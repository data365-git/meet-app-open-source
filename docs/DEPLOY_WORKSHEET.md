# Deploy Worksheet — fill the blanks, paste into Railway

This is the companion to `DEPLOY_CHECKLIST.md`. The random secrets below are
**already generated for you** (2026-06-21). The `FILL_ME` values are the only ones
you need to obtain. Paste the whole block into Railway → your service → **Variables**.

> Keep this file private. It is in `docs/` which is gitignored, so it will NOT be
> committed. Do not share these secret values.

---

## Step 1 — values YOU must obtain

| Value | Where to get it |
|-------|-----------------|
| `RAILWAY_URL` | After you create the Railway service (DEPLOY_CHECKLIST step 2.7). Looks like `https://ustoz-production-xxxx.up.railway.app`. |
| `R2_*` (4 keys) | Cloudflare → R2 → create bucket + API token (DEPLOY_CHECKLIST step 1 + 3B). |
| `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey |
| `INITIAL_ADMIN_EMAIL` / `_PASSWORD` | Choose your own (change password after first login). |
| `DATABASE_URL` | Auto-injected by the Railway MySQL plugin — you usually do NOT paste this manually. |

---

## Step 2 — paste this into Railway Variables (replace every FILL_ME)

```env
# --- Core (secrets below are pre-generated, ready to use) ---
NEXTAUTH_SECRET=CHANGE_ME
DATABASE_ENCRYPTION_KEY=CHANGE_ME
INVITE_TOKEN_SECRET=CHANGE_ME
CRON_SECRET=CHANGE_ME

# --- URLs (all the same value = your Railway URL). NEXT_PUBLIC_WEB_URL is BUILD-TIME: set it BEFORE the first deploy ---
NEXTAUTH_URL=FILL_ME_RAILWAY_URL
WEB_URL=FILL_ME_RAILWAY_URL
NEXT_PUBLIC_WEB_URL=FILL_ME_RAILWAY_URL

# --- Storage: Cloudflare R2 (the app maps these onto the S3 vars automatically) ---
CLOUDFLARE_R2_ACCOUNT_ID=FILL_ME
CLOUDFLARE_R2_ACCESS_KEY=FILL_ME
CLOUDFLARE_R2_SECRET_KEY=FILL_ME
CLOUDFLARE_R2_BUCKET=FILL_ME_BUCKET_NAME

# --- First admin login (used once by `pnpm seed:admin`) ---
INITIAL_ADMIN_EMAIL=FILL_ME
INITIAL_ADMIN_PASSWORD=FILL_ME_STRONG_PASSWORD

# --- AI (required for transcript + summaries) ---
GEMINI_API_KEY=FILL_ME

# --- Build-time flag (set BEFORE first build) ---
NEXT_PUBLIC_DOCKER_BUILD=true

# --- Do NOT set NEXT_PUBLIC_IS_CAP (it turns on billing gates you don't want) ---
```

---

## Step 3 — after first deploy (run once, in order)

```bash
pnpm db:push      # create all tables (incl. auth_api_keys for the extension)
pnpm seed:admin   # create the admin account from INITIAL_ADMIN_* above
```

Then do **DEPLOY_CHECKLIST** step 7 (keep R2 bucket private + apply CORS),
step 8 (Railway cron service for job recovery), step 9 (extension default URL),
step 10 (AI budget cap — also set the Google AI Studio account-level cap),
and step 11 (smoke test).

---

## Verified pre-deploy (2026-06-21, this machine)
- Production Docker image build (`apps/web/Dockerfile`) — see `docs/qa/docker-build.log`.
- `seed:admin` + `db:push` scripts exist and match this worksheet.
- Dockerfile installs ffmpeg automatically (no `FFMPEG_PATH` needed on Railway).
- Server-action origins auto-derive from `WEB_URL`/`NEXT_PUBLIC_WEB_URL` — no code edit needed.
- Full app QA passed — see `docs/qa/QA_REPORT_2026-06-21.md`.
