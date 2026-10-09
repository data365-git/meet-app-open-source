# MIGRATION — stand this app up on any Docker VPS

**What this is for:** moving Ustoz (data365) to a new server — a planned move, a
provider change, or a rebuild after the current server is lost. It is written
**source-agnostic**: it does not assume you are coming from Railway, Contabo, or
anywhere in particular. It assumes only that you have the git repo, the secrets,
and a fresh Linux box with Docker.

**Day-to-day operations are not here** — restoring a backup, rolling back, rotating
a key and the current deploy command all live in `docs/RUNBOOK.md`.

The app is deliberately portable: a plain Dockerfile, S3-generic storage, and no
host-specific code. In practice the risk in a move is not the code. It is the two
things that are *not* in the image: **unwritten server state** and **secrets you
cannot regenerate**. Everything below is organised around not losing those.

---

## 0. Read this before you touch anything

Three ways a move destroys data. None of them are recoverable afterwards.

> 🔴 **`DATABASE_ENCRYPTION_KEY` is catastrophic if lost.**
> It encrypts stored credential columns. Restoring a database backup does **not**
> save you — the backup is encrypted with the same key. If you stand up the new
> server with a freshly generated key, those columns become permanently
> unreadable. **Carry it across byte-for-byte.** Never "regenerate" it.
> The same applies to `MEDIA_SIGNING_SECRET` if you use the media CDN, and to
> `NEXTAUTH_SECRET` / `INVITE_TOKEN_SECRET` (changing those invalidates every
> live session and outstanding invite — annoying, not fatal).

> 🔴 **Object storage is a single copy with no versioning.**
> The recordings live once in R2. There is no second copy and no version history,
> so any delete or overwrite is final. During a cutover this means:
> - **Rotate storage keys only AFTER the new host reports `storage:"ok"`.** If you
>   rotate first and the new host is misconfigured, you have taken down the old
>   host's access too and you are debugging with no working environment.
> - **Run no cleanup or reconciliation jobs mid-cutover.** With two hosts pointed
>   at one bucket, a cleanup job on either can decide the other's in-flight
>   objects are orphans and delete them. Leave the crons off until exactly one
>   host is live.

> 🟠 **The database has a loss window — but only if the move is unplanned.**
> The backup is nightly, so recovering from a dead server can lose up to a day of
> recordings and transcripts. A **planned** move eliminates this entirely: take a
> fresh dump at cutover (§3), not last night's. The nightly backup is your floor,
> not your plan.

---

## 1. What you need in hand

| | Where it lives | Notes |
|---|---|---|
| The repo | GitHub | You need a deploy key or token for the new host to clone it |
| Every env value | Coolify UI **and** your password manager | `.env.example` is the authoritative list of *names*; the password manager holds the *values* |
| The newest DB dump | R2 `db-backups/capdb-*.sql.gz` | See `RUNBOOK.md` §2a for why `capdb-`, not `data365-` |
| Storage credentials | Cloudflare R2 API token | Keep the old one working until the new host is verified |
| SSH access | A key on the new box | See §7 — this is the thing people forget to back up |

If a value exists **only** in the old server's Coolify UI and nowhere else, export
it before you do anything: a migration that starts by breaking the old server is
one you cannot finish.

---

## 2. Provision the new host

Any VPS that runs Docker. The app is light — the heavy work (AI inference) is
external, and video is served from object storage, so the server mostly proxies.
4 vCPU / 8 GB is comfortable.

**With Coolify** (what this deployment uses):

```bash
ssh root@<NEW_HOST>
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Coolify comes up on `http://<NEW_HOST>:8000`. Create the admin account in the
browser — that is an account creation, so it is a human step, not an automated one.

⚠️ Coolify's admin ports (8000/8080/6001/6002) are open to the internet by
default. Firewall them to your own IP.

**Without Coolify**, see §6 — nothing here requires it.

---

## 3. Database

1. Provision MySQL on the new host (Coolify → new MySQL service, or a
   `mysql:8` container). Note the internal host/user/password/db it generates —
   this becomes the new `DATABASE_URL`.
2. Get a dump.
   - **Planned move:** take a *fresh* dump from the old host at cutover. On the
     current server that is exactly what the backup script does — run
     `/root/backup-db.sh` by hand and use the file it just wrote.
   - **Disaster recovery:** pull the newest `capdb-*.sql.gz` from R2.
3. Restore it:

```bash
gunzip capdb-YYYY-MM-DD.sql.gz
mysql "<NEW_DATABASE_URL>" < capdb-YYYY-MM-DD.sql
```

The database will usually not be reachable from your laptop — Coolify puts it on
an internal Docker network. Run the restore **on the server**, either inside the
MySQL container or over an SSH tunnel.

4. **Verify before moving on.** Do not take "no errors" as proof:

```sql
SHOW TABLES;                 -- expect ~38
SELECT COUNT(*) FROM users;
SELECT COUNT(*) FROM videos;
```

Compare those numbers against the old host. If they do not match, stop.

> On a genuinely fresh install with no data to carry, skip the restore and run
> `pnpm db:push` (creates the schema, idempotent) then `pnpm seed:admin` (creates
> the first admin from `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`).
> `db:push` is what creates the `auth_api_keys` table the browser extension signs
> in with — skip it and extension login fails with a database error.

---

## 4. Environment variables

**`.env.example` in the repo root is the authoritative manifest.** Work from it,
not from a list someone typed into a status document — an incomplete env list is
the classic way this migration goes wrong.

Set **all** of them before the first build. Three groups:

**(A) Carry across UNCHANGED.** All secrets and third-party credentials:
`DATABASE_ENCRYPTION_KEY` (🔴 see §0), `NEXTAUTH_SECRET`, `INVITE_TOKEN_SECRET`,
`CRON_SECRET`, `MEDIA_SIGNING_SECRET`, all `CAP_AWS_*` and `CLOUDFLARE_R2_*`,
`GEMINI_API_KEY` (+ `GEMINI_API_KEY_FREE`), `TELEGRAM_BOT_TOKEN`, `S3_PATH_STYLE`,
`NEXT_PUBLIC_DOCKER_BUILD`, `INITIAL_ADMIN_*`, and `ELEVENLABS_API_KEY` if set.

**(B) REWRITE to the new address:** `WEB_URL`, `NEXTAUTH_URL`,
`NEXT_PUBLIC_WEB_URL` — all three the same value.

**(C) REPLACE with the new database:** `DATABASE_URL`.

**DROP** anything injected by the platform you are leaving (e.g. every `RAILWAY_*`
var). Verified: no production code reads them.

> ⚠️ **Build-time variables must be set before the FIRST build, not after.**
> `NEXT_PUBLIC_*` values are baked into the compiled output. In particular
> `NEXT_PUBLIC_WEB_URL` and `NEXT_PUBLIC_DOCKER_BUILD=true`. Setting them
> afterwards and restarting does nothing — you have to rebuild.

> ⚠️ **`CAP_AWS_*` must be set explicitly — this caused a live outage.**
> The server-side S3 client (`packages/web-backend/src/Aws.ts`) reads
> `CAP_AWS_ACCESS_KEY` and friends from `process.env` **directly**. The
> `CLOUDFLARE_R2_*` → `CAP_AWS_*` convenience mapping in `packages/env/server.ts`
> only populates the validated env object — it never reaches `process.env`. Set
> only the `CLOUDFLARE_R2_*` vars and the S3 client silently falls back to ECS
> metadata, finds nothing, and every storage operation (playlist, thumbnails,
> transcription) returns 500 while the app itself starts up looking healthy.
> Set all of: `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_ENDPOINT`,
> `CAP_AWS_BUCKET`, `CAP_AWS_REGION=auto`, `S3_PATH_STYLE=true`.
> Setting the `CLOUDFLARE_R2_*` ones alongside is fine, but is not a substitute.

---

## 5. Object storage

If you are keeping the same bucket, there is nothing to do — the app is not
coupled to the host. Just do not rotate the keys yet (§0).

**Setting up a new bucket** (Cloudflare R2; any S3-compatible service works):

1. Create the bucket. Keep it **private** — playback works through presigned URLs,
   and public access is a security hole.
2. R2 → Manage R2 API Tokens → Create API Token → **Object Read & Write**. Save
   the secret immediately; it is shown once.
3. The endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.
4. **Apply a CORS policy.** The app does not do this for you:

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

> ⚠️ Without CORS, browser-to-R2 uploads and presigned playback fail with a CORS
> error. The app starts fine and looks healthy — uploads and playback just break.
> Tighten `AllowedOrigins` from `*` to your actual domain once it works.

Moving the *objects* to a different bucket is a separate exercise
(`aws s3 sync` between endpoints) and is out of scope here — but remember there is
only one copy, so sync, verify, and only then delete anything.

---

## 6. Deploy the app

**With Coolify:** create an application → source = the GitHub repo, branch
`qa-fixes` → build pack **Dockerfile** → Dockerfile path `/apps/web/Dockerfile`,
base directory `/`, port `3000`. Set the env vars (§4) **before** the first
deploy. Then set the domain, and Coolify provisions Let's Encrypt automatically
(ports 80/443 must be open).

**Without Coolify** — nothing above is required. The repo has a plain Dockerfile
and a `docker-compose.template.yml`:

```bash
docker build -f apps/web/Dockerfile \
  --build-arg WEB_URL=https://your-domain \
  --build-arg NEXT_PUBLIC_WEB_URL=https://your-domain \
  -t ustoz-web .
docker run -d --env-file .env -p 3000:3000 --restart unless-stopped ustoz-web
```

> ⚠️ **The Dockerfile defaults those two build args to the CURRENT production
> domain** (`apps/web/Dockerfile`, ~line 59: `ARG WEB_URL=https://data365.duckdns.org`).
> Build without passing them and you get an image with the old host baked into the
> client bundle — the container starts, serves pages, and points users at the
> wrong domain. Pass both explicitly. `NEXT_PUBLIC_DOCKER_BUILD=true` and
> `FFMPEG_PATH` are already set as `ENV` inside the Dockerfile, so you do not pass
> those. The image listens on port **3000**.

Put any reverse proxy you like (Caddy, nginx, Traefik) in front for TLS. The app
does not care what is in front of it — it only needs `WEB_URL` to match the
address users actually reach it on.

---

## 7. Server-side state — the part a redeploy does NOT restore

Redeploying the app brings back the app. It does not bring back anything that
lived on the old server outside Docker. That is in `deploy/server/`:

- **`backup-db.sh` + `backup-db.crontab`** — the nightly database backup. Install
  it with `deploy/server/README.md`. **It has a host-specific bit:** the script
  finds its containers by grepping `docker ps` for Coolify resource UUIDs, and
  those are different on every install. Update them or the backup silently never
  runs.

Also not in the image, and worth writing down before you need it:

- **The SSH key** for the server. Losing it means losing the server.
- **The Coolify API token** (`/root/.ct`) and the resource UUIDs — see
  `RUNBOOK.md` §3a.
- **GitHub Actions secrets** — the scheduled jobs have their own copies of
  `CRON_SECRET` and the R2 credentials. Rotating in Coolify without rotating in
  GitHub breaks the crons, and nothing tells you.

---

## 8. Blast radius — the things that break because the address changed

Changing the domain ripples outward. Work through all of these; several fail
silently.

1. **Chrome extension** — rebuild it with the new origin, then users must
   reinstall:
   - `apps/browser-extension/manifest.json` — `externally_connectable.matches`
     and host permissions. ⚠️ Chrome rejects wildcards on Public Suffix List
     domains (this bit us on `railway.app`), so set the exact host.
   - `apps/browser-extension/src/shared/config.ts` — the `fallbackApiBaseUrl`
     literal (env normally overrides it, but update it anyway).
   - `apps/browser-extension/src/background/sw.ts` — any hardcoded origin.
   - Then `pnpm --filter @cap/browser-extension build`, rebuild the published zip,
     bump `manifest.json`'s version, and confirm the version *inside* the zip.
   - Set `CAP_BROWSER_EXTENSION_ORIGIN` on the server to the new extension origin.
2. **GitHub Actions workflows** — `recover-cron.yml`, `reconcile-cron.yml`,
   `uptime-alert.yml`, `db-restore-check.yml` all target the app URL. ⚠️ They only
   run from the **default branch** — a workflow edited on a feature branch never
   runs, and nothing warns you. This is how the nightly backup did nothing for ten
   days.
3. **Playback host heuristic** — `apps/web/app/s/[videoId]/_components/playback-source.ts`
   special-cases certain storage hosts when resolving playback URLs. Confirm it
   still behaves on the new host.
4. **DNS + TLS** — point the record at the new IP, and confirm the certificate
   actually issued rather than assuming it did.
5. **Sweep for stragglers** before calling it done:

```bash
grep -rln "<OLD_HOST>" .github apps packages \
  --include=*.yml --include=*.ts --include=*.tsx --include=*.json \
  | grep -vE "node_modules|/dist/|\.next|\.auth|scratchpad"
```

---

## 9. Verify — the actual gate

Do not declare the migration done on "it deployed". Prove each of these:

- [ ] `https://<new-domain>/api/health` returns `status:"ok"` **with `db:"ok"` and
      `storage:"ok"`** — and still does several minutes later.
- [ ] Log in as an existing user. The account exists → the database really came
      across.
- [ ] Open an existing recording and **play it** → storage credentials work.
- [ ] Anything using an encrypted column still works → `DATABASE_ENCRYPTION_KEY`
      came across intact. This is the check that catches the unrecoverable
      mistake, so do it early.
- [ ] Record something new end-to-end, upload it, and watch it back → the write
      path works, not just the read path.
- [ ] Extension signs in and uploads (needs the rebuilt extension, §8).
- [ ] Run `/root/backup-db.sh` by hand and confirm a `capdb-*.sql.gz` object
      appears in the bucket with a sane size → **the new server is protected.**
- [ ] GitHub Actions jobs are green against the new URL.

**Then, and only then:** rotate the storage keys if you meant to, re-enable the
crons, and decommission the old host. Keep the old host alive and reachable until
every box above is ticked — it is your only rollback.
