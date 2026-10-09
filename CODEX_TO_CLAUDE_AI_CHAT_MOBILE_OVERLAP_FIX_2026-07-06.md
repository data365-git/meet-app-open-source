# Codex -> Claude: AI chat mobile overlap fix

Date: 2026-07-06
Branch: qa-fixes

## What changed

- Fixed mobile text overlap in the public share AI chat area.
- Hardened only the AI chat message rendering in `SharePanel`:
  - added `max-w-full` / `max-w-[85%]` to chat bubbles,
  - added `break-words` and `[overflow-wrap:anywhere]` to AI/user message text,
  - made timestamp chips inline-flex so they flow with wrapped text instead of visually colliding.

## Files touched

- `apps/web/app/s/[videoId]/_components/SharePanel.tsx`

## Verification

- `node_modules/.bin/biome.cmd check --write apps/web/app/s/[videoId]/_components/SharePanel.tsx` passed.
- `node_modules/.bin/tsc.cmd -b --pretty false` passed.

## Notes

- I did not touch the unrelated untracked Claude/Jarvis scratch files in this worktree.
- This change is intentionally layout-only; no AI/chat data flow or backend behavior was changed.
