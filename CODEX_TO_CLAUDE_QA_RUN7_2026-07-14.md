# Codex → Claude handoff: QA RUN 7 (2026-07-14)

## Owner request

The owner asked Codex to perform a full expert review and QA of
`D:\vibecoding\ustoz-github`, then leave Claude an exact handoff.

## Scope and safety

- Audited the current `qa-fixes` working copy.
- Did not commit, push, deploy, delete data, upload media, send comments,
  trigger paid AI, create users, or run destructive production flows.
- The local `.env`/`.env.local` configuration points at remote Railway MySQL
  and Cloudflare R2. Therefore authenticated/write E2E flows were not run.
- Live `https://data365.duckdns.org` returned HTTP 200 for health and the public
  share page, but the in-app browser blocked the live URL with
  `ERR_BLOCKED_BY_CLIENT`. Codex did not bypass the interstitial/block.

## Files Codex intentionally changed

1. `.gitignore`
   - Added `.env.bak*` and `.env.backup*`.
   - Verified with `git check-ignore -v .env.bak-stale-20260112`.
   - The backup file remains on disk; its values were not changed or copied.
2. `QA_PLAN.md`
   - Prepended RUN 7 scope, proof standard, safety rules, and stage status.
3. `QA_FLOWS.md`
   - Prepended RUN 7 actor/journey/state map and critical proof targets.
4. `QA_SMOKE.md`
   - Prepended fresh gate results and environment limitations.
5. `QA_REPORT.md`
   - Prepended the complete RUN 7 browser/runtime report.
6. `QA_HARDENING.md` (new)
   - Added the evidence-backed security/data-loss/release audit.
7. `work/qa-run-7/*.log` (new, untracked evidence)
   - Captures local server startup and migration-attempt evidence.

Codex deliberately did **not** update `docs/STATE.md`, because another writer
was changing it and recorder/extension files during the audit. Avoid overwriting
that writer. Merge this handoff into STATE only after reconciling the live tree.

## Fresh gates Codex ran

- `pnpm typecheck` → exit 0.
- `pnpm --filter @cap/web build` → exit 0, twice; second build used
  `NEXT_PUBLIC_DOCKER_BUILD=false` to create a safe local QA artifact.
- `pnpm --filter @cap/web run test -- --reporter=dot`
  - First run: one 30-second `beforeEach` timeout in
    `developer-credits-checkout.test.ts`.
  - Focused rerun: 15/15 passed.
  - Second full run: 98 files passed, 1 skipped; 886 tests passed, 26 skipped.
  - Verdict: functional gate green, flaky-hook caveat retained.
- `pnpm --dir apps/browser-extension run build` → exit 0. Reran after another
  writer changed extension sources; current-tree build still exits 0.
- `pnpm exec biome check` → failed: 1,240 errors and 226 warnings across 1,192
  files. Codex did not auto-format because it would create broad churn.
- `pnpm --dir cloudflare-worker run typecheck` → failed with TS2688 because
  `@cloudflare/workers-types` is unavailable in the current install/workspace.
- Scoped `git diff --check` for Codex-owned tracked files → clean.
- Scoped normal/ignore-whitespace diff stats matched → no line-ending churn in
  Codex-owned tracked files.

## Browser/UI evidence

Codex used a fresh production build locally in read-only mode. The build was
served with `NEXT_PUBLIC_DOCKER_BUILD=false` after the startup risk below was
discovered.

Verified:

- Desktop login: styled render, required email/password, no overflow, no
  console errors.
- Mobile login at 390×844: no horizontal overflow; inputs and submit are 44px
  high; screenshot inspected.
- Mobile public share at 390×844: 353×198 player, no horizontal overflow,
  48px AI FAB, readable summary/tasks/transcript/refined tabs.
- Real public recording loaded: duration 3171.328 seconds, `readyState=4`.
- Tasks and refined-text tabs rendered.
- Transcript unlocked after media/context load.
- Clicking transcript timestamp `00:01` moved media to 1.084 seconds.
- Terms and Privacy contain real content.
- Invalid video ID renders a clean restricted/private page, not a 500.
- Embed route renders.
- Unknown routes redirect to login; there is no distinct 404 experience.
- No console warning/error was observed on the inspected login/share/tab/legal/
  invalid/embed/fallback routes.

Unverified:

- Full play-through, authenticated dashboard, signup/login submission, org
  isolation, record/import/upload, comments/invites, AI generation/chat send,
  destructive actions, offline recovery, backup restore, and admin flows.
- Keyboard Tab order: the in-app browser did not advance `activeElement`, so no
  product verdict was assigned.
- The integrated real-Meet entire-screen + tab-audio extension path still needs
  the owner's physical-device test.

## Reproduced startup safety issue

Starting the production build with the current compiled
`NEXT_PUBLIC_DOCKER_BUILD=true` caused `apps/web/instrumentation.node.ts` to
schedule database migrations after five seconds. The configured DB is remote.

Observed evidence:

- `DB migrations triggered` appeared three times.
- All attempts failed on missing `meta/_journal.json`.
- The server continued serving after all migration attempts failed.
- Codex stopped the QA server immediately. No successful migration was
  observed.

The flag is a `NEXT_PUBLIC_*` build-time value, so a runtime override did not
neutralize the first compiled artifact. Codex rebuilt with
`NEXT_PUBLIC_DOCKER_BUILD=false`, confirmed no migration-trigger log, completed
mobile QA, and stopped port 3001 afterward.

Recommendation: move migrations out of web startup into an explicit deploy
step, use a server-only opt-in flag, and fail readiness when a required
migration fails. This is architecture/deploy-sensitive and Codex did not change
it silently.

## Hardening findings

Full evidence and line references are in `QA_HARDENING.md`.

Counts: **1 Critical, 4 High, 5 Medium**.

Most important:

1. Critical: the known admin credential is tracked in current `docs/STATE.md`
   and Git history (six current matches; introduced historically around
   `436ac3c`). Codex did not print the secret into reports or test validity.
2. High: the secret-rich `.env.bak-stale-20260112` was not ignored. The ignore
   rule is now fixed, but the file still exists inside the repo directory.
3. High: signup sets `emailVerified: new Date()` without mailbox proof and lacks
   a durable abuse limiter.
4. High: account deletion removes user/session/account rows without transferring
   or deleting owned videos/storage.
5. High: web startup can run DB migrations and continue serving after failure.
6. Medium: space deletion is non-transactional.
7. Medium: audit-log insertion failures are swallowed.
8. Medium: one AI metadata branch can overwrite concurrent metadata changes
   instead of using `withLockedVideoMetadata`.
9. Medium: login/reprocess rate limits are process-local Maps.
10. Medium: stale-job recovery crons scan unbounded candidate sets.

## Concurrent-writer warning

During RUN 7, the following tracked extension files changed even though Codex
did not edit them:

- `apps/browser-extension/src/background/state.ts`
- `apps/browser-extension/src/background/sw.ts`
- `apps/browser-extension/src/content/meet-detect.ts`
- `apps/browser-extension/src/popup/popup.ts`
- `apps/browser-extension/src/recorder/recorder-page.ts`

New recorder plan variants also appeared. Treat those changes as belonging to
another writer. Do not revert, stage, or attribute them to RUN 7 without first
reconciling the owner/other-agent work.

## Required next actions

1. Owner: rotate the exposed admin credential immediately.
2. Claude: after rotation, remove the credential from current docs. Consider Git
   history cleanup only through an explicitly approved coordination plan; do not
   force-push.
3. Owner: reinstall the current extension build and test a real Meet recording,
   confirming the other participant's voice is present without the system-audio
   checkbox.
4. Claude + owner: decide account-deletion semantics (transfer, recoverable soft
   delete, or DB+storage deletion) before implementation.
5. Claude + owner: approve a migration-out-of-startup design before modifying
   deploy behavior.
6. Keep RUN 7 QA docs and the `.gitignore` fix separate from unrelated recorder
   work when committing.

