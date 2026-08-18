# RUNBOOK — data365 / Ustoz

> ⚠️ **HOST IP CORRECTED 2026-08-18.** Every command below used to say `169.58.12.255`; that address no longer answers on port 22 (connection times out). `data365.duckdns.org` resolves to **169.58.86.149**, and that host is running `data365-web` + `data365-db` right now. The 7 occurrences were updated in place. The key name `~/.ssh/hetzner_ustoz` is still correct despite saying Hetzner. Note also that this file predates the current deploy shape — the live deploy is the `/opt/data365/src-<sha>.tar` → `docker build` → compose-tag-switch flow written up in `docs/plans/2026-08-18-wave1-SPEC.md`, not Coolify.

**Who this is for:** the operator, who is **not a programmer**. Every step here is a thing you can actually do: a menu to click or a command to paste. If a step needs judgement you don't have, the honest answer is in **"When to stop and get help"** at the bottom.

**Rule zero:** *nothing here is true because it is written here.* Every claim below was verified on **2026-07-17** by running it. If something does not match reality, reality wins — fix this file.

*Re-verified 2026-07-18:* the backup sections (§2a, §5) and the deploy command (§3a) were checked against the live server and the real backup bucket. §5 previously named the wrong dump file — following it would have restored a deleted database over production.

---

## 1. The map — what exists, in one screen

| Thing | Where | How you check it's alive |
|---|---|---|
| The app (live site) | `https://data365.duckdns.org` | Open `https://data365.duckdns.org/api/health` → must say `"status":"ok"` and `db:"ok"`, `storage:"ok"` |
| The server | Contabo VPS, managed by **Coolify** | Coolify UI at `http://<CONTABO_IP>:8000` |
| The database | MySQL, inside Coolify | The `db:"ok"` in `/api/health` |
| The recordings | Cloudflare **R2** (bucket for videos) | The `storage:"ok"` in `/api/health` |
| The backups | Cloudflare R2, `db-backups/` folder, `capdb-*.sql.gz` (§2a) | GitHub → Actions → **DB restore check** — green = *a* backup restores; read §2a for the catch |
| The code | GitHub `mirkomilovabrorwork-dot/ustoz-github` | Branch `qa-fixes` = where work happens. `main` = where the scheduled jobs live |

**The one number that matters:** `/api/health` says `ok`. If it doesn't, the app is down and **no meeting is being recorded**.

---

## 2. The scheduled jobs — and how to tell one is dead

All live on the **`main`** branch. **This is not a detail: GitHub only runs scheduled jobs from the default branch.** A job sitting on any other branch never runs, and *nothing warns you* — that is exactly how the nightly backup silently did nothing for 10 days.

| Job | When | What it does |
|---|---|---|
| `uptime-alert` | every 15 min | Pings the site from outside. Alerts if it's down. |
| `recover-cron` | every 30 min | Restarts AI jobs that got stuck. |
| `reconcile-cron` | nightly 21:00 UTC | **Finds recordings whose file went missing or whose upload stalled.** The lost-recording detector. |
| `purge-trash-cron` | nightly 21:30 UTC | Permanently deletes videos trashed more than 7 days ago — the other half of the Trash "kept for 7 days" promise. |
| `db-backup` | nightly 22:00 UTC | ⚠️ **NOT the real backup — see §2a.** Points at a database that no longer exists. |
| `db-restore-check` | Mondays 05:00 UTC | **Actually restores the newest backup** into a throwaway database and proves the data is there. Also fails if the newest backup is >3 days old. |

### 2a. Which backup is the real one — settled 2026-07-18

There are **two** things that have written dumps into `db-backups/`, and the docs
used to name different ones. Checked against the live server and the real bucket:

| | GitHub `db-backup.yml` | **The server cron — this one** |
|---|---|---|
| Runs where | GitHub Actions | On the VPS, `/root/backup-db.sh` |
| Files it writes | `data365-YYYY-MM-DD.sql.gz` | `capdb-YYYY-MM-DD.sql.gz` |
| In the bucket right now | **one** file, 2026-07-17, left over | one **every night**, 2026-07-14 → 17 |
| What it dumps | the old **Railway** database — now deleted | the **live** database |

**The server cron is authoritative. `capdb-*.sql.gz` is the backup.**

The GitHub workflow cannot do this job: the MySQL container is on Coolify's
internal Docker network, so a GitHub runner cannot reach it. That is precisely why
the server-side cron was written. Its source of truth now lives in the repo at
`deploy/server/` — restore it from there if the server is ever rebuilt.

> ⚠️ **`db-restore-check` cannot tell you which one it tested.** It picks the
> *newest object* under `db-backups/` regardless of filename, so it goes green on
> either series and hides the difference. Green means "some dump restores", not
> "the right dump restores". If you see a `data365-*` file appear again, treat the
> green as unproven and check by hand.
>
> ⚠️ `db-backup.yml` is still scheduled and now points at a deleted database, so
> it is expected to **fail nightly**. That noise is known — do not treat it as the
> live backup breaking. It should be disabled; see §7.

**How to check a job is really running** — GitHub → **Actions** → click the job name in the left list → look at the run history.
- Green runs appearing on schedule = alive.
- **An empty list = it has NEVER run.** That is the dangerous one, because everything *looks* configured.

---

## 3. "The site is down"

1. Open `https://data365.duckdns.org/api/health`.
   - **Loads and says `ok`** → the site is fine; the problem is the person's browser/network.
   - **Doesn't load / not `ok`** → continue.
2. Open Coolify: `http://<CONTABO_IP>:8000` → your app → **Logs**. Look at the newest lines at the bottom.
3. In Coolify, click **Restart**. Wait ~2 minutes. Re-check `/api/health`.
4. Still down → **§4 (roll back)**.

If Coolify itself won't load, the whole VPS is down → Contabo control panel → reboot the server.

---

## 3a. Deploy a new version

Coolify does **not** deploy on push by itself here — a push only updates GitHub.
You then have to trigger the build.

**1. Push the branch.** The app is wired to `qa-fixes`, not `main`:

```bash
git push origin qa-fixes
```

**2. Trigger the build** — either click **Deploy** in the Coolify UI, or fire the
API call:

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 \
  'CT=$(cat /root/.ct); curl -s -X POST \
     -H "Authorization: Bearer $CT" -H "Content-Type: application/json" \
     http://localhost:8000/api/v1/deploy \
     -d "{\"uuid\":\"pokroz1qrj8wfc82bl63ns2c\"}"'
```

**3. Wait ~30 minutes.** The Docker build is slow. Do not re-trigger because it
looks stuck.

**4. Prove it landed** — the API's own status field is unreliable (it reports
`running:unknown`), so check the two things that cannot lie:

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 'docker ps --format "{{.Image}}"'   # tag = your commit sha
curl -s https://data365.duckdns.org/api/health                                     # db:"ok", storage:"ok"
```

### The values in that command, and where they come from

| Value | What it is | If it stops working |
|---|---|---|
| `~/.ssh/hetzner_ustoz` | SSH private key for the server. Name says Hetzner; the server is Contabo. Legacy name, correct key. | Only on the operator's machine — **if that machine dies, server access dies with it.** Keep a copy in the password manager. |
| `169.58.86.149` | The VPS IP | Contabo control panel |
| `/root/.ct` | File on the server holding the Coolify API token | Regenerate: `docker exec coolify php artisan tinker` → new Sanctum token (must set `team_id` explicitly), write it back to `/root/.ct` |
| `pokroz1qrj8wfc82bl63ns2c` | Coolify **app** uuid (`ustoz-web`) | Coolify UI → the app → its URL contains the uuid |

Other Coolify uuids for this install: server `rk444s72653kw66hvv8jozaf` · project
`m2jhvkpuh8xvvna1031854fw` · MySQL `fot1zbunh8jld7l4k67h2zp4` (db `capdb`, user
`mysql`) · deploy key `y9s1butvcobm1c5j674zc6wv`.

If the deploy produced something broken, go to §4.

### The deploy "finished" but prod still runs the OLD image — read this before you re-debug

A failed build looks like nothing happening: Coolify removes the new version and
the old container keeps serving, so `/api/health` is green and the site is fine
while your change is simply not there. **Prod is safe; do not panic-fix.** Ask
the deployment itself what happened (the API's list endpoint returns `[]` once
the queue drains — you need the uuid the deploy call gave you):

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 \
  'CT=$(cat /root/.ct); curl -s -H "Authorization: Bearer $CT" \
     http://localhost:8000/api/v1/deployments/<deployment_uuid>'
```

`"status":"failed"` is the answer; the `logs` field holds the build output as
JSON entries.

**The failure this build actually hits (seen 2026-07-28):** `next build` dies
with `Last few GCs … allocation failure` at about **1874 / 2074 MB** and
`Command failed with signal "SIGABRT"`. That ceiling is **Node's own default
heap** (~2 GB on this 8 GB host) — the Dockerfile sets no `NODE_OPTIONS`, and
it already switched to webpack instead of turbopack "for lower memory usage"
(line 65). The host was NOT short of memory at the time: 5.1 GB free, no swap.
So the build passes or fails on the margin, and the same commit can do both —
one deploy succeeded an hour before this one failed. **First action: just
re-trigger it.** If it fails repeatedly, raise the ceiling in the builder stage
(`ENV NODE_OPTIONS=--max-old-space-size=4096`) rather than hunting the code.

---

## 3b. Look inside the production database (read-only, no client needed)

Two separate sessions lost time to this on 2026-07-20, both concluding "there is
no mysql client here". There is — it lives in the MySQL container, and the
password is already in that container's environment, so it never has to be typed
or stored anywhere:

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149  'docker exec fot1zbunh8jld7l4k67h2zp4 sh -c "mysql -umysql -p\$MYSQL_PASSWORD capdb -e \"SELECT id,transcriptionStatus FROM videos LIMIT 5;\" 2>/dev/null"'
```

`fot1zbunh8jld7l4k67h2zp4` is the MySQL container (fixed name); the app container
name CHANGES on every deploy, so always resolve it as
`docker ps --format '{{.Names}}' | grep '^pokroz' | head -1`.

**Schema migrations DO run automatically on prod** — at container startup, and
the log says so:

```
🔍 DB migrations triggered → 💿 Running DB migrations...
⚠️  Migration error is benign (ER_DUP_FIELDNAME). Schema is already at desired state. Continuing.
```

**⚠️ FALSIFIED 2026-08-05 — do not trust the paragraph above on its own.** The
deploy of `9e58a05` logged exactly that reassuring sequence and then
`🚨 MIGRATION_FAILED … ⚠️ Migration error is benign (ER_DUP_FIELDNAME) … Continuing.`
— and the brand-new `videos.libraryKind` column from migration `0038` **was never
applied**. The runner hit a duplicate column in an EARLIER migration, declared it
benign, and stopped without running the later ones. The log says "Continuing" and
means "stopping". `/api/health` stayed `ok` throughout, because it does not touch
that column; the dashboard queries that DO touch it would have failed for every
user. Fixed by hand in seconds once found:

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 \
  'docker exec fot1zbunh8jld7l4k67h2zp4 bash -c "mysql -uroot -p\$MYSQL_ROOT_PASSWORD capdb -e \"ALTER TABLE videos ADD COLUMN libraryKind varchar(16) NULL\""'
```

**So the rule is: the deploy TRIES to migrate; it does not GUARANTEE it.** Any
deploy that adds a column must be followed by checking that the column actually
exists — the migration log line is not evidence:

```bash
ssh -i ~/.ssh/hetzner_ustoz root@169.58.86.149 \
  'docker exec fot1zbunh8jld7l4k67h2zp4 bash -c "mysql -uroot -p\$MYSQL_ROOT_PASSWORD -N -B capdb -e \"SHOW COLUMNS FROM videos\""' | grep <newColumn>
```

The underlying defect is worth fixing properly and is not fixed yet: treating any
`ER_DUP_FIELDNAME` as "schema is already at the desired state" is wrong on its
face — a duplicate column in migration N says nothing about migrations N+1…M.
Until that is repaired, **every future additive column can silently fail to ship.**

## 4. Roll back a bad deploy

**When:** a deploy went out and the site is broken or badly wrong. Rolling back is the *fast* fix — diagnose afterwards, not during.

In **Coolify** → your app → **Deployments**: you see the list of deploys, newest first. Find the last one that was **good** → **Redeploy** that one.

To know which commit is live now: Coolify shows the commit on the deployment. Cross-check with `https://data365.duckdns.org/api/health` afterwards — it must return to `ok`.

> ⚠️ Rolling back the **app** does not roll back the **database**. If the bad deploy changed the database structure, a rollback can leave the old app talking to a new database. If you suspect that, **stop and get help** — that is not a click-a-button situation.

---

## 5. Restore the database from a backup

> 🔴 **Read this first.** Restoring overwrites the live database with an older copy. **Everything created since that backup is lost.** Backups are nightly, so you can lose up to a day. Never do this to "try something" — only when the real database is genuinely broken or gone.
>
> ✅ **You do not have to guess whether the backup works.** GitHub → Actions → **DB restore check** proves it every Monday. Last verified: **2026-07-17 — 38 tables, 4 users, 90 videos restored successfully.** If that job is green, the backup is good.

**What the backups are:** in R2, in the `db-backups/` folder of the app's own bucket (the `CAP_AWS_BUCKET` value — verified `ustoz-videos` on 2026-07-18), named **`capdb-YYYY-MM-DD.sql.gz`**. 30 days are kept; older ones are deleted automatically. Written nightly at 22:00 UTC by `/root/backup-db.sh` on the server (§2a).

> 🔴 **Take the `capdb-` file, never a `data365-` one.** A single stale
> `data365-2026-07-17.sql.gz` is still sitting in that folder. It is a dump of the
> **deleted Railway database**, not this app's data. Restoring it would overwrite
> live production with a different, older database. Match the `capdb-` prefix and
> check the date before you run anything.

**Steps** (needs the R2 keys and the database URL).

> ⚠️ **Do NOT go looking in `docs/DEPLOY_SECRETS.md` for the database URL.** That file is
> **Railway-era (2026-06-21), written before the move to Coolify/Contabo**, and it lists
> `DATABASE_URL` under *"Still to fill in"* — i.e. the one value you need most, mid-incident with
> production down, is the one it does not have. The live `DATABASE_URL` for the Coolify MySQL is in
> the **password manager** only. (The file is correctly gitignored and has never been committed —
> verified 2026-07-28 — so the secrets in it are not in git history; they are simply the WRONG,
> older ones.) If you only need to run SQL, you do not need the URL at all: use the container
> directly, as §1's check command does:
> `ssh … 'docker exec -i fot1zbunh8jld7l4k67h2zp4 sh -c "mysql -umysql -p\$MYSQL_PASSWORD capdb"' < your.sql`

```bash
# 1. See what backups exist (newest at the bottom). Expect capdb-* files.
aws s3 ls "s3://<CAP_AWS_BUCKET>/db-backups/" --endpoint-url "<CAP_AWS_ENDPOINT>"

# 2. Download the one you want — capdb-, not data365-
aws s3 cp "s3://<CAP_AWS_BUCKET>/db-backups/capdb-YYYY-MM-DD.sql.gz" . \
  --endpoint-url "<CAP_AWS_ENDPOINT>"

# 3. Unzip it
gunzip capdb-YYYY-MM-DD.sql.gz

# 4. RESTORE — this overwrites the live database. Be sure.
mysql "<DATABASE_URL>" < capdb-YYYY-MM-DD.sql
```

The database is not reachable from outside the server, so step 4 runs **on the
VPS** — either inside the MySQL container (`docker exec -i <mysql-container> mysql
-umysql -p"$MYSQL_PASSWORD" capdb < dump.sql`) or through an SSH tunnel.

5. Check `https://data365.duckdns.org/api/health` → `db:"ok"`, then log in and confirm your recordings are listed.

**The exact same sequence, done safely and automatically, is `.github/workflows/db-restore-check.yml`** — read it if you want to see the steps proven working. ⚠️ **That file exists only on `main`**, not on `qa-fixes` (the branch the product runs from and the one you are probably checked out on), so `git show main:.github/workflows/db-restore-check.yml` or view it on GitHub.

> **Recordings themselves are NOT backed up.** This restores the *database* (who owns what, transcripts, summaries). The video files live as a **single copy** in R2 with no versioning and no second copy — a deleted recording is gone permanently. That is a known, deliberate owner decision (2026-07-16), not an oversight.

---

## 6. Rotate a secret (change a password/key)

**The rule: change it in the place the app READS it from.** Changing it anywhere else does nothing — this has already cost time once.

| Secret | Where it actually lives | How to change it |
|---|---|---|
| **Admin password** | The **database** (`users.passwordHash`) | Log in as admin → **Dashboard → Admin → Access** → find your row → **Reset**. This also logs out all old sessions — which is the point. ⚠️ `INITIAL_ADMIN_PASSWORD` in the server env does **nothing** now; it was only used once when the app was first created. |
| **R2 keys** (`CAP_AWS_*`) | Coolify env vars. **No GitHub secret is named `CAP_AWS_*`** — the GitHub side uses `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` / `R2_BACKUP_BUCKET`, and those feed only the Monday restore-check. The REAL nightly backup (`deploy/server/backup-db.sh`) reads `CAP_AWS_*` live from the app container, so it self-heals on rotation with no GitHub change. | Cloudflare → R2 → API tokens → create new → update Coolify (restart app); update the four `R2_*` GitHub secrets only if you want the Monday restore-check to keep passing. Delete the old token last, after `/api/health` says `storage:"ok"`. |
| **Gemini keys** | Coolify env vars | Google AI Studio → new key → Coolify → restart. |
| **`CRON_SECRET`** | Coolify env **and** GitHub secrets — must be the **same value in both** | Change both, or the scheduled jobs start failing. |
| **`DATABASE_ENCRYPTION_KEY`** | Coolify env | 🔴 **Do not change this.** Encrypted columns become permanently unreadable without the original. |

After any rotation: check `/api/health` → `ok`, and check GitHub → Actions that the jobs still pass.

---

## 7. Known gaps — the honest list (2026-07-17, extended 2026-07-18)

These are real and currently open. They are here so nobody discovers them at the worst moment.

- **`TELEGRAM_ALERT_CHAT_ID` is not set.** So the down-alert cannot send you a Telegram message. You still find out: the GitHub job goes red and GitHub emails you. **Fix:** message `@userinfobot` on Telegram → it replies with your chat id → GitHub → Settings → Secrets → Actions → new secret `TELEGRAM_ALERT_CHAT_ID`.
- **Recordings have no backup and no versioning** — single copy in R2 (see §5). Deliberate owner decision.
- **Recording loss on a browser CRASH mid-upload (R3).** While the extension uploads each ~5 MiB slice of a meeting, that slice lives only in the browser's memory for a moment. If the browser process *crashes* (out-of-memory, force-quit, OS freeze) at exactly that instant, that slice is lost — a few-second hole in the middle of the recording. NOT a whole-recording loss, and normal close/stop/network-drop are all handled. Accepted as a rare limitation (owner decision 2026-07-18): the full fix would write every slice to disk before uploading, adding constant disk churn to every recording.
- **Single-recording length cap ~48 GiB / ~24–50 h (R5).** The S3/R2 multipart protocol allows at most 10,000 parts; at a fixed 5 MiB/part that is ~48 GiB. A single recording longer than that would fail to upload. No meeting reaches this; accepted as a limitation (owner decision 2026-07-18).
- **The CI `lint` job is permanently red** — a large pre-existing formatting backlog (~1231 findings). It is isolated in its own job, so it does not hide the real checks (`test` and `guards` must be green). Don't let anyone tell you red-is-normal for those two.
- **The extension package is not type-checked in CI** — it is bundled with esbuild (no type-check), and `tsc` currently reports pre-existing errors in `recorder-page.ts` and `sw.ts` (harmless at runtime, but real debt).
- **Coolify's admin ports (8000/8080) are not firewalled.**
- **`db-backup.yml` is scheduled but dead** (found 2026-07-18). Its `BACKUP_DATABASE_URL` secret still points at the Railway database, which was deleted — so the job now fails every night and its red is *not* a real backup failure. Worse, it is one working secret away from writing `data365-*` dumps of the wrong database back into `db-backups/`, where `db-restore-check` would silently pick the newest one (§2a). **Fix:** disable the workflow on `main` (remove its `schedule:` trigger) and delete the leftover `data365-2026-07-17.sql.gz` object. Both are outside this runbook's reach — they need a repo change and a bucket write.
- **Server access rests on one key on one laptop.** `~/.ssh/hetzner_ustoz` is not backed up anywhere. Lose that machine and you lose the ability to deploy, restore, or reach the server at all. Copy it into the password manager.

Resolved since the 2026-07-17 list: the retired Railway copy has been deleted (owner, 2026-07-18 — `capweb-production-dd85.up.railway.app` now `404`), and `recover-cron.yml` on `main` now targets the real site (`data365.duckdns.org`) with a health-check + batch-poll step.

---

## When to stop and get help

Stop and ask rather than pressing on, if:
- a rollback would cross a **database structure change** (§4);
- you are about to **restore the database** and are not certain the live one is genuinely broken (§5) — this destroys data;
- `/api/health` says `ok` but users still can't record — that is not an outage, it is a bug, and guessing makes it worse;
- anything asks you to paste a password or key **into a chat**. Never do that. Secrets go into Coolify, GitHub Secrets, or your password manager — nowhere else.
