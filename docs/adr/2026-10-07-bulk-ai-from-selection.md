# ADR 2026-10-07 - Bulk transcript / full AI analysis from the selection bar

Status: accepted by owner (interview 2026-10-07), build pending his "boshla".

## Context
Owner asked: upload many files at once (ALREADY live since 2195e8f, 2026-09-28, max 20) and
run transcript or full AI analysis on many selected videos in one action (NEW).
AI is press-to-analyse today: no AI money is spent until someone presses per video.
The per-video endpoint `POST /api/videos/:id/generate` already takes `mode: "transcript" | "full"`.

## Decisions (owner)
1. Who: owners/admins only (same rule the generate route already applies).
2. Two actions on the existing multi-select bar: "Faqat transkript" and "To'liq AI tahlil".
3. Before start: a confirm dialog with the count, total audio length and an estimated price; nothing runs without "Boshlash".
4. Already-done videos in the selection are SKIPPED (no re-run, no double spend); the dialog says how many are skipped.

## Consequences
- Bulk is a thin client loop over the existing endpoint; no new server pipeline.
- Free quota is used first, then the paid key (existing owner rule, unchanged); the monthly AI budget cap (402) still stops spending.
- Open risk to verify in review: many background jobs started within seconds (server load / provider 503).
