# deploy/server — state that lives on the VPS, not in the app image

Everything in this folder exists on the production server *outside* of Docker and
*outside* of any deploy. If the server is lost, this is the part that does **not**
come back by redeploying the app — so it lives in git.

Verified against the live host on **2026-07-18** by reading the real files over SSH
(`md5sum` of `/root/backup-db.sh` matches this copy byte-for-byte apart from the
header comment).

| File | Installs to | What it is |
|---|---|---|
| `backup-db.sh` | `/root/backup-db.sh` (mode `0755`) | The **authoritative** nightly database backup |
| `backup-db.crontab` | root's crontab | The schedule line that runs it, 22:00 UTC daily |

---

## Why the backup runs on the server and not in GitHub Actions

The MySQL container is attached to Coolify's internal Docker network and is not
published to the public internet. GitHub Actions runners are outside, so they
**cannot reach the database**. Any backup job that runs off-box therefore cannot
dump this database — which is exactly why this server-side cron exists.

See `docs/RUNBOOK.md` §2a for which dumps are authoritative (`capdb-*`, not
`data365-*`) and §5 for how to restore one.

## Installing on a fresh or replacement server

```bash
scp deploy/server/backup-db.sh root@<HOST>:/root/backup-db.sh
ssh root@<HOST> 'chmod +x /root/backup-db.sh'

# append the schedule line to root's crontab (keeps any existing entries)
ssh root@<HOST> 'crontab -l 2>/dev/null > /tmp/ct; \
  grep -q backup-db.sh /tmp/ct || echo "0 22 * * * /root/backup-db.sh >> /var/log/db-backup.log 2>&1" >> /tmp/ct; \
  crontab /tmp/ct; crontab -l'
```

### Then prove it — do not assume

```bash
ssh root@<HOST> '/root/backup-db.sh'          # run it once by hand
ssh root@<HOST> 'tail -5 /var/log/db-backup.log'
# expect: "[backup] done capdb-YYYY-MM-DD.sql.gz"
```

A silent success is not success: confirm the object actually landed in the bucket
(`aws s3 ls s3://<BUCKET>/db-backups/`) and that its size is in the megabytes.

## The one thing you MUST change on a new server

`backup-db.sh` finds its two containers by grepping `docker ps` for Coolify
resource UUIDs:

- MySQL container — `fot1zbunh8jld7l4k67h2zp4`
- App container — `pokroz1qrj8wfc82bl63ns2c`

**These UUIDs are generated per Coolify resource and will be different on a new
install.** Read the new ones with `docker ps --format '{{.Names}}'` and update both
greps. If you skip this the script exits immediately with `no mysql container` and
the backup stops — the cron still "runs" every night and nothing warns you.

## What the script does, in order

1. Locates the MySQL and app containers.
2. `mysqldump --single-transaction` of the `capdb` database → gzip → `/tmp`.
3. **Refuses to upload a dump smaller than 10 KB** (guards against uploading an
   empty file over a good backup).
4. Reads R2 credentials out of the *running app container's* environment, so a
   credential rotation in Coolify is picked up automatically with no edit here.
5. Uploads to `s3://<CAP_AWS_BUCKET>/db-backups/capdb-YYYY-MM-DD.sql.gz`.
6. Prunes objects under `db-backups/capdb-` older than 30 days.

Note step 4: the script has **no secrets in it**, which is why it is safe in git.

## Known limitations (real, not theoretical)

- **Retention prune only matches the `capdb-` prefix.** Objects written by any
  other producer under `db-backups/` are never cleaned up.
- **The backup is a single copy in R2, which has no versioning.** A delete or
  overwrite is unrecoverable.
- **Nothing alerts on failure.** The cron appends to `/var/log/db-backup.log`; if
  the dump breaks, you find out from the weekly `db-restore-check` workflow going
  red (it fails when the newest dump is more than 3 days old), not from the cron.
