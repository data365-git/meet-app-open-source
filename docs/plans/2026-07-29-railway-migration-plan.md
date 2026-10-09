# Railway migration plan — WITH data (owner decisions locked 2026-07-29)

**Status: PLAN ONLY. Execution starts after production-ready (iPhone check + M-DEL are the last gates).**
Written the evening the owner answered the three structural questions, so the shape is now fixed
and nobody re-litigates it.

## The three decisions (owner, 2026-07-29, one-tap batch)

| Question | Decision | Consequence |
|---|---|---|
| Domain | **Railway's own domain** (`*.up.railway.app`) | New domain → the extension must be REBUILT with the new origin and every team member reinstalls ONCE. The domain only exists after the Railway service is created, so the extension rebuild is a LATE step, not an early one. |
| Video storage (R2) | **Client's own Cloudflare account** | Full handover — the client stops depending on our Cloudflare account. Objects are COPIED, verified, and only then is anything old considered for deletion. |
| Old data365 deployment | **Delete after the new host is confirmed serving the same videos** | Decision recorded, but the actual deletion still gets one explicit "o'chir" from the owner at the moment itself — irreversible actions never run on a week-old yes. Deleting ends the Contabo monthly fee. |

Also reversed on 2026-07-29 (supersedes 2026-07-28 "fresh start"): **the existing videos and DB MOVE.**

## What actually moves (measured on prod 2026-07-29)

- **36 videos, ~589 minutes (~10 h) of footage.** Exact byte size: measure before the copy
  (`rclone size` on the bucket) — needed for the copy-time estimate and Railway egress math.
- **DB:** MySQL `capdb` — 4 users, 1 organization, plus videos/transcripts/AI rows. Small dump.
- **Key fact that simplifies everything: all 36 video rows have `awsBucket = NULL` and
  `bucket = NULL`** — the app resolves the bucket purely from ENV. So if the client's new R2
  bucket keeps the SAME NAME (`ustoz-videos`), the migration needs **no DB re-pointing at all**:
  copy objects → swap R2 credentials in env → done.

## Step map (execution order)

1. **Pre-flight (no client needed):** `rclone size` the current bucket · full `mysqldump` of
   `capdb` · confirm the dump restores into a scratch MySQL (the restore drill IS the backup test).
2. **Client-side setup (client does, ~15 min, we guide):** Railway account + project ·
   Cloudflare account + R2 bucket named `ustoz-videos` + API token (S3 credentials).
3. **Deploy the app on Railway** from this repo (`qa-fixes`), with a Railway MySQL. Env vars
   recreated from the current Coolify set (GEMINI key, R2 creds → client's, `WEB_URL` → the
   Railway domain, `INITIAL_ADMIN_*` unused since the DB comes with users). Verify boot +
   auto-migrations in logs.
4. **Restore the DB dump** into Railway MySQL.
5. **Copy R2 objects** old bucket → client bucket (`rclone copy`, then `rclone check` —
   object-count + hash verification, not "it probably copied").
6. **Live verify on the Railway domain:** login works · ALL 36 videos listed · spot-play several
   (old + new) · transcripts/AI results open · record ONE new test meeting end-to-end.
7. **Rebuild the extension** with the Railway domain baked in → bump version → team reinstalls
   once (guide: OWNER_QA_SCRIPT step 0).
8. **Rewrite RUNBOOK** for Railway (deploy, rollback, DB read, backups — today's is
   Coolify-specific; the handover promise is a fresh person can deploy and roll back).
9. **Cron jobs:** the four GitHub-Actions crons curl `data365.duckdns.org` — retarget their URL
   (and `CRON_SECRET`) to the Railway domain.
10. **Old server:** only after step 6 is green and the owner says "o'chir" in the moment —
    delete the Coolify app + server billing. Keep the final DB dump + an R2 snapshot listing as
    the archive record.

## Open items (not blockers to drafting, blockers to executing)

- **Cost estimate** (owner rule: estimate BEFORE committing — Railway bills usage; this app runs
  ffmpeg + long transcription): base plan + MySQL + egress for the R2 copy. Do once bucket size
  is measured.
- DuckDNS record: after cutover it can simply die with the old server — nothing should reference
  it once the extension is rebuilt.
- The transcription cheap/Batch mode and crons must be re-verified ON Railway (step 6/9), not
  assumed.
