# QA Hardening — Ustoz Run 8 — 2026-07-18

## Verified in this run

- Live health endpoint can reach both database and storage.
- Public playback works for a known 52:51 recording and can be paused cleanly.
- Invalid share IDs do not reveal recording metadata.
- TypeScript, extension tests/build, and the normal web build pass.
- Current recording durability tests in the extension pass 42/42.

## Release blockers

1. Make both admin password-reset paths revoke all existing sessions.
2. Remove the reusable admin browser-state artifact from the working tree and ignore the entire auth-state directory without printing or copying its contents.
3. Prevent silent video-only success on the Meet-tab-only path, or remove that path until it has the same audio guarantees as the primary recorder.
4. Make the web unit suite deterministic and require the focused health-readiness coverage in CI.
5. Prove the production webpack/Docker build, not only Turbopack.
6. Deploy a known commit and repeat header, health, public playback, and authenticated read-only smoke against that exact version.
7. Run the three-minute real-device Meet recording and play it to the end.

## Conditional blockers before enabling Stripe

- Enforce database-level uniqueness for credited payment references and update credit atomically.
- Return a retryable non-2xx status on processing failure.
- Minimize and redact webhook logs.

## Still unverified

- Mobile layout and mobile media playback.
- Chrome permission denial, picker cancellation, muted/ended tracks, service-worker eviction, browser restart, offline recovery, and kill-during-finalize.
- Full account erasure inventory.
- Migration readiness during real cold start.
- Portability from a clean machine using only documented configuration.

## Owner decisions preserved

- No deploy or external write was performed.
- No extension was loaded and no microphone/camera/screen permission was granted.
- Stripe findings are tracked but do not block the current disabled-Stripe runtime; they block enabling it.
