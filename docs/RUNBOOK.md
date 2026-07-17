# RUNBOOK — data365 / Ustoz

**Who this is for:** the operator, who is **not a programmer**. Every step here is a thing you can actually do: a menu to click or a command to paste. If a step needs judgement you don't have, the honest answer is in **"When to stop and get help"** at the bottom.

**Rule zero:** *nothing here is true because it is written here.* Every claim below was verified on **2026-07-17** by running it. If something does not match reality, reality wins — fix this file.

---

## 1. The map — what exists, in one screen

| Thing | Where | How you check it's alive |
|---|---|---|
| The app (live site) | `https://data365.duckdns.org` | Open `https://data365.duckdns.org/api/health` → must say `"status":"ok"` and `db:"ok"`, `storage:"ok"` |
| The server | Contabo VPS, managed by **Coolify** | Coolify UI at `http://<CONTABO_IP>:8000` |
| The database | MySQL, inside Coolify | The `db:"ok"` in `/api/health` |
| The recordings | Cloudflare **R2** (bucket for videos) | The `storage:"ok"` in `/api/health` |
| The backups | Cloudflare R2, `db-backups/` folder | GitHub → Actions → **DB restore check** — green = the backup really works |
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
| `db-backup` | nightly 22:00 UTC | Dumps the database → R2, keeps 30 days. |
| `db-restore-check` | Mondays 05:00 UTC | **Actually restores the newest backup** into a throwaway database and proves the data is there. Also fails if the newest backup is >3 days old. |

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

**What the backups are:** in R2, bucket from `R2_BACKUP_BUCKET`, folder `db-backups/`, named `data365-YYYY-MM-DD.sql.gz`. 30 days are kept; older ones are deleted automatically.

**Steps** (needs the R2 keys and the database URL — both in your password manager / `docs/DEPLOY_SECRETS.md`, which is deliberately *not* in git):

```bash
# 1. See what backups exist (newest at the bottom)
aws s3 ls "s3://<R2_BACKUP_BUCKET>/db-backups/" --endpoint-url "<R2_ENDPOINT>"

# 2. Download the one you want
aws s3 cp "s3://<R2_BACKUP_BUCKET>/db-backups/data365-YYYY-MM-DD.sql.gz" . \
  --endpoint-url "<R2_ENDPOINT>"

# 3. Unzip it
gunzip data365-YYYY-MM-DD.sql.gz

# 4. RESTORE — this overwrites the live database. Be sure.
mysql "<BACKUP_DATABASE_URL>" < data365-YYYY-MM-DD.sql
```

5. Check `https://data365.duckdns.org/api/health` → `db:"ok"`, then log in and confirm your recordings are listed.

**The exact same sequence, done safely and automatically, is `.github/workflows/db-restore-check.yml`** — read it if you want to see the steps proven working.

> **Recordings themselves are NOT backed up.** This restores the *database* (who owns what, transcripts, summaries). The video files live as a **single copy** in R2 with no versioning and no second copy — a deleted recording is gone permanently. That is a known, deliberate owner decision (2026-07-16), not an oversight.

---

## 6. Rotate a secret (change a password/key)

**The rule: change it in the place the app READS it from.** Changing it anywhere else does nothing — this has already cost time once.

| Secret | Where it actually lives | How to change it |
|---|---|---|
| **Admin password** | The **database** (`users.passwordHash`) | Log in as admin → **Dashboard → Admin → Access** → find your row → **Reset**. This also logs out all old sessions — which is the point. ⚠️ `INITIAL_ADMIN_PASSWORD` in the server env does **nothing** now; it was only used once when the app was first created. |
| **R2 keys** (`CAP_AWS_*`) | Coolify env vars **and** GitHub secrets (the backup uses them) | Cloudflare → R2 → API tokens → create new → update **both** Coolify (restart app) **and** GitHub → Settings → Secrets → Actions. Delete the old token last, after `/api/health` says `storage:"ok"`. |
| **Gemini keys** | Coolify env vars | Google AI Studio → new key → Coolify → restart. |
| **`CRON_SECRET`** | Coolify env **and** GitHub secrets — must be the **same value in both** | Change both, or the scheduled jobs start failing. |
| **`DATABASE_ENCRYPTION_KEY`** | Coolify env | 🔴 **Do not change this.** Encrypted columns become permanently unreadable without the original. |

After any rotation: check `/api/health` → `ok`, and check GitHub → Actions that the jobs still pass.

---

## 7. Known gaps — the honest list (2026-07-17)

These are real and currently open. They are here so nobody discovers them at the worst moment.

- **`TELEGRAM_ALERT_CHAT_ID` is not set.** So the down-alert cannot send you a Telegram message. You still find out: the GitHub job goes red and GitHub emails you. **Fix:** message `@userinfobot` on Telegram → it replies with your chat id → GitHub → Settings → Secrets → Actions → new secret `TELEGRAM_ALERT_CHAT_ID`.
- **Recordings have no backup and no versioning** — single copy in R2 (see §5). Deliberate owner decision.
- **The retired Railway copy of the app is still live and reachable** (`capweb-production-dd85.up.railway.app` answers `200`). An old copy of the app with a working database, publicly reachable, unmonitored. **Needs a decision.**
- **`recover-cron.yml` on `main` is stale** — it still points at that Railway URL, not at the real site. It reports "success" every 30 minutes while never touching production.
- **The CI `lint` job is permanently red** — a large pre-existing formatting backlog (~1231 findings). It is isolated in its own job, so it does not hide the real checks (`test` and `guards` must be green). Don't let anyone tell you red-is-normal for those two.
- **Coolify's admin ports (8000/8080) are not firewalled.**

---

## When to stop and get help

Stop and ask rather than pressing on, if:
- a rollback would cross a **database structure change** (§4);
- you are about to **restore the database** and are not certain the live one is genuinely broken (§5) — this destroys data;
- `/api/health` says `ok` but users still can't record — that is not an outage, it is a bug, and guessing makes it worse;
- anything asks you to paste a password or key **into a chat**. Never do that. Secrets go into Coolify, GitHub Secrets, or your password manager — nowhere else.
