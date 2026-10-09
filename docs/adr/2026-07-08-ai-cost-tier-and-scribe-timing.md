# ADR: AI cost tiers (Arzon/Tez) + permanent Scribe timing

Date: 2026-07-08 · Status: ACCEPTED (owner-grilled) · Owner decisions locked below.

## Context
- Paid Gemini spend hit the monthly cap; owner wants cost cut WITHOUT quality loss.
- Transcription is already free-tier-first (`GEMINI_API_KEY_FREE`, gemini-3.5-flash)
  but IMPATIENT: any failure (incl. 429 rate-limit) falls back to paid immediately.
- Summary + refined-transcript ALWAYS use the paid key (`generate-ai.ts` `callAiApi`).
- Chunks were shrunk 15→6 min purely to reduce timing drift; with Scribe timing-transfer
  (proven, drift 18s→~1-2s) Gemini timing no longer matters → chunks can grow again.
- Owner tolerance: cheap path may take 2-4h. A 2h video must never stay stuck.

## Decisions (owner, 2026-07-08)
1. **Tez/Arzon chooser replaces the "pul ketadi" amber warning** at AI-analysis start.
   No auto-start change; the same dialog now offers the two modes.
2. **Arzon mode = patient free-tier**: on free-key quota/429, WAIT and retry
   (cron-driven, deploy-safe) instead of falling back to paid. Extend free-tier-first
   to summary + refine too. Target: most videos complete at ~$0.
3. **Cost ladder within Arzon (owner refined 2026-07-08):**
   `free (patient) → free exhausted → BATCH API (50% off) up to the 4h mark, resuming
   from checkpoint → at 4h auto-continue REMAINDER on PAID (fast, from checkpoint,
   no redo) → manual "Pullikda tez davom et" admin button jumps to paid ANYTIME.`
   Rationale: owner expects free to exhaust; Batch fills the patient 0-4h window
   cheaply; paid is the hard 4h ceiling + manual override.
   **Implementation reality**: Batch is async (submit→poll→collect), so it operates
   PER-CHUNK against the existing `transcription-partial.vtt` checkpoint — whichever
   chunks Batch returns before 4h are saved cheap; paid finishes the rest at the
   deadline. This composes with the existing checkpoint-resume; that's why it works.
   Batch polling rides the same cron as patient-free (no in-process waiting — deploy
   would kill it, the old `after()` lesson).
4. **Scribe timing runs in BOTH modes** for long videos (>8 min): ElevenLabs Scribe
   word-times transferred onto Gemini text (~$0.22/hr ≈ $0.44/2h). No free
   alternative exists for Uzbek (Whisper measured: 94% garbage).
5. **Bigger chunks**: raise chunk size back toward 15-20 min (2h ≈ 5-7 calls, owner:
   "max 7") IF text quality holds — gate with golden-eval measurement before shipping.
6. **Old drifted videos: NO repair.** Only bbzt (already hand-repaired) + all NEW
   videos get accurate timing. No backfill script.
7. **Progress UI** must show what's actually happening (existing stage cards):
   mode (Arzon/Tez), chunk progress (k/N qism), quota-wait state with next-retry ETA,
   time-to-auto-paid, and the continue-on-paid button.

## Consequences
- Money control: Arzon can still spend (Scribe $0.44 on long videos + auto-paid
  after 4h) — owner accepted both explicitly.
- Needs durable retry infra (cron pattern like recover-cron) because in-process
  waiting dies on deploy/restart (the old Batch `after()` lesson).
- Free-tier quotas are per-model/day — patient mode must persist retry state in DB,
  not memory.
- Rejected: Gemini Batch API (50% off but ≤24h no-guarantee, dies on user-waiting
  path; free tier beats it at 100% off), multi-account key pool (ToS ban risk).
