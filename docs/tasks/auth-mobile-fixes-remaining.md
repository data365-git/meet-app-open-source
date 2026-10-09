# Spec: Auth screen mobile UX fixes — remaining 8 defects

## Goal
Apply the remaining mobile-first UI/UX defect fixes to the onboarding + layout files.
Do NOT touch: git, docs/STATE.md, globals.css, tailwind.config.*, packages/ui/**

## Files to edit (ONLY these)
1. apps/web/app/(org)/onboarding/components/Base.tsx
2. apps/web/app/(org)/onboarding/components/InviteTeamPage.tsx
3. apps/web/app/(org)/onboarding/components/CustomDomainPage.tsx
4. apps/web/app/(org)/onboarding/components/Stepper.tsx
5. apps/web/app/(org)/onboarding/components/DownloadPage.tsx
6. apps/web/app/(org)/onboarding/layout.tsx

## Style rules
- This repo uses TABS for indentation. Keep tabs, do not reformat whole files.
- Mobile-first: add sm:/lg: overrides to keep desktop >= 1024px unchanged.
- Keep ALL existing handlers/logic/data intact. No new dependencies.

---

## Fix A — Base.tsx line 28-29 (touch-target + radius + active state)

Current:
```
className="absolute overflow-hidden flex top-5 rounded-full left-5 z-20 hover:bg-gray-1 gap-2 items-center py-1.5 px-3 text-gray-12 bg-transparent border border-gray-4 transition-colors duration-300 cursor-pointer"
```

Change:
- `py-1.5` → `py-2.5` (increases vertical padding to hit ~44px height)
- Add `min-h-[44px]` explicitly
- `rounded-full` → `rounded-lg` (nav control, not CTA pill)
- Add `active:bg-gray-1` alongside `hover:bg-gray-1`

New className (keep all other classes, only change listed ones):
```
className="absolute overflow-hidden flex top-5 rounded-lg left-5 z-20 hover:bg-gray-1 active:bg-gray-1 gap-2 items-center min-h-[44px] py-2.5 px-3 text-gray-12 bg-transparent border border-gray-4 transition-colors duration-300 cursor-pointer"
```

---

## Fix B — InviteTeamPage.tsx line ~181-203 (increment/decrement touch targets)

Current on BOTH the decrement and increment Button elements:
```
className="p-1 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
```

Change to (both buttons get the same update):
```
className="min-h-[44px] min-w-[44px] p-2 bg-gray-12 hover:bg-gray-11 flex items-center justify-center"
```

---

## Fix C — InviteTeamPage.tsx line ~177 (remove xs:rounded-full)

Current outer container div of the user-count + billing-cycle row:
```
className="flex flex-wrap gap-5 justify-center items-center p-5 w-full rounded-xl border bg-gray-3 border-gray-4 xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between"
```

Remove `xs:rounded-full` so it becomes:
```
className="flex flex-wrap gap-5 justify-center items-center p-5 w-full rounded-xl border bg-gray-3 border-gray-4 xs:gap-3 xs:p-3 xs:justify-between"
```

---

## Fix D — InviteTeamPage.tsx line ~243-251 (demote Skip to transparent)

Current:
```tsx
<Button
  variant="dark"
  className="mx-auto w-full"
  onClick={handleSubmit}
  spinner={inviteTeamMutation.isPending}
  disabled={inviteTeamMutation.isPending}
>
  Skip
</Button>
```

Change `variant="dark"` to `variant="transparent"`:
```tsx
<Button
  variant="transparent"
  className="mx-auto w-full"
  onClick={handleSubmit}
  spinner={inviteTeamMutation.isPending}
  disabled={inviteTeamMutation.isPending}
>
  Skip
</Button>
```

---

## Fix E — CustomDomainPage.tsx line ~63-72 (demote Skip to transparent)

Current:
```tsx
<Button
  type="button"
  variant="dark"
  spinner={customDomainMutation.isPending}
  disabled={customDomainMutation.isPending}
  className="mx-auto w-full"
  onClick={() => handleSubmit()}
>
  Skip
</Button>
```

Change `variant="dark"` to `variant="transparent"`:
```tsx
<Button
  type="button"
  variant="transparent"
  spinner={customDomainMutation.isPending}
  disabled={customDomainMutation.isPending}
  className="mx-auto w-full"
  onClick={() => handleSubmit()}
>
  Skip
</Button>
```

---

## Fix F — Stepper.tsx line ~66 (desktop stepper: absolute → sticky)

Current desktop stepper div:
```
className="hidden absolute right-0 left-0 top-6 justify-center items-center p-4 mx-auto rounded-xl border lg:flex max-w-fit bg-gray-2 border-gray-4"
```

Change `absolute` to `sticky` (keep all other classes):
```
className="hidden sticky right-0 left-0 top-6 justify-center items-center p-4 mx-auto rounded-xl border lg:flex max-w-fit bg-gray-2 border-gray-4"
```

---

## Fix G — DownloadPage.tsx line ~69-77 (show download button on all screen sizes)

Current Button:
```tsx
<Button
  variant="blue"
  size="lg"
  href={getDownloadUrl(platform, isIntel)}
  className="hidden justify-center items-center py-6 font-medium text-white lg:flex"
>
```

Remove `hidden` and `lg:flex`, show on all sizes:
```tsx
<Button
  variant="blue"
  size="lg"
  href={getDownloadUrl(platform, isIntel)}
  className="flex justify-center items-center py-6 font-medium text-white"
>
```

---

## Fix H — onboarding/layout.tsx line 14 (iOS safe area bottom padding)

Current layout div:
```
className="flex relative flex-col justify-center items-center px-5 py-10 w-full custom-scroll min-h-fit lg:min-h-auto h-dvh bg-gray-1"
```

Add `pb-[env(safe-area-inset-bottom)]` to the end of className:
```
className="flex relative flex-col justify-center items-center px-5 py-10 w-full custom-scroll min-h-fit lg:min-h-auto h-dvh bg-gray-1 pb-[env(safe-area-inset-bottom)]"
```

---

## Acceptance criteria
- All 8 changes applied exactly as described
- No logic/handlers altered
- No whole-file reformats (keep existing indentation/whitespace)
- No new imports added unless truly required (these fixes need none)

## Report
Return: list of files changed + one line per change made.
