import mysql from "mysql2/promise";
const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);
const oldIso = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const [res] = await db.query(
  `UPDATE videos SET transcriptionStatus='PROCESSING',
     metadata = JSON_SET(COALESCE(metadata,'{}'), '$.processingStartedAt', ?, '$.autoRecoverAttempts', 0)
   WHERE id='bbzt2424z6vvy6t'`, [oldIso]);
console.log("marked stale:", res.affectedRows);
await db.end();
const base = process.env.NEXT_PUBLIC_WEB_URL || "https://capweb-production-dd85.up.railway.app";
const r = await fetch(`${base}/api/cron/recover-stale-ai-jobs`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } });
console.log("cron", r.status, await r.text());
