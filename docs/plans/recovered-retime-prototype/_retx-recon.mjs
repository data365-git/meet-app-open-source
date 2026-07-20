// Read-only recon before re-transcribing bbzt2424z6vvy6t.
// Shows free-tier key presence + which videos the recover-cron WOULD pick up
// (so re-triggering it doesn't silently re-process unrelated videos).
// Run: railway run --service @cap/web -- node apps/web/_retx-recon.mjs
import mysql from "mysql2/promise";

console.log("GEMINI_API_KEY_FREE:", process.env.GEMINI_API_KEY_FREE ? `SET (${process.env.GEMINI_API_KEY_FREE.length})` : "NOT SET");
console.log("CRON_SECRET:", process.env.CRON_SECRET ? "SET" : "NOT SET");

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);

const STALE_MS = 60 * 60 * 1000;
const staleIso = new Date(Date.now() - STALE_MS).toISOString();

const [txn] = await db.query(
  `SELECT id, name, transcriptionStatus,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.processingStartedAt')) AS startedAt
   FROM videos
   WHERE transcriptionStatus='PROCESSING' AND deletedAt IS NULL`,
);
console.log(`\n=== transcriptionStatus=PROCESSING (${txn.length}) — cron re-transcribes those with startedAt <= ${staleIso} ===`);
for (const r of txn) console.log(` ${r.id} | started=${r.startedAt} | ${r.startedAt && r.startedAt <= staleIso ? "STALE->would retry" : "fresh->skip"} | ${(r.name||"").slice(0,25)}`);

const [ai] = await db.query(
  `SELECT id, name,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.aiGenerationStatus')) AS aiStatus,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.aiProcessingStartedAt')) AS aiStartedAt
   FROM videos
   WHERE deletedAt IS NULL
     AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.aiGenerationStatus')) IN ('PROCESSING','QUEUED')`,
);
console.log(`\n=== stale AI candidates (${ai.length}) ===`);
for (const r of ai) console.log(` ${r.id} | ai=${r.aiStatus} | started=${r.aiStartedAt} | ${r.aiStartedAt && r.aiStartedAt <= staleIso ? "STALE->would re-run AI" : "fresh->skip"}`);

// Target's current state
const [[t]] = await db.query(`SELECT id, transcriptionStatus, JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.autoRecoverAttempts')) AS attempts FROM videos WHERE id='bbzt2424z6vvy6t'`);
console.log("\n=== TARGET bbzt2424z6vvy6t ===");
console.log(" status=", t.transcriptionStatus, " autoRecoverAttempts=", t.attempts);

await db.end();
