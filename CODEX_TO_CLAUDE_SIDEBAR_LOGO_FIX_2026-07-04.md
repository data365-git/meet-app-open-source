# Codex handoff: sidebar logo + new recording layout fix

Date: 2026-07-04
Author: Codex
Branch observed: `qa-fixes`

## Why this exists

Owner pointed at the desktop/sidebar screenshots and said the app icon is wrong, and the `TEAM` / `New recording` area is visually misplaced. Owner later provided a better blue rounded-square video icon direction and asked to replace my earlier generated mark with that new one.

Important coordination note: Claude appears to be doing other work in this repo. I did not deploy, push, commit, or touch Claude's modified file.

## Files changed by Codex

```text
packages/ui/src/components/icons/LogoBadge.tsx
apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx
```

## What changed

### `LogoBadge.tsx`

Replaced the previous badge mark with the owner's preferred blue video icon direction:

- blue rounded-square app badge
- white rounded video-frame outline
- white play triangle
- mint/green status dot at the lower-right frame gap
- `useId()` used for gradient IDs so multiple logos on the same page do not duplicate static SVG IDs

This affects every place using `LogoBadge`, including login/signup/mobile header/sidebar/share branding.

### `Navbar/Items.tsx`

Adjusted the sidebar top rhythm:

- organization selector (`TEAM`) is now visually separated as a real selector card
- added spacing between the organization selector and the primary `New recording` button
- on mobile drawer specifically, `TEAM` now has more bottom breathing room before `New recording`
- `New recording` button now uses a proper `Video` icon instead of the small dot
- button height/radius/shadow were slightly improved
- removed stale `RecordIcon` import
- added missing `t` dependency in `SidebarUser` `useMemo` after Biome flagged it
- mobile profile actions are no longer always inline; tapping the profile row opens a local overlay menu above the profile row
- the mobile profile menu is intentionally not a Radix portal, so it should not fall behind the drawer or be closed by click-away before the item action runs
- rollback is simple: restore the `inline` branch of `SidebarUser` in `Navbar/Items.tsx` to the previous always-inline menu block

## Validation already run

```text
pnpm --filter @cap/web exec tsc --noEmit
pnpm exec biome check --write packages/ui/src/components/icons/LogoBadge.tsx apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx
pnpm --filter @cap/web build
```

All passed.

Build still has the pre-existing Turbopack NFT warning around `audio-extract.ts` / transcription route. This is unrelated to this UI fix.

## Not done

- Not deployed live.
- Not pushed.
- Not committed.
- Local visual screenshot was attempted on `localhost:3001`, but local credentials returned `401`; likely local auth/env mismatch. Typecheck, Biome, and production build are green.

## Current coordination warning

At the time this note was written, `git status --short` also showed:

```text
M apps/web/workflows/generate-ai.ts
```

That file was not changed by Codex in this sidebar/logo pass. Treat it as Claude/user work and do not overwrite it.

## Suggested next step for Claude

If continuing this exact UI fix:

1. Review the two changed files above.
2. Pull these changes into Claude's current working set without reverting `apps/web/workflows/generate-ai.ts`.
3. Run a quick visual check on the desktop sidebar and mobile header.
4. If approved by owner, include it in Claude's next single deploy batch.
