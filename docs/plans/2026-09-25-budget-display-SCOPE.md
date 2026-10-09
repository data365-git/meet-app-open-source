# AI budget card shows $10 after refresh (owner report 2026-09-25)

SCOPE: Settings → Account/Organization "AI Budget Limit" cards read the user budget from
`useDashboardContext().user.preferences.aiBudget`, but that `user` comes from
`resolveCurrentUser` (app/Layout/current-user.ts), which strips `preferences`. So after a
refresh the account card always shows the default "$10.00" + disabled, although the DB holds
the saved value (prod 2026-09-25: user 100000 cents enabled, org 10000 cents enabled). A save
from that stale form overwrites the real cap with $10 — the likely origin of the odd $11.63 org
cap that silently blocked all AI today.
METRIC: a jsdom test renders each card with context `userPreferences.aiBudget = {monthlyUsdCents: 10000, enabled: true}`
and asserts the input shows 100.00 (account) / the matching som value and the switch is on;
RED on the current code, GREEN after. Root typecheck 0.
DIRECTION: read `userPreferences` from the dashboard context (already loaded fresh from the DB in
dashboard-data.ts:328) instead of the stripped `user`; no other change.
