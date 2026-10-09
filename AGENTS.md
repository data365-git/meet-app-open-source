# AGENTS.md — working guide for Codex (and any coding agent)

This file is for Codex the way `CLAUDE.md` is for Claude. Read it first, then
work like the other agent on this repo would. Goal: **anyone can pick the
project up and continue seamlessly.**

## 1. Start every session here (resume protocol)

1. **Read `docs/STATE.md` FIRST.** Its TOP block is the single source of truth
   for where the project is *right now* — last commits (with hashes), the next
   step, blockers, and `OWNER TODO:` items. Continue from there; do not restart.
2. Read `CLAUDE.md` (project rules) — the essentials are mirrored below.
3. Cross-check "what's left" against `git log --oneline -20`. STATE can lag
   behind real commits — **git is the source of truth for what shipped.**
4. When you finish a chunk, UPDATE `docs/STATE.md`'s top block (last done +
   commit hash + next step) so the next agent resumes cleanly.

## 2. What this is

**Ustoz / data365** — a self-hosted Loom-style screen recorder + AI meeting
notes. Next.js, pnpm monorepo; the web app is in `apps/web`. Uzbek-facing
product. The owner is a **non-programmer** — talk to him in **simple Uzbek**,
but write all repo files, commits, and docs in **English**. He decides WHAT to
build; the agent decides HOW (but consult before new scope / money / deploy).

## 3. Gates — must pass before you say "done" or commit

Run from repo root:

- `pnpm --filter @cap/web exec tsc --noEmit` → 0 errors
- `pnpm --filter @cap/web build` → **REQUIRED.** Only `next build` catches
  `"use server"` async-export violations that tsc + tests miss.
- `pnpm --filter @cap/web run test` (vitest) for the areas you touched.
- **Diff hygiene:** compare `git diff --stat` with
  `git diff --stat -w --ignore-cr-at-eol`. If they differ, a whole-file
  line-ending (CRLF↔LF) or indentation reformat slipped in — fix it, never
  commit reformats. Match each file's existing endings (most `.tsx` here = LF,
  tabs for indent).

A test MUST fail when the feature is broken. Never weaken assertions or add
always-pass scripts to get green.

## 4. Deploy

- Branch **`qa-fixes`** is the deploy branch: **push = auto-deploy to Railway.**
- **Do NOT push or deploy without explicit owner approval.** Work stays LOCAL
  until the owner reviews and says "deploy".
- Before deploy: full gates green + confirm no live `PROCESSING` transcription
  job is running. After deploy: verify the live build (health + a real screen),
  don't just trust "build succeeded".

## 5. Working rules

- **One committer at a time.** Parallel agents editing the tree + running git =
  races. Serialize commits; scope each agent to a disjoint file set.
- **Surgical changes only.** Touch only what the task needs; match existing
  style. Don't refactor unrelated code.
- **Correctness-critical / billing / pipeline / security** changes get an
  independent adversarial review (a different model, or a fresh reviewer that
  sees only the diff) BEFORE commit.
- **Design:** follow `docs/design-handoff-2026-07/README.md` and the
  `--brand` + Radix token system. NEVER touch shadcn `--accent` / `--border`.
- **i18n:** translate for **understanding**, not literal correctness — natural
  Uzbek; keep the common/English term when the literal is obscure (e.g.
  "Extension", not "kengaytma"). Keep all three catalogs
  (`apps/web/messages/{uz,ru,en}.json`) key-synced and valid JSON. The
  native-speaker owner reviews Uzbek strings.
- **Transcription model:** `gemini-3-flash-preview` (both the sync path in
  `apps/web/lib/gemini-transcribe.ts` and the batch/"Arzon" path in
  `apps/web/lib/gemini-batch-transcribe.ts`). Batch jobs poll `BATCH_STATE_*`.

## 6. Where things are

- Resume board: `docs/STATE.md`
- Project rules: `CLAUDE.md`
- Design master + specs: `docs/design-handoff-2026-07/README.md`,
  `apps/web/scratchpad/data365-design/specs/`
- Plans: `docs/plans/`
- Deploy / ops: `DEPLOY.md`, `OPERATIONS.md`, `RAILWAY_ENV.md`
- Pipeline overview: `PIPELINE_MAP.md`

## 7. Tests

- Unit: `pnpm --filter @cap/web run test` (Vitest)
- E2E: Playwright in `apps/web/e2e/` (dev server on :3001 must be running)
