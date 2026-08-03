# QA Smoke — Ustoz Run 8 — 2026-07-18

## Fresh gates

| Gate | Result | Evidence |
|---|---|---|
| TypeScript | Pass | `pnpm typecheck`, exit 0; Next route types generated and `tsc -b` completed in 126.9 s |
| Browser extension unit tests | Pass | 2 files, 42/42 tests passed |
| Browser extension build | Pass | `pnpm --filter @cap/browser-extension build`, exit 0; assets copied to `dist/` |
| Web unit suite, first run | Pass | `pnpm --filter @cap/web test -- --reporter=basic`, exit 0 in 60.1 s |
| Web unit suite, repeat | Flaky / Fail | 1 file failed; 6 failed, 985 passed, 26 skipped (1017 total) |
| Focused health-readiness test | Pass after failure | 1 file, 7/7 passed in 5.05 s using the package test script |
| Standard web build | Pass with warning | `next build --turbopack`, exit 0 in 125.4 s; 35 static pages; NFT traced the whole project through `audio-extract.ts` |
| Production-equivalent web build | Unverified / timeout | `next build --webpack` remained CPU-active but produced no result before the 15-minute command limit |

## Live read-only smoke

- `GET /api/health`: `200`, body reported `db: ok` and `storage: ok`.
- `/login`, `/signup`, `/terms`, and `/privacy`: HTTP `200`.
- Known public share page loaded with one ready media element, transcript/summary tabs, and a 52:51 duration.
- Clicking the exact `Ijro` button advanced playback from 0 to 32.32 seconds without a media error; playback was then paused.
- An invalid share ID returned a generic private-video view without exposing metadata, although it used HTTP `200`.

## Gate interpretation

The observed dirty working tree compiles and its extension tests pass, but it does not have a deterministic green web-test gate and the real production webpack build was not proven within 15 minutes. The working tree changed during QA, and the live deployment is older than it, so neither the command set nor live success validates a single frozen release candidate.
