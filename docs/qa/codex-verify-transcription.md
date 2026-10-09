# Codex task — verify (and fix if needed) the AI transcription pipeline

The Ustoz dev app is RUNNING at http://localhost:3001 (Next.js). MySQL is in docker container `mysql-primary-db` (db `planetscale`, user `root`, no password). MinIO at http://localhost:9000 (bucket `capso`). `ffmpeg` is now installed and on PATH. `GEMINI_API_KEY` is set in `.env` and valid (50 models reachable).

BACKGROUND: transcription was failing (`transcriptionStatus=ERROR`) because ffmpeg was MISSING (audio extraction `spawn ffmpeg` failed). ffmpeg is now installed. Confirm transcription now works end-to-end.

TEST VIDEO: id `x1nj6750tqpnm1b` (~9s clip, public, owner admin@ustoz.uz).

DO THIS:
1. Reset status: `docker exec mysql-primary-db mysql -uroot planetscale -e "UPDATE videos SET transcriptionStatus=NULL WHERE id='x1nj6750tqpnm1b'"`
2. Trigger transcription. Easiest: load the public page so the app auto-triggers it (`curl -s -o /dev/null http://localhost:3001/s/x1nj6750tqpnm1b`). If that does NOT start it, read the code (search `transcribeVideo`, the `retry-transcription` route, or the transcription workflow) and start it the way the app does.
3. Poll every ~10s (up to ~4 min): `docker exec mysql-primary-db mysql -uroot planetscale -N -e "SELECT transcriptionStatus FROM videos WHERE id='x1nj6750tqpnm1b'"`. Watch NULL → PROCESSING → COMPLETE (or ERROR).
4. If COMPLETE: confirm a transcript actually exists (rows in `transcriptChunks` for this videoId, or the VTT object in MinIO). Report SUCCESS with evidence.
5. If ERROR or stalled: find WHY — check the running dev-server output and/or read the transcription code (ffmpeg audio extraction, Gemini Files upload, the workflow). If it is a small, safe fix (ffmpeg invocation/path, error handling), FIX it in code and re-run the test. Report the root cause + the files you changed.

Do NOT touch git. FINAL REPORT: a clear verdict — transcription WORKS or FAILS — with the status progression as evidence, and any files you changed.
