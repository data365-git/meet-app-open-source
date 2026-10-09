# QA Run 10 — Smoke Evidence

Candidate: `81827a1`

## Fresh gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Extension suite | PASS | 3 files, 61/61 tests, exit 0, 13.42 s |
| Extension build | PASS | `Assets copied to dist/`, exit 0 |
| Permanent-delete focused web suite | PASS | 1 file, 7/7 tests, exit 0 |
| Web TypeScript | PASS | `pnpm --filter @cap/web exec tsc --noEmit`, exit 0 |

The expected network-failure messages printed by retry tests are exercised failure branches, not suite failures.

## Startup/live-surface status

- Chrome 150 is installed but was not running.
- The ChatGPT Chrome control extension is not installed in the selected Chrome profile, so the exact unpacked extension could not be controlled in this QA session.
- The in-app browser rejected direct navigation to the built `file://` extension page by security policy. No workaround or alternate control path was attempted.
- Therefore live extension startup, console, mobile viewport, picker, and real Meet checks are `Unverified`, not passed.

## Stage 2 result

The cheap executable gates are green, so source-level and simulated-flow verification can continue. Green gates do not override the three missing product behaviors already identified in the flow map.
