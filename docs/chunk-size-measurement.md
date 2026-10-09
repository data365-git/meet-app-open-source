# Chunk size A/B — measured 2026-08-13 (fold into docs/STATE.md after the OpenRouter build lands)

**Question:** the free tier counts REQUESTS (`generate_content_free_tier_requests, limit: 20`), not
tokens, so `LONG_AUDIO_CHUNK_DURATION_SEC = 3 * 60` spends ~20 free requests on a single 1-hour
recording. Does a longer chunk cost transcript quality?

**Method:** one real 10-minute recording, cut with `audio-extract.ts`'s exact ffmpeg args
(`-vn -ac 1 -ar 24000 -acodec libmp3lame -b:a 64k`), the app's verbatim prompt, and production
generation settings (`temperature 0.1`, thinking/reasoning OFF). Both arms cover the SAME 10 minutes.

| arm | requests | words captured | cue span |
|---|---|---|---|
| today: 4 × 3-min chunks (OpenRouter) | 4 | **1 233** | — |
| one 10-min request (OpenRouter) | 1 | **1 230** | ends 6m42s |
| one 10-min request (Google, free path) | 1 | **1 224** | ends 9m57s |

**Verdict: chunk size does not change transcript CONTENT.** Word counts are within 0.7 % of each
other across all three arms. A 10-minute chunk therefore delivers the same transcript for a QUARTER
of the free-tier requests — a 1-hour recording drops from ~20 requests to ~6, so several meetings a
day fit inside the free allowance instead of one exhausting it.

**The one real difference is TIMESTAMPS, not text.** Google spreads cues across the full 9m57s;
OpenRouter compresses the identical word count into cues ending at 6m42s. The owner has said
timestamps are secondary — but the app's gap-fill reads cue timestamps to decide what is missing and
re-runs those spans on the PAID path, so an uncorrected drift would pay repeatedly to re-transcribe
text already in hand. That risk is in the OpenRouter build brief.

**Latency headroom, measured:** Google 34.0 s at 10 min (no upstream cap on that path); OpenRouter
53.3 s at 10 min against its documented **60 s** cap. So 10 minutes is near the ceiling for the
OpenRouter leg and 20 minutes would likely exceed it — do not raise the chunk beyond 10 min on the
paid path without measuring again.

**Not done:** a 20-minute arm (needs a longer source recording than the scratchpad holds) and any
by-ear accuracy judgement. Word count proves content VOLUME survived, not word-level fidelity.
