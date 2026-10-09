# Codex — F003/F033: fix broken ORGANIZATION invite links

RULES: own ONLY the invite-related files; no other files; no git; no typecheck/build (shared type output is owned elsewhere). DB changes ADDITIVE only (never drop/rename a column or table). Minimal + type-safe.

BUG: Organization email invites are 100% broken. `apps/web/actions/organization/send-invites.ts` builds the invite URL as `/invite/${record.id}` (a row id), but the claim page `/invite/[token]` (and its `ClaimInvite` component / validate+redeem logic) only checks the `invites` (admin) table — it never resolves `organization_invites`. So every org invite link shows "Invalid invite link" and org membership is never granted.

FILES (find exact paths; likely): `apps/web/actions/organization/send-invites.ts`, `apps/web/actions/organization/invite-by-email.ts`, the `/invite/[token]` route + `ClaimInvite` component + the validate/redeem code (search `validateInviteToken`, `redeemInvite`, `organization_invites`, `organizationInvites`).

FIX:
1. Org invite emails must link with a TOKEN that the claim flow can resolve from `organization_invites` (not an unrelated row id).
2. The claim flow (`/invite/[token]` validate + redeem) must resolve org invites from `organization_invites` (by token) AND grant the organization membership on accept. If there are two tables (`invites` admin + `organization_invites` org), make the claim flow check the org table too — WITHOUT breaking the existing admin-invite path.
3. Keep it minimal; do NOT redesign the schema. Confirm the end-to-end path: emailed link → claim page resolves it → user joins the org.

REPORT: files changed, the exact fix, and confirmation that BOTH the admin-invite and the org-invite claim paths work. No git/typecheck.
