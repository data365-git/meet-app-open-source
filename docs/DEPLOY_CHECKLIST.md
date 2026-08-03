# Deploy Checklist — New Railway Deployment

> Branch: `qa-fixes` (or `main` after merge).
> Read top-to-bottom. Do each step in order. Every copy-paste command is shown in a code block.

---

## 1. Before you start — what you need

You need three things set up before touching Railway:

| What | Where to get it |
|------|-----------------|
| A **Railway account** | https://railway.app — free tier works to start |
| A **MySQL 8 database** | Add a Railway MySQL plugin (step 3 below) — easiest option |
| An **S3-compatible storage bucket** (for videos) | Cloudflare R2 is the cheapest. Create a bucket at https://dash.cloudflare.com → R2 → Create Bucket. Name it anything (e.g. `cap-videos`). Get an API Token with R2 read+write. |

---

## 2. Create the Railway project

1. Go to https://railway.app → **New Project** → **Deploy from GitHub repo**.
2. Connect your GitHub account if not already.
3. Select the `ustoz-github` repo.
4. When asked for a branch, pick **`qa-fixes`** (or `main` once merged).
5. Railway will detect the `apps/web/Dockerfile` — confirm it uses that Dockerfile (root of repo, `apps/web/Dockerfile`).
6. **Add MySQL:** in the same project, click **"+ New"** → **Database** → **MySQL**. Railway will auto-inject `DATABASE_URL` into your service. (If you use an external MySQL, paste the URL manually in step 4.)
7. Note the **public URL** Railway assigns to your service — it looks like `https://something.up.railway.app`. You need it for several env vars in step 4.

---

## 3. Set all environment variables in Railway

Go to your Railway service → **Variables** tab. Add every variable below.

> Build-time variables (marked **BUILD-TIME**) must be set BEFORE the first deploy — they are baked into the app at build.

### Group A — Core (required)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `DATABASE_URL` | MySQL connection string | Auto-injected by Railway MySQL plugin. Format: `mysql://user:pass@host:3306/railway` |
| `NEXTAUTH_SECRET` | Secret key for login sessions | Run `openssl rand -base64 32` in any terminal (or use https://generate-secret.vercel.app/32) |
| `NEXTAUTH_URL` | Your Railway app's public URL | The URL from step 2.7 — e.g. `https://something.up.railway.app` |
| `WEB_URL` | Same as `NEXTAUTH_URL` | Same URL |
| `NEXT_PUBLIC_WEB_URL` | Same as `NEXTAUTH_URL` — **BUILD-TIME** | Same URL. Must be set BEFORE first build |
| `DATABASE_ENCRYPTION_KEY` | Encrypts stored API keys in DB | Run `openssl rand -hex 32` |
| `INVITE_TOKEN_SECRET` | Signs org invite tokens | Run `openssl rand -base64 32` |
| `CRON_SECRET` | Protects `/api/cron/*` endpoints | Run `openssl rand -hex 32`. **Required** — without it every cron call returns 500 and recovery jobs never run. |

### Group B — Storage / S3 (required)

Variable names start with `CAP_AWS_` but work with any S3-compatible provider (R2, MinIO, AWS S3).

**R2 shortcut:** if you set the four `CLOUDFLARE_R2_*` variables below, the app maps them onto the `CAP_AWS_*` / `S3_*` vars automatically — you do not need to duplicate those.

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `CLOUDFLARE_R2_ACCOUNT_ID` | Your Cloudflare account ID | Cloudflare Dashboard → right sidebar → Account ID |
| `CLOUDFLARE_R2_ACCESS_KEY` | R2 API access key | Dashboard → R2 → Manage API Tokens → Access Key ID |
| `CLOUDFLARE_R2_SECRET_KEY` | R2 API secret key | Same token → Secret Access Key |
| `CLOUDFLARE_R2_BUCKET` | Your bucket name | The name you gave the bucket (e.g. `cap-videos`) |
| `CLOUDFLARE_R2_PUBLIC_URL` | Public base URL for video playback | R2 bucket → Settings → Public Access custom domain (optional — only if you expose a custom domain; leave unset otherwise) |

If you are NOT using R2 and prefer raw S3/MinIO, set these instead:

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `CAP_AWS_BUCKET` | Your bucket name | The name you gave the bucket in step 1 (e.g. `cap-videos`) |
| `CAP_AWS_REGION` | Storage region | `auto` for Cloudflare R2; or your AWS region (e.g. `us-east-1`) |
| `CAP_AWS_ACCESS_KEY` | Storage access key | R2: Dashboard → R2 → Manage API Tokens → Access Key ID |
| `CAP_AWS_SECRET_KEY` | Storage secret key | R2: same token → Secret Access Key |
| `S3_PUBLIC_ENDPOINT` | Your R2/S3 endpoint URL | R2: `https://<your-account-id>.r2.cloudflarestorage.com` |
| `S3_INTERNAL_ENDPOINT` | Same as above (or internal VPC URL) | Same as `S3_PUBLIC_ENDPOINT` |
| `S3_PATH_STYLE` | Required for R2/MinIO | Set to `true` |
| `CAP_AWS_BUCKET_URL` | Public base URL for videos | R2 public bucket URL or a CloudFront/CDN domain (optional but recommended) |

### Group C — Admin first login (required once)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `INITIAL_ADMIN_EMAIL` | Email for the first admin account | Choose one (e.g. `admin@yoursite.com`) |
| `INITIAL_ADMIN_PASSWORD` | Password for the first admin | Choose a strong password (you change it after first login) |

### Group D — AI features (required for transcript + summaries)

| Variable | What it is | How to get it |
|----------|------------|---------------|
| `GEMINI_API_KEY` | Google Gemini AI — used for transcription + summaries | https://aistudio.google.com/app/apikey |
| `ANTHROPIC_API_KEY` | Claude AI — chat fallback | https://console.anthropic.com (optional if only using Gemini) |
| `OPENAI_API_KEY` | OpenAI — optional AI summaries | https://platform.openai.com (optional) |

### Group E — Build-time flags (required — BUILD-TIME)

| Variable | Value | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_DOCKER_BUILD` | `true` | Enables Railway/Docker mode in Next.js. Set BEFORE first build. |
| `NEXT_PUBLIC_IS_CAP` | *(leave unset / blank)* | Do NOT set — it turns on Cap Cloud billing gates you don't want |

### Group F — Optional settings

| Variable | Default | What it does |
|----------|---------|--------------|
| `CAP_VIDEOS_DEFAULT_PUBLIC` | `true` | Set `false` to make all new videos private by default |
| `CAP_ALLOWED_SIGNUP_DOMAINS` | *(unset = open signup)* | Comma-separated list of allowed email domains, e.g. `myschool.uz` |
| `STORAGE_QUOTA_BYTES_PER_ORG` | *(unset = unlimited)* | Storage limit per org in bytes, e.g. `107374182400` = 100 GB |
| `CAP_BROWSER_EXTENSION_ORIGIN` | *(unset)* | If you want to restrict extension CORS to one origin, set it here (e.g. `chrome-extension://your-ext-id`) |
| `GOOGLE_CLIENT_ID` | *(unset)* | Enable "Sign in with Google". Get from Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | *(unset)* | Same as above |
| `AXIOM_TOKEN` | *(unset)* | Server-side structured logging to Axiom (optional). **Note: use `AXIOM_TOKEN`, NOT `NEXT_PUBLIC_AXIOM_TOKEN`** — the `NEXT_PUBLIC_` version exposes the token to browsers. |
| `AXIOM_DATASET` | *(unset)* | Axiom dataset name. Same caution: use `AXIOM_DATASET`, not `NEXT_PUBLIC_AXIOM_DATASET`. |

### What NOT to set (removed from this fork)

Do not add: `STRIPE_*`, `NEXT_PUBLIC_POSTHOG_*`, `WORKOS_*`, `RESEND_*`, `GROQ_API_KEY`, `VERCEL_*`, `DISCORD_*`, `TINYBIRD_*`, `NEXT_PUBLIC_AXIOM_TOKEN`, `NEXT_PUBLIC_AXIOM_DATASET`, `CLOUDFRONT_*`. These were in the original Cap codebase but have been removed from this fork.

---

## 4. ffmpeg — video transcription requirement

**ffmpeg is required.** Without it, video transcription will fail with "FFmpeg binary not found".

**Good news: the Dockerfile already handles this automatically.**
Line 82 of `apps/web/Dockerfile` runs `apk add --no-cache ffmpeg` during the Docker image build — ffmpeg is installed system-wide.
Line 79 sets `ENV FFMPEG_PATH=/usr/bin/ffmpeg` — the app picks it up automatically.

**You do NOT need to set `FFMPEG_PATH` manually** when deploying via Docker/Railway. It is already wired up.

> What could go wrong: if the Docker build ever bypasses `apk add ffmpeg` (e.g. you switch to a different base image), transcription silently fails. Verify by watching Railway build logs for the `apk add ffmpeg` line during the first build.

To verify after deploy: open a share page, click "AI tahlilni boshlash" — if transcription starts, ffmpeg is working.

---

## 5. Database schema — run AFTER first deploy

After Railway finishes building and the service is running, open Railway's terminal for your service (or use `railway run`) and run:

```bash
pnpm db:push
```

This pushes the full database schema (all tables) to your MySQL database using Drizzle ORM. It is safe to run on an empty database and also safe to re-run.

**Critical:** This creates the `auth_api_keys` table (with `id` column as `varchar(64)`) which the Chrome extension API-key sign-in depends on. If this step is skipped, extension sign-in will fail.

> What could go wrong: if you reuse an old database from a previous deployment, `db:push` may encounter benign errors like `ER_DUP_FIELDNAME` or `ER_TABLE_EXISTS_ERROR` — those are safe to ignore (the app also handles them automatically on startup). A real error will say `MIGRATION_FAILED` in the Railway logs.

If you do not have the Railway CLI, you can run the command from your local machine by setting `DATABASE_URL` in your local `.env` to point to the Railway MySQL instance, then run:

```bash
pnpm db:push
```

from the repo root on your machine.

---

## 6. Seed the first admin account

After `db:push`, create the admin user by running:

```bash
pnpm seed:admin
```

This uses `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from your env vars. Run it once. After first login, change the password from the settings screen.

---

## 7. S3 / R2 bucket — keep it PRIVATE and apply CORS

### 7a. Bucket must NOT be public-read

**Important security check.** If you created a NEW R2/S3 bucket for this deployment, it is private by default — this is correct and you don't need to do anything.

If you are reusing a bucket from an earlier deployment that was set to public-read: **delete the public bucket policy**. Video playback works via presigned (time-limited) URLs — public-read is not needed and exposes all files.

To check on Cloudflare R2: Dashboard → R2 → your bucket → Settings → Public Access → should say "Disallowed".

> What could go wrong: if Public Access is left on, anyone who guesses an object key can download any video without authentication. Presigned-URL playback still works with the bucket private — there is no trade-off.

### 7b. R2 CORS must be applied (browser uploads will fail without it)

CORS tells R2 to accept requests directly from browsers (direct uploads, presigned-URL playback). The app configures CORS automatically on startup via `apps/web/instrumentation.node.ts` — **but only for MinIO-style buckets, not for Cloudflare R2** (the code skips bucket creation + CORS when `CLOUDFLARE_R2_ACCOUNT_ID` is set).

**For R2 you must apply CORS manually once** in the Cloudflare dashboard:

1. Go to https://dash.cloudflare.com → **R2** → your bucket → **Settings** → **CORS Policy**.
2. Click **Add CORS policy** and paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

3. Click **Save**.

> What could go wrong: without CORS, direct browser-to-R2 uploads fail with a CORS error in the browser console. Video playback via presigned URLs may also fail in some browsers. This step is easy to miss because the app starts fine — only uploads/playback break.

---

## 8. Cron jobs — REQUIRED for job recovery (Railway does NOT run vercel.json crons)

**This step is critical and easy to miss.** The app has background cron routes that recover stuck/orphaned transcription and AI jobs. On Vercel these run automatically via `vercel.json`. **On Railway, `vercel.json` is completely ignored** — nothing will call these routes unless you wire it up manually.

Without cron jobs: videos that get stuck mid-transcription (server restart, network blip, etc.) will stay stuck forever. Users will see a perpetually spinning progress bar.

### The cron routes that need scheduling

| Route | Recommended schedule | What it does |
|-------|---------------------|--------------|
| `GET /api/cron/finalize-stale-desktop-segments` | Every 15 minutes | Recovers stuck desktop recording segments |
| `GET /api/cron/developer-storage` | Once per day (e.g. 02:00 UTC) | Processes developer storage billing snapshots |

Each route requires the header: `Authorization: Bearer YOUR_CRON_SECRET`

### Option A — Railway Cron service (recommended)

1. In your Railway project, click **"+ New"** → **Empty Service**.
2. Name it `cron-runner`.
3. In that service's settings, go to **Cron** and add a cron job with schedule `*/15 * * * *` and command:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.up.railway.app/api/cron/finalize-stale-desktop-segments
```

4. Add a second cron job with schedule `0 2 * * *` and command:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.up.railway.app/api/cron/developer-storage
```

5. Set `CRON_SECRET` as a shared variable in this service (same value as in the main web service).

### Option B — GitHub Actions (free alternative)

Create `.github/workflows/cron.yml` in the repo:

```yaml
name: Cron jobs
on:
  schedule:
    - cron: "*/15 * * * *"   # finalize-stale every 15 min
    - cron: "0 2 * * *"      # developer-storage daily
  workflow_dispatch:

jobs:
  finalize-stale:
    runs-on: ubuntu-latest
    steps:
      - name: Finalize stale desktop segments
        run: |
          curl -s -f \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            ${{ secrets.APP_URL }}/api/cron/finalize-stale-desktop-segments

  developer-storage:
    if: github.event.schedule == '0 2 * * *' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - name: Developer storage billing
        run: |
          curl -s -f \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            ${{ secrets.APP_URL }}/api/cron/developer-storage
```

Add `CRON_SECRET` and `APP_URL` (your Railway URL) as GitHub Actions secrets.

> What could go wrong: if `CRON_SECRET` is not set in Railway env vars, every cron call returns HTTP 500 ("Server misconfiguration"). If the secret is wrong, it returns HTTP 401. Check the cron runner's output logs to confirm it gets HTTP 200.

---

## 9. Chrome extension — point it at the new Railway URL

The Chrome extension ships with a hardcoded default server URL (`https://web-production-e6fe4.up.railway.app`) in `apps/browser-extension/src/shared/config.ts`. This is the OLD Railway deployment.

**Server-action origins are now AUTO-DERIVED from `WEB_URL` / `NEXT_PUBLIC_WEB_URL`** (no code edit needed). `next.config.mjs` builds its `serverActions.allowedOrigins` list from those env vars (plus localhost), so as long as you set `WEB_URL` and `NEXT_PUBLIC_WEB_URL` to your new Railway URL in step 3, the extension's server actions are allowed automatically. (The old `web-production-e6fe4.up.railway.app` stays in the list as a harmless fallback; removing it is a future cleanup, not required for deploy.)

> Verified 2026-06-21: `next.config.mjs` reads `process.env.WEB_URL` → `NEXT_PUBLIC_WEB_URL` → fallback. You do NOT need to hand-edit the origins list for a new Railway URL.

The Chrome extension's own default backend URL is still hardcoded, so that one DOES need attention. **Two options for the extension URL:**

### Option A — Change it before building dist/ (recommended if you build the extension yourself)

Edit `apps/browser-extension/src/shared/config.ts` line 15:

```typescript
export const DEFAULT_API_BASE_URL = "https://your-new-url.up.railway.app";
```

Then rebuild the extension:

```bash
pnpm -C apps/browser-extension build
```

Load the new `apps/browser-extension/dist/` as an unpacked extension in Chrome.

### Option B — Set it in the extension Options after loading (no rebuild needed)

1. Load `apps/browser-extension/dist/` as an unpacked extension in Chrome (Developer Mode on).
2. Click the extension icon → the gear/Options button.
3. Find the **"Cap server address"** field near the top.
4. Replace the old URL with your new Railway URL: `https://your-new-url.up.railway.app`
5. Click Save.

Both sign-in methods (button sign-in + API-key paste) will now use the new URL.

**The manifest already allows `https://*.up.railway.app/*`** — any Railway subdomain works without changing the manifest. If you ever use a custom domain (not `.up.railway.app`), you must add it to `externally_connectable` in `apps/browser-extension/manifest.json` before rebuilding.

> What could go wrong: even with Option B, if `next.config.mjs` `allowedOrigins` was not updated before the build, server actions called by the extension will fail. Option A (edit both files + rebuild) is the safe path for a clean new deployment.

---

## 10. AI spend — set a monthly budget cap

The app tracks every Gemini/Claude API call in the database and can enforce a per-user and per-org monthly spend cap. Without a cap, a spike in AI usage (many users requesting transcription at once) can run up an unexpected API bill.

**Set the cap in the app after first login:**

1. Log in as admin.
2. Go to **Settings** → **AI Budget** (or the org admin settings panel).
3. Enable the monthly budget and set a dollar amount (e.g. $20/month per org).
4. The app will block new AI requests once the cap is reached and show users a clear error message.

> Note: there is no env var for the AI cap — it is stored in the database per user/org and managed through the app UI. This is intentional so different orgs can have different limits.

> What could go wrong: if you skip this step and GEMINI_API_KEY is set, every admin click on "AI tahlilni boshlash" calls the Gemini API. With many videos, the bill can grow quickly. Set the cap before inviting other users.

---

## 11. Smoke test after deploy

Walk through these checks after the service is live:

1. **Basic load** — open `https://your-new-url.up.railway.app`. You should see the login screen (not an error page).
2. **Log in** — sign in with the admin email + password you set in `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`.
3. **Dashboard** — you should see the dashboard with "Instructional recordings" and "Meeting Recordings" in the sidebar.
4. **Upload a test video** — import or record a short video with audio.
5. **Share link** — open the `/s/[videoId]` share link.
6. **AI Generate (admin only)** — click "AI tahlilni boshlash". The stepper should show two stages running (Transcription → AI analysis). Wait ~2 minutes. The Summary, Transcript, Tasks, and Refined tabs should populate.
7. **Private video playback** — confirm the video plays without needing a public bucket URL (presigned URL playback).
8. **Cron check** — after setting up cron (step 8), manually trigger a cron URL in the browser or via curl and confirm HTTP 200:
   ```bash
   curl -I -H "Authorization: Bearer YOUR_CRON_SECRET" \
     https://your-new-url.up.railway.app/api/cron/finalize-stale-desktop-segments
   ```

**Extension test** — see `docs/tasks/002-phase-2-extension.md` → "Owner test steps" section for the full Chrome extension test flow (load unpacked dist/, set server URL, try button sign-in, try API-key fallback, test Meet recording).

---

## 12. Things that have changed since the original Cap cloud version

If you have used the upstream Cap cloud before, note these differences in this fork:

- **No billing/Stripe** — removed. All users are treated as "Pro" for self-hosted purposes.
- **No Posthog analytics, no WorkOS SSO, no Resend email** — removed.
- **AI is manual, not automatic** — the transcription + AI summary pipeline does NOT run automatically on upload. An admin must click "AI tahlilni boshlash" on the share page. This is intentional (cost control).
- **Private bucket** — videos are served via presigned URLs, not a public bucket. The old public bucket policy must be deleted if reusing an old bucket (step 7a).
- **`auth_api_keys` table** — added for extension API-key sign-in. The `id` column is `varchar(64)`. The `pnpm db:push` in step 5 creates it.
- **Axiom logging** — if you used `NEXT_PUBLIC_AXIOM_TOKEN` / `NEXT_PUBLIC_AXIOM_DATASET` in the original Cap, those variables have been renamed to `AXIOM_TOKEN` / `AXIOM_DATASET` (server-side only). The old `NEXT_PUBLIC_AXIOM_*` names are listed above under "What NOT to set".
- **Cron jobs not auto-wired on Railway** — the original Cap used Vercel's built-in cron support. On Railway you must add a cron service manually (step 8 above).
