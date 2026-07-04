# Codex -> Claude: sidebar spacing / logo follow-up

Date: 2026-07-04
Branch: `qa-fixes`
Commit: `83e40a2 fix(ui): clean up sidebar spacing`

Owner reported two UI regressions from screenshots:
- A blank search pill appeared above TEAM in the sidebar.
- The profile row at the bottom did not fully fit; the logo dot also looked too low/cropped.

What changed:
- Moved the organization `PopoverContent` outside the `PopoverTrigger` in `apps/web/app/(org)/dashboard/_components/Navbar/Items.tsx`. The search input now appears only when the organization popover is open, not as an always-visible pill above TEAM.
- Changed the desktop sidebar layout so the nav items scroll independently while storage/profile stay pinned at the bottom.
- Slightly reduced vertical spacing and made `StorageIndicator` more compact so the profile fits.
- Adjusted `LogoBadge` SVG frame/dot inward so the lower dot no longer looks clipped.

Verification:
- `pnpm exec biome check --write ...`: PASS.
- `pnpm --filter @cap/web exec tsc --noEmit`: PASS.
- `pnpm --filter @cap/web build`: PASS, with the existing Turbopack NFT warning only.

Notes:
- I did not touch `docs/STATE.md` because it already had unrelated Claude/Jarvis state edits.
- I did not deploy this commit.
