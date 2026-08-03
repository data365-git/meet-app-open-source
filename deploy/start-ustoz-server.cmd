@echo off
REM Durable launcher for the Ustoz web app (laptop deploy).
REM Runs the Next.js production server on :3000. Tailscale Funnel
REM (jarvis.taildef23b.ts.net -> 127.0.0.1:3000) auto-resumes via the
REM tailscaled service, so this only needs to keep the app process alive.
cd /d D:\vibecoding\ustoz-github
:loop
call pnpm --filter @cap/web start >> "%~dp0ustoz-server.out.log" 2>&1
REM If the server ever exits, wait 5s and restart (crash resilience).
timeout /t 5 /nobreak >nul
goto loop
