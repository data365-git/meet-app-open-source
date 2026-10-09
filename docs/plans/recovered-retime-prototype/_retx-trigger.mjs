// Trigger a clean re-transcription of bbzt2424z6vvy6t via the recover-cron:
// mark it as a stale PROCESSING job (only this video qualifies — recon showed 0
// others), then hit the cron endpoint which resets status->null and calls
// transcribeVideo() using the now-live 6-min chunking. Transcription runs on the
// free-tier key ($0). Run: railway run --service @cap/web -- node apps/web/_retx-trigger.mjs
import mysql from "mysql2/promise";

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);

// 2 hours ago — safely past the cron's 1-hour stale threshold.
const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

const [res] = await db.query(
  `UPDATE videos
   SET transcriptionStatus='PROCESSING',
       metadata = JSON_SET(COALESCE(metadata,'{}'),
         '$.processingStartedAt', ?,
         '$.autoRecoverAttempts', 0)
   WHERE id='bbzt2424z6vvy6t'`,
  [oldIso],
);
console.log("marked stale:", res.affectedRows, "row(s); processingStartedAt=", oldIso);
await db.end();

const base = process.env.NEXT_PUBLIC_WEB_URL || "https://capweb-production-dd85.up.railway.app";
const r = await fetch(`${base}/api/cron/recover-stale-ai-jobs`, {
  headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
});
console.log("cron HTTP", r.status);
console.log("cron body:", await r.text());
