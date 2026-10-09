"use server";

import bcrypt from "bcryptjs";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { authApiKeys, users } from "@cap/database/schema";
import { eq, sql } from "drizzle-orm";

type ResetPasswordResult = { success: true } | { success: false; error: string };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function resetUserPassword(
	email: string,
	newPassword: string,
): Promise<ResetPasswordResult> {
	const admin = await getCurrentUser();
	if (!admin?.isAdmin) {
		return { success: false, error: "Not authorized" };
	}

	const normalizedEmail = email.trim().toLowerCase();

	if (!EMAIL_REGEX.test(normalizedEmail)) {
		return { success: false, error: "Please enter a valid email address." };
	}

	if (!newPassword || newPassword.length < 8) {
		return {
			success: false,
			error: "Password must be at least 8 characters.",
		};
	}

	try {
		const [target] = await db()
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, normalizedEmail))
			.limit(1);

		if (!target) {
			return { success: false, error: "User not found" };
		}

		const passwordHash = await bcrypt.hash(newPassword, 10);

		// A password reset that leaves the old credentials working is not a
		// reset. Setting only passwordHash left an attacker's existing session
		// cookie AND their extension/API token fully valid, so the usual reason
		// to reset — the account is compromised — was exactly the case it did
		// not solve. Bumping authSessionVersion invalidates issued JWTs, and the
		// cak_ bearer path checks neither passwordHash nor authSessionVersion,
		// so those rows must be deleted outright. Atomic: a partial revocation
		// is worse than none because it reports success.
		// The sibling admin path in actions/admin/access.ts already did this;
		// this file is its twin and was missed.
		await db().transaction(async (tx) => {
			await tx
				.update(users)
				.set({
					passwordHash,
					authSessionVersion: sql`${users.authSessionVersion} + 1`,
				})
				.where(eq(users.id, target.id));
			await tx.delete(authApiKeys).where(eq(authApiKeys.userId, target.id));
		});

		return { success: true };
	} catch (error) {
		console.error("[resetUserPassword] Failed to reset password", error);
		return { success: false, error: "Failed to reset password" };
	}
}
