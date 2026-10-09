"use server";

import bcrypt from "bcryptjs";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";

type SignUpResult = { success: true } | { success: false; error: string };

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmailDomainAllowed(email: string): boolean {
	const allowed = serverEnv().CAP_ALLOWED_SIGNUP_DOMAINS;
	if (!allowed) return true;

	const domains = allowed
		.split(",")
		.map((d) => d.trim().toLowerCase())
		.filter(Boolean);

	if (domains.length === 0) return true;

	const emailDomain = email.split("@")[1]?.toLowerCase();
	if (!emailDomain) return false;

	return domains.includes(emailDomain);
}

/**
 * Open, public sign-up: anyone can self-register with name + email + password.
 *
 * A self-signup creates an ACCOUNT ONLY — no organization membership and no
 * active/default organization. Such a user is a "requester": they can sign in,
 * but until the platform admin explicitly adds them to the workspace (see
 * `approveRequest` in `actions/admin/access.ts`) they only see a pending
 * screen. This keeps the owner's workspace closed to strangers while still
 * capturing interested users as sales leads.
 *
 * Security guarantees:
 * - Never sets `isAdmin` (platform admin), so a self-signup can never become a
 *   platform admin.
 * - Never joins any organization, so a self-signup cannot read or record any
 *   workspace content until an admin approves them.
 * - Passwords are hashed with bcrypt (same path as the admin seed + invite
 *   flow); plaintext is never stored.
 * - All DB access is parameterised via Drizzle (no SQL/email injection).
 */
export async function signUp(
	name: string,
	email: string,
	password: string,
): Promise<SignUpResult> {
	const trimmedName = name.trim();
	const normalizedEmail = email.trim().toLowerCase();

	if (!trimmedName) {
		return { success: false, error: "Please enter your name." };
	}

	if (!EMAIL_REGEX.test(normalizedEmail)) {
		return { success: false, error: "Please enter a valid email address." };
	}

	if (!password || password.length < 8) {
		return {
			success: false,
			error: "Password must be at least 8 characters.",
		};
	}

	if (!isEmailDomainAllowed(normalizedEmail)) {
		return {
			success: false,
			error: "Sign-ups are not allowed for this email domain.",
		};
	}

	// Reject duplicate accounts up front for a clear message.
	const [existingUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, normalizedEmail))
		.limit(1);

	if (existingUser) {
		return {
			success: false,
			error:
				"An account with this email already exists. Please sign in instead.",
		};
	}

	const passwordHash = await bcrypt.hash(password, 10);
	const userId = nanoId() as User.UserId;

	try {
		await db().transaction(async (tx) => {
			// Guard against a race: re-check the email inside the transaction.
			const [racedUser] = await tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, normalizedEmail))
				.limit(1);

			if (racedUser) {
				throw new Error("EMAIL_TAKEN");
			}

			await tx.insert(users).values({
				id: userId,
				email: normalizedEmail,
				name: trimmedName,
				passwordHash,
				emailVerified: new Date(),
				inviteQuota: 1,
				// isAdmin omitted -> defaults to false. Never grant admin here.
				// No defaultOrgId and no organizationMembers row: a self-signup
				// joins no workspace until an admin approves it. The column is
				// nullable in the database (`varchar(15)`, migration 0000), but the
				// shared `nanoId` column helper types it as non-null, hence the cast.
				activeOrganizationId: null as unknown as Organisation.OrganisationId,
			});
		});
	} catch (error) {
		if (error instanceof Error && error.message === "EMAIL_TAKEN") {
			return {
				success: false,
				error:
					"An account with this email already exists. Please sign in instead.",
			};
		}
		return {
			success: false,
			error: "Something went wrong. Please try again.",
		};
	}

	return { success: true };
}
