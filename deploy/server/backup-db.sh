#!/bin/bash
#
# ---------------------------------------------------------------------------
# REPO MIRROR of the PRODUCTION backup script that lives at /root/backup-db.sh
# on the app VPS. This is the AUTHORITATIVE nightly backup of the live database.
# It runs on the SERVER (not in GitHub Actions) because the MySQL container is
# bound to Coolify's internal Docker network and is not reachable from outside.
#
# INSTALL IT (on a fresh/replacement server, as root):
#   scp deploy/server/backup-db.sh root@<HOST>:/root/backup-db.sh
#   ssh root@<HOST> 'chmod +x /root/backup-db.sh'
#   ssh root@<HOST> 'crontab -l 2>/dev/null; cat deploy/server/backup-db.crontab' | \
#     ssh root@<HOST> crontab -
#   # then prove it works, do not assume:
#   ssh root@<HOST> '/root/backup-db.sh' && tail -5 /var/log/db-backup.log
#
# The two container-name greps below are Coolify resource UUIDs and are the ONLY
# host-specific values in this file. On a new server they WILL differ — read the
# new ones from `docker ps` and update them, or the script exits 'no mysql
# container' and the backup silently stops. See deploy/server/README.md.
#
# The only difference between this file and the server's copy is this header.
# ---------------------------------------------------------------------------
# Nightly backup of the live Contabo MySQL (capdb) -> Cloudflare R2.
# Self-contained: reads DB creds from the MySQL container and R2 creds from the
# app container at run time (survives credential rotation). Added 2026-07-14.
set -euo pipefail
MYSQL_C=$(docker ps --format '{{.Names}}' | grep fot1zbunh8jld7l4k67h2zp4 | head -1)
APP_C=$(docker ps --format '{{.Names}}' | grep pokroz1qrj8wfc82bl63ns2c | head -1)
[ -z "$MYSQL_C" ] && { echo 'no mysql container'; exit 1; }
[ -z "$APP_C" ] && { echo 'no app container'; exit 1; }
DATE=$(date -u +%Y-%m-%d)
FILE="capdb-${DATE}.sql.gz"
TMP="/tmp/${FILE}"
echo "[backup] dumping capdb -> $TMP"
docker exec "$MYSQL_C" sh -c 'mysqldump --single-transaction --quick --no-tablespaces -umysql -p"$MYSQL_PASSWORD" capdb' | gzip > "$TMP"
SZ=$(stat -c%s "$TMP"); echo "[backup] dump size $SZ bytes"
[ "$SZ" -lt 10000 ] && { echo '[backup] dump too small, aborting upload'; rm -f "$TMP"; exit 1; }
EP=$(docker exec "$APP_C" printenv CAP_AWS_ENDPOINT)
BK=$(docker exec "$APP_C" printenv CAP_AWS_BUCKET)
AK=$(docker exec "$APP_C" printenv CAP_AWS_ACCESS_KEY)
SK=$(docker exec "$APP_C" printenv CAP_AWS_SECRET_KEY)
echo "[backup] uploading -> s3://$BK/db-backups/$FILE"
docker run --rm -v "$TMP:/dump.gz:ro" -e AWS_ACCESS_KEY_ID="$AK" -e AWS_SECRET_ACCESS_KEY="$SK" amazon/aws-cli s3 cp /dump.gz "s3://$BK/db-backups/$FILE" --endpoint-url "$EP"
rm -f "$TMP"
# retention: delete backups older than 30 days
CUTOFF=$(date -u -d '30 days ago' +%Y-%m-%d)
KEYS=$(docker run --rm -e AWS_ACCESS_KEY_ID="$AK" -e AWS_SECRET_ACCESS_KEY="$SK" amazon/aws-cli s3api list-objects-v2 --bucket "$BK" --prefix db-backups/capdb- --query 'Contents[].Key' --output text --endpoint-url "$EP" 2>/dev/null || true)
for k in $KEYS; do
  d=$(echo "$k" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' || true)
  if [ -n "$d" ] && [ "$d" \< "$CUTOFF" ]; then
    echo "[backup] pruning old $k"
    docker run --rm -e AWS_ACCESS_KEY_ID="$AK" -e AWS_SECRET_ACCESS_KEY="$SK" amazon/aws-cli s3 rm "s3://$BK/$k" --endpoint-url "$EP" >/dev/null 2>&1 || true
  fi
done
echo "[backup] done $FILE"
