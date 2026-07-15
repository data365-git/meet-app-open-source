"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { locales } from "@/i18n/locales";

export async function setLanguage(locale: string): Promise<{ success: true }> {
	if (!(locales as readonly string[]).includes(locale)) {
		throw new Error(`Invalid locale: ${locale}`);
	}

	(await cookies()).set("NEXT_LOCALE", locale, {
		maxAge: 365 * 24 * 60 * 60,
		path: "/",
		sameSite: "lax",
	});

	const user = await getCurrentUser();
	if (user) {
		const [row] = await db()
			.select({ preferences: users.preferences })
			.from(users)
			.where(eq(users.id, user.id))
			.limit(1);

		const current = (row?.preferences as Record<string, unknown> | null) ?? {};

		await db()
			.update(users)
			.set({
				preferences: {
					...current,
					locale,
				} as typeof users.$inferSelect.preferences,
			})
			.where(eq(users.id, user.id));
	}

	return { success: true };
}

// Called once, right after a successful login, to make the account-level
// language preference (DB) follow the user to a fresh/cookieless browser.
// Cheap: one indexed lookup on the user that just authenticated, not a
// per-request read (i18n/request.ts still resolves purely from the cookie).
export async function syncLocaleFromPreferences(): Promise<void> {
	const user = await getCurrentUser();
	if (!user) return;

	const [row] = await db()
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, user.id))
		.limit(1);

	const locale = (row?.preferences as Record<string, unknown> | null)
		?.locale;
	if (typeof locale !== "string" || !(locales as readonly string[]).includes(locale)) {
		return;
	}

	(await cookies()).set("NEXT_LOCALE", locale, {
		maxAge: 365 * 24 * 60 * 60,
		path: "/",
		sameSite: "lax",
	});
}
