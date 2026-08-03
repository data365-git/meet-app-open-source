# Claude handoff — on-demand timestamp refinement

Date: 2026-07-15
Branch: `qa-fixes`
Status: implementation mostly written and green, but **not visually finished**. Do not call it done yet.

## Owner decision (supersedes the global-setting idea)

Every file uses ordinary Gemini transcription and Gemini timestamps by default.

Only when needed, the file owner opens the dashboard card `...` menu and chooses **Refine timestamps**. That explicit action uses ElevenLabs Scribe v2 only as a timing oracle. It must preserve Gemini's latest transcript text.

There is no global timestamp setting and no automatic Scribe call in the normal transcription pipeline.

Scope contract: Only change per-file timestamp refinement and the dashboard card's `...` trigger. Do not change AI speed modes, Gemini transcript wording, summaries, player controls, or unrelated dashboard surfaces.

## Current working-tree implementation

The following work is already present. Review it as a hypothesis, not proof:

- `apps/web/actions/video/refine-timestamps.ts`
  - owner-only server action;
  - requires an existing COMPLETE transcript and `ELEVENLABS_API_KEY`;
  - checks the AI budget;
  - atomically guards duplicate PROCESSING requests in metadata;
  - queues the existing self-hosted inline/background pattern with `next/server after()`.
- `apps/web/workflows/transcribe.ts`
  - removed the automatic Scribe call from ordinary transcription;
  - added explicit `refineVideoTimestampsWorkflow()`;
  - re-reads the latest base VTT after Scribe returns, so transcript edits made during the call are not overwritten;
  - applies timing only when alignment is non-identity/high-enough confidence;
  - keeps the existing VTT on failure;
  - records Scribe usage as `elevenlabs-scribe-v2`;
  - best-effort copies corrected cue times to translated VTT files without changing translated text;
  - cleans temporary audio keys.
- `apps/web/lib/eleven-scribe.ts`
  - changed deprecated/removed `scribe_v1` to `scribe_v2`;
  - kept official Uzbek code `uzb` and word timestamps.
- `apps/web/lib/vtt-timing-transfer.ts`
  - added cue-count-guarded timing copy for translated VTTs.
- `packages/database/types/metadata.ts`
  - added per-file `timestampRefinement` status/diagnostics; no migration is needed because metadata is JSON.
- `apps/web/app/(org)/dashboard/caps/components/CapCard/CapCard.tsx`
  - added the per-file menu item, cost confirmation, start/error toasts, and PROCESSING label.
- `apps/web/messages/{uz,ru,en}.json`
  - added localized menu, confirmation, cost, and error strings.
- `CONTEXT.md`
  - records the final domain term and explicitly excludes a global setting.
- Tests:
  - new `refine-timestamps-action.test.ts`;
  - updated Scribe-transfer tests for explicit single-chunk refinement and low-confidence fallback;
  - added translated-VTT timing-copy tests.

## Fresh verification already run

- `pnpm typecheck` — exit 0.
- Focused Vitest set — 5 files, 27 tests passed:
  - `refine-timestamps-action.test.ts`
  - `transcribe-scribe-transfer.test.ts`
  - `vtt-timing-transfer.test.ts`
  - `transcribe-free-tier.test.ts`
  - `transcribe-batch-mode.test.ts`
- `NEXT_PUBLIC_DOCKER_BUILD=false pnpm --filter @cap/web build` — exit 0; production build completed.

The first browser check used an old `next start -p 3001` build, so the new menu item was not visible. The fresh production build completed afterward, but Codex stopped because the owner requested this handoff. Visual verification is still required.

## Required remaining work

### 1. Fix the dashboard card `...` trigger (tiny CSS-state fix)

Current trigger in `CapCard.tsx` is a 26×26 `rounded-md` button and can look rectangular/checkbox-like in open/focus state.

This is **not a redesign**. Final owner correction: the ellipsis should be icon-only, not a visible circular button. Preserve its placement, icon, menu, and behavior; remove the selected/checkbox-like surface.

Required result:

- visually show only the `...` icon in idle and open states;
- no persistent circle, rectangle, border, or selected background;
- keep an invisible hit target of at least 44×44 without changing card layout;
- hover/open may tint the icon subtly, but must not create a selected surface;
- retain a minimal keyboard-only `focus-visible` indicator for accessibility;
- must not resemble the selected-card checkbox;
- change only this dashboard card trigger, not other ellipsis buttons or card UI.

Prefer the smallest class-level fix: transparent 44×44 button, centered icon, no open-state background. Verify menu opening still works.

### 2. Fix the timestamp PROCESSING UI lifecycle

`isRefiningTimestamps` is initialized from props and set to `true` after the action starts, but it is not synchronized back to `false` when a later server refresh returns COMPLETE/ERROR. A long-lived card can therefore remain visually stuck until a full reload.

Keep the solution small. Derive/synchronize local pending state from `cap.metadata.timestampRefinement.status`, and make ERROR retryable. Do not add a large polling subsystem unless the existing dashboard already has a cheap refresh hook that can be reused.

### 3. Add one regression test for the product decision

Prove that ordinary `transcribeVideoWorkflow()` never calls Scribe even when `ELEVENLABS_API_KEY` exists. Scribe must run only from `refineVideoTimestampsWorkflow()`.

### 4. Review these correctness boundaries

- A background process crash can leave metadata at PROCESSING. Add only the smallest recovery needed (for example, treat an old PROCESSING timestamp as retryable); do not build a new job system.
- Background failure is stored as ERROR but currently has no post-completion toast. Ensure the menu label/state is understandable on the next refresh and permits retry.
- Confirm translated VTT synchronization preserves translated text and skips count mismatch without deleting anything.
- Confirm the latest base transcript text is the one written after the Scribe call; never overwrite edits made during refinement.
- Keep budget guard and owner authorization before any paid external call.

### 5. Visual QA (mandatory)

Start the fresh app on a separate port or restart the stale port-3001 server. Then inspect `/dashboard/meetings` and `/dashboard/caps`:

- desktop around 1280×720;
- mobile around 390×844;
- `...` remains icon-only and no longer becomes a rectangular/checkbox-like selected surface when the menu is open;
- menu item is visible and not clipped;
- confirmation clearly says Gemini text is unchanged and Scribe costs about `$0.22/audio hour`;
- cancel closes without a request;
- do not press the paid confirm button against live data unless the owner explicitly approves and a real key is configured;
- no horizontal overflow and no console errors.

Then run focused tests, `pnpm typecheck`, the project gate (`.claude/gate.cmd`), production build if the UI changed, and `git diff --stat`.

## Live environment and release constraints

- Live production currently has `GEMINI_API_KEY`, `GEMINI_API_KEY_FREE`, and `CRON_SECRET`.
- Live production **does not have `ELEVENLABS_API_KEY`**. The action correctly returns `missing_key`; do not put a key in source or docs.
- Scribe v2 cost is approximately `$0.22/audio hour` (about `$6.60` for 30 hours/month).
- Do not commit, push, deploy, or add the paid key without explicit owner approval.
- The repository already contains many unrelated dirty/untracked owner/Claude files. Preserve them and commit only an intentionally reviewed file list if approval later arrives.

## Expected final product behavior

1. Normal AI analysis creates Gemini text + Gemini timing and spends no Scribe money.
2. Owner chooses `...` → `Refine timestamps` on one file.
3. Confirmation explains text preservation and estimated cost.
4. After confirm, that file shows PROCESSING while work runs in the background.
5. Scribe v2 supplies word timing; alignment transfers timing onto the latest Gemini text.
6. High-confidence result replaces only VTT timing and updates translated cue timing safely.
7. Missing key, API error, or low-confidence alignment leaves the previous transcript/VTT untouched and shows a retryable ERROR state.
