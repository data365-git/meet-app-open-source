# Contabo + Coolify migration runbook (Ustoz off Railway) — 2026-07-12

Prepared while waiting on the owner's Contabo VPS IP. Goal: move Ustoz (Cap fork,
Next.js + MySQL, media on R2) off the dead Railway trial onto Contabo VPS + Coolify.
Execute top-to-bottom once the IP arrives.

## 0. Prerequisites
- Owner has ordered the Contabo VPS (4vCPU/8GB, 100GB NVMe, Ubuntu 24.04, EU) with SSH key login → **needs to send me the IP + confirm SSH-key login**.
- SSH key already generated: `~/.ssh/hetzner_ustoz` (private) / `.pub` (public, pasted into Contabo). Name is legacy (Hetzner) — works for Contabo.
- Railway CLI is authed locally (verified 2026-07-12) → source of the DB dump + env values.

## 1. First SSH + Coolify install (~15 min)
```bash
ssh -i ~/.ssh/hetzner_ustoz root@<CONTABO_IP>
# minimal hardening: create non-root sudo user later; for now Coolify installer runs as root
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```
Coolify UI comes up at `http://<CONTABO_IP>:8000` → create the admin account IN THE BROWSER (owner-side: account creation is a prohibited action for me — owner sets the Coolify admin password himself).

## 2. MySQL: provision + migrate data
1. In Coolify → new **MySQL** database service (note the internal host/user/pass/db it generates → this becomes the new `DATABASE_URL`).
2. Dump from Railway (values NOT printed here; read at run time from `railway variables`):
```bash
# get the Railway DATABASE_URL (public proxy) at run time:
RW_DB=$(railway variables --service @cap/web --kv | sed -n 's/^DATABASE_URL=//p')
mysqldump --single-transaction --set-gtid-purged=OFF --column-statistics=0 \
  "$RW_DB" > ustoz-dump.sql      # Railway proxy: thomas.proxy.rlwy.net:26774
# restore into Coolify MySQL (via its exposed port or an SSH tunnel):
mysql "<NEW_COOLIFY_DATABASE_URL>" < ustoz-dump.sql
```
3. **`DATABASE_ENCRYPTION_KEY` MUST be migrated unchanged** — encrypted columns are unreadable without it. (This was missing from the earlier STATE env list — caught 2026-07-12.)

## 3. Deploy the app in Coolify
- Source: the private GitHub repo (`mirkomilovabrorwork-dot/ustoz-github`) → Coolify → connect GitHub (owner authorizes the GitHub app in-browser) → pick the repo/branch.
- Build: repo builds via Docker (`NEXT_PUBLIC_DOCKER_BUILD=true` present) → point Coolify at the existing Dockerfile (locate it: `apps/web/Dockerfile` or root — verify at run time).
- Set all env vars (section 4) BEFORE the first deploy.

## 4. Environment variables (full, classified — verified from `railway variables` 2026-07-12)
**Never print secret VALUES.** At run time pipe names+values from Railway; only the URL/DB ones are edited.

**(A) Migrate UNCHANGED** (13): `CAP_AWS_ACCESS_KEY` `CAP_AWS_BUCKET` `CAP_AWS_ENDPOINT` `CAP_AWS_REGION` `CAP_AWS_SECRET_KEY` `CLOUDFLARE_R2_ACCESS_KEY` `CLOUDFLARE_R2_ACCOUNT_ID` `CLOUDFLARE_R2_BUCKET` `CLOUDFLARE_R2_SECRET_KEY` `CRON_SECRET` `DATABASE_ENCRYPTION_KEY` `GEMINI_API_KEY` `GEMINI_API_KEY_FREE` `INITIAL_ADMIN_EMAIL` `INITIAL_ADMIN_PASSWORD` `INVITE_TOKEN_SECRET` `MEDIA_SIGNING_SECRET` `NEXTAUTH_SECRET` `S3_PATH_STYLE` `TELEGRAM_BOT_TOKEN` `NEXT_PUBLIC_DOCKER_BUILD` (+ `ELEVENLABS_API_KEY` if/when owner adds Scribe timing — not currently set).

**(B) REWRITE to the new duckdns domain** (was pointing at `capweb-production-dd85.up.railway.app`): `NEXTAUTH_URL` `NEXT_PUBLIC_WEB_URL` `WEB_URL` → all `https://<newname>.duckdns.org`.

**(C) REPLACE with the new Coolify MySQL connection:** `DATABASE_URL`.

**(D) DROP — do NOT migrate** (Railway-injected platform vars; confirmed no production source code references them, only dead scratchpad files): every `RAILWAY_*` (`RAILWAY_ENVIRONMENT` `RAILWAY_ENVIRONMENT_ID` `RAILWAY_ENVIRONMENT_NAME` `RAILWAY_PRIVATE_DOMAIN` `RAILWAY_PROJECT_ID` `RAILWAY_PROJECT_NAME` `RAILWAY_PUBLIC_DOMAIN` `RAILWAY_SERVICE_ID` `RAILWAY_SERVICE_NAME` `RAILWAY_SERVICE__CAP_WEB_URL` `RAILWAY_STATIC_URL`).

## 5. Domain + SSL
- duckdns: create `<newname>.duckdns.org` → point A record at `<CONTABO_IP>` (owner-side: duckdns account).
- Coolify → set the app's domain to `https://<newname>.duckdns.org` → Coolify auto-provisions Let's Encrypt SSL. Verify cert issues (port 80/443 open on Contabo firewall).

## 6. Blast-radius follow-ups (domain change ripples — do NOT forget)
Exact files hardcoding the old origin (grep verified 2026-07-12; ignore `.next/`, `.auth/`, `/dist/`, scratchpad):
1. **Chrome extension** (3 files) — rebuild with the new origin, owner reinstalls:
   - `apps/browser-extension/manifest.json` — `externally_connectable.matches` (+ host perms). ⚠️ `railway.app` is on the Public Suffix List so Chrome rejected a wildcard; duckdns may differ — set the exact new host.
   - `apps/browser-extension/src/shared/config.ts:23` — `fallbackApiBaseUrl` default (overridden by `EXTENSION_API_BASE_URL`/`WEB_URL`/`NEXT_PUBLIC_WEB_URL` env, but update the literal too).
   - `apps/browser-extension/src/background/sw.ts` — any hardcoded origin.
   - Then `pnpm --filter @cap/browser-extension build` → owner reinstalls.
2. **Cron workflows** (repoint to new duckdns URL): `.github/workflows/recover-cron.yml` (+ poll-batch-jobs ping) and `.github/workflows/reconcile-cron.yml`.
3. **⚠️ Web app playback heuristic — REVIEW:** `apps/web/app/s/[videoId]/_components/playback-source.ts:106` treats `*.up.railway.app` (and minio) hosts specially when resolving playback URLs. On Contabo the app host won't match → confirm this branch was only special-casing internal/proxied storage hosts (benign) and NOT rewriting the app's own media URLs. If it was load-bearing, add the new host/logic.
4. `apps/web/scripts/_qa-import.ts` — QA script, non-prod; update only if used.
5. Re-run the grep after migration to confirm zero stragglers: `grep -rln "capweb-production-dd85\|up.railway.app" .github apps packages --include=*.yml --include=*.ts --include=*.tsx --include=*.json | grep -vE "node_modules|/dist/|\.next|\.auth|scratchpad"`.

## 7. Verify (the real gate — after the batch is deployed here)
- `/api/health` → 200 with `db=ok storage=ok` (sustained a few min).
- Log in as admin; walk the changed screens (the 12-task batch + T4b + recorder) mobile + desktop, light/dark, console/network clean.
- Confirm a real `/s/<id>`: player (audio split, mobile seek, resume, dock), chat variant, import, T4b button, and the recorder (owner device).
- Only then flip STATE's "DEPLOYED/live" claims from aspirational to real.

## Notes
- Railway MySQL public proxy: `thomas.proxy.rlwy.net:26774` (from STATE).
- Keep Railway alive (don't delete the project) until Contabo is verified — it's the rollback + the DB source of truth during migration.
- Contabo quality caveats (vs Hetzner): possible CPU steal / slower disk — tolerable at current scale; revisit if load grows.
