// @vitest-environment jsdom
//
// Pins the budget-display fix: both AI budget cards must read the saved
// budget from useDashboardContext().userPreferences (loaded fresh from the
// DB in dashboard-data.ts), NOT from user.preferences - resolveCurrentUser
// (app/Layout/current-user.ts) strips `preferences`, so the old read showed
// the "$10.00" default / "disabled" switch after every page refresh. The
// org card must also derive the effective cap from the user's personal
// budget when that cap is lower than the org-wide cap.
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatUzs } from "../../lib/format-uzs";

declare global {
	// eslint-disable-next-line no-var
	var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The dashboard context both cards consume. Each test sets state.ctx before
// importing/rendering a card. `user` deliberately has NO `preferences` field
// - that is exactly what resolveCurrentUser produces after a refresh, and it
// is what made the old `user?.preferences?.aiBudget` read fall back to the
// default.
const { state } = vi.hoisted(() => ({ state: { ctx: null as any } }));

vi.mock("../../app/(org)/dashboard/Contexts", () => ({
	useDashboardContext: () => state.ctx,
}));

// Server actions pull in @cap/database - mock at the module boundary.
vi.mock("@/actions/billing/get-monthly-spend", () => ({
	getMonthlySpend: () => Promise.resolve({ totalUsdCents: 0 }),
}));

vi.mock("@/actions/billing/save-ai-budget", () => ({
	saveAiBudget: () => Promise.resolve({ success: true }),
}));

vi.mock("sonner", () => ({
	toast: { success: () => {}, error: () => {} },
}));

vi.mock("@cap/ui", () => ({
	Button: ({ children }: { children?: ReactNode }) =>
		createElement("button", { type: "button" }, children),
	Card: ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children),
	CardDescription: ({ children }: { children?: ReactNode }) =>
		createElement("p", null, children),
	CardTitle: ({ children }: { children?: ReactNode }) =>
		createElement("h3", null, children),
	Switch: ({ checked }: { checked?: boolean }) =>
		createElement("input", {
			type: "checkbox",
			"data-testid": "budget-switch",
			checked: checked ?? false,
			readOnly: true,
		}),
}));

function buildContext(userAiBudget: any = {
	monthlyUsdCents: 10000,
	alertAtPct: 80,
	enabled: true,
}) {
	return {
		user: { id: "user-1", name: "Owner", email: "o@example.com" },
		userPreferences: { aiBudget: userAiBudget },
		activeOrganization: {
			organization: {
				id: "org-1",
				ownerId: "user-1",
				settings: {
					aiBudget: { monthlyUsdCents: 10000, alertAtPct: 75, enabled: true },
				},
			},
			members: [{ userId: "user-1", role: "owner" }],
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
	if (root) {
		act(() => {
			root?.unmount();
		});
	}
	if (container) container.remove();
	container = null;
	root = null;
	vi.resetModules();
});

async function renderCard(componentPath: string, ctx: any) {
	state.ctx = ctx;
	const { AiBudgetCard } = await import(componentPath);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	// Async act flushes the getMonthlySpend promise so the spent-this-month
	// state update lands inside act instead of leaking after the test.
	await act(async () => {
		root?.render(createElement(AiBudgetCard));
	});
	return container;
}

describe("AiBudgetCard reads the saved budget from userPreferences", () => {
	it("account card shows the saved $100.00 cap and enabled switch, not the $10.00 default", async () => {
		const el = await renderCard(
			"../../app/(org)/dashboard/settings/account/components/AiBudgetCard",
			buildContext(),
		);
		const input = el.querySelector(
			'input[type="number"]',
		) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		expect(input?.value).toBe("100.00");

		const sw = el.querySelector(
			'[data-testid="budget-switch"]',
		) as HTMLInputElement | null;
		expect(sw?.checked).toBe(true);
	});

	it("org card shows the personal effective cap when it is lower than the org cap", async () => {
		const el = await renderCard(
			"../../app/(org)/dashboard/settings/organization/components/AiBudgetCard",
			buildContext({ monthlyUsdCents: 500, alertAtPct: 80, enabled: true }),
		);
		// Org cap is $100 (10000 cents); the user's personal cap is $5 (500
		// cents), so the card must surface the $5 effective cap.
		expect(el.textContent).toContain(
			`Your effective cap: ${formatUzs(500)} (limited by your personal budget)`,
		);
	});
});
