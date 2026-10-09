# ADR 2026-10-09 - Telegram transcript bot sold by monthly plan

Status: OWNER GO 2026-10-09 ("be fast"); building. D1 = first 30 min + explicit partial notice; D2 = separate AI account.

## Decisions (owner, 2026-10-09)
- Product: a Telegram bot. A user sends a video in plain chat; transcription runs in the background; the bot replies with a transcript FILE (speaker + timestamps). No Mini App, no summary in v1.
- Buyers: businesses (meeting recordings).
- Owner of the business/bot: the data365 team.
- Order: build the full version at once (Opus recommended a 3-5 client trial first; owner chose full - risk stated, his call).
- Plan shape (REVISED same day): NO monthly plan. Prepaid HOUR BALANCE per Telegram ID at 10,000 UZS/hour, min purchase 1 hour, charged per minute of actual media, hours never expire.
- Free trial: 30 minutes once per new Telegram ID.
- Payment: manual now, Stars later. Admin adds hours to a TG ID. The bot shows NO price, NO payment link/details - only 'contact admin' (Telegram ToS 6.2: digital goods must be sold in Stars; manual = medium risk, owner accepted).
- Privacy: the video is deleted as soon as the transcript is ready; the text is kept 30 days.
- Price: 10,000 UZS/hour. Measured cost ~$0.12-0.35/hour (~1.5-4.5k UZS) -> margin 2-6x.
- Done-when: the bot works end to end in our own test.

## Facts that shape the build
- Public Bot API downloads only <= 20 MB; a self-hosted Telegram Bot API server (`--local`) removes that (uploads up to 2000 MB). Meetings are 1 GB+, so the local server is required.
- Telegram expects digital goods sold inside a bot to use Stars; manual activation with payment outside Telegram must be checked against the current Bot payment rules before launch.
- Reuse data365's transcription pipeline (chunking, truncation guards, Gemini via OpenRouter flex) rather than re-inventing it.

## Open (HOW - Opus decides)
- Separate service vs inside the data365 app; must not starve data365 (4-core/8 GB host, no global job limit).

## Bot
- @uzbek_transcript_robot (getMe ok 2026-10-09). Token stored outside any repo at ~/.claude/.secrets/tgbot-data365.key. It was pasted in chat -> /revoke and replace before public launch.
