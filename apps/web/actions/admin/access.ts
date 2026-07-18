"use server";

import bcrypt from "bcryptjs";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	authApiKeys,
	invites,
	users,
	organizations,
	organizationMembers,
} from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { and, eq, desc, sql } from "drizzle-orm";
import { buildEnv } from "@cap/env";

async function requireAdmin() {
	const user = await getCurrentUser();
	if (!user || !user.isAdmin) {
		throw new Error("Unauthorized: admin access required");
	}
	return user;
}

export async function getUsers() {
	await requireAdmin();

	const allUsers = await db()
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			isAdmin: users.isAdmin,
			createdAt: users.created_at,
			accessDisabled: sql<boolean>`${users.passwordHash} IS NULL`.mapWith(
				Boolean,
			),
		})
		.from(users)
		.orderBy(desc(users.created_at));

	return allUsers;
}

/**
 * The workspace an approved requester is added to: the admin's own default
 * organization, falling back to the organization they own.
 */
async function getAdminOrganizationId(admin: {
	id: User.UserId;
	defaultOrgId: Organisation.OrganisationId | null;
}): Promise<Organisation.OrganisationId | null> {
	if (admin.defaultOrgId) return admin.defaultOrgId;

	const [ownedOrg] = await db()
		.select({ id: organizations.id })
		.from(organizations)
		.where(eq(organizations.ownerId, admin.id))
		.limit(1);

	return ownedOrg?.id ?? null;
}

/**
 * Users who signed up themselves but belong to no organization yet. These are
 * sales leads waiting for the owner to open a workspace for them. Users whose
 * access has been revoked (no passwordHash) are excluded, so dismissing a
 * request via `revokeUser` removes it from this list.
 */
export async function getPendingRequests() {
	await requireAdmin();

	const [allUsers, memberships] = await Promise.all([
		db()
			.select({
				id: users.id,
				name: users.name,
				email: users.email,
				isAdmin: users.isAdmin,
				createdAt: users.created_at,
				passwordHash: users.passwordHash,
			})
			.from(users)
			.orderBy(desc(users.created_at)),
		db()
			.select({ userId: organizationMembers.userId })
			.from(organizationMembers),
	]);

	const memberIds = new Set(memberships.map((m) => m.userId));

	return allUsers
		.filter((u) => !memberIds.has(u.id) && !u.isAdmin && u.passwordHash)
		.map(({ passwordHash: _passwordHash, ...u }) => u);
}

/**
 * Approve a requester: add them to the admin's workspace as a regular member.
 * Mirrors the membership grant in the organization-invite redemption path.
 */
export async function approveRequest(userId: string) {
	const admin = await requireAdmin();

	const organizationId = await getAdminOrganizationId(admin);
	if (!organizationId) {
		return {
			success: false as const,
			error: "No workspace found to add this member to.",
		};
	}

	const [targetUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId as User.UserId))
		.limit(1);

	if (!targetUser) {
		return { success: false as const, error: "User not found." };
	}

	await db().transaction(async (tx) => {
		const [existingMembership] = await tx
			.select({ id: organizationMembers.id })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.userId, userId as User.UserId),
					eq(organizationMembers.organizationId, organizationId),
				),
			)
			.limit(1);

		if (!existingMembership) {
			await tx.insert(organizationMembers).values({
				id: nanoId(),
				userId: userId as User.UserId,
				organizationId,
				// Lowest privilege role. Never owner/admin via approval.
				role: "member",
			});
		}

		await tx
			.update(users)
			.set({ activeOrganizationId: organizationId, defaultOrgId: organizationId })
			.where(eq(users.id, userId as User.UserId));
	});

	return { success: true as const };
}

export async function createUser(
	email: string,
	password: string,
	name: string,
) {
	await requireAdmin();

	const normalizedEmail = email.trim().toLowerCase();

	// Check if user already exists
	const [existingUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, normalizedEmail))
		.limit(1);

	if (existingUser) {
		return { success: false as const, error: "A user with this email already exists." };
	}

	const passwordHash = await bcrypt.hash(password, 10);
	const userId = nanoId() as User.UserId;
	const organizationId = Organisation.OrganisationId.make(nanoId());

	// Create the default personal organization
	await db().insert(organizations).values({
		id: organizationId,
		ownerId: userId,
		name: `${name}'s Organization`,
	});

	// Create the user
	await db().insert(users).values({
		id: userId,
		email: normalizedEmail,
		name,
		passwordHash,
		emailVerified: new Date(),
		activeOrganizationId: organizationId,
		defaultOrgId: organizationId,
		inviteQuota: 1,
	});

	// Add user as owner of their org
	await db().insert(organizationMembers).values({
		id: nanoId(),
		userId,
		organizationId,
		role: "owner",
	});

	return { success: true as const };
}

export async function generateInviteLink(
	email?: string,
	expiresInDays?: number,
) {
	const admin = await requireAdmin();

	const token = crypto.randomUUID();
	const days = expiresInDays ?? 7;
	const expiresAt = new Date();
	expiresAt.setDate(expiresAt.getDate() + days);

	await db().insert(invites).values({
		id: nanoId(),
		token,
		email: email?.trim().toLowerCase() || null,
		createdByUserId: admin.id,
		expiresAt,
	});

	const inviteUrl = `${buildEnv.NEXT_PUBLIC_WEB_URL}/invite/${token}`;

	return { success: true as const, inviteUrl, token };
}

export async function getInvites() {
	await requireAdmin();

	const allInvites = await db()
		.select({
			id: invites.id,
			token: invites.token,
			email: invites.email,
			usedByUserId: invites.usedByUserId,
			expiresAt: invites.expiresAt,
			createdAt: invites.createdAt,
		})
		.from(invites)
		.orderBy(desc(invites.createdAt));

	return allInvites.map((inv) => ({
		...inv,
		status: inv.usedByUserId
			? ("used" as const)
			: inv.expiresAt < new Date()
				? ("expired" as const)
				: ("pending" as const),
	}));
}

export async function revokeUser(userId: string) {
	const admin = await requireAdmin();

	if (admin.id === userId) {
		return { success: false as const, error: "You cannot revoke your own access." };
	}

	// Verify the target user exists
	const [targetUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId as User.UserId))
		.limit(1);

	if (!targetUser) {
		return { success: false as const, error: "User not found." };
	}

	// Soft-disable by clearing passwordHash (prevents login), bumping authSessionVersion
	// (invalidates active sessions), and deleting all API/extension keys (prevents
	// cak_... bearer auth from surviving revocation). Atomic: all-or-nothing.
	await db().transaction(async (tx) => {
		await tx
			.update(users)
			.set({ passwordHash: null, authSessionVersion: sql`${users.authSessionVersion} + 1` })
			.where(eq(users.id, userId as User.UserId));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, userId as User.UserId));
	});

	return { success: true as const };
}

export async function resetUserPassword(userId: string, newPassword: string) {
	await requireAdmin();

	if (!newPassword || newPassword.length < 8) {
		return { success: false as const, error: "Password must be at least 8 characters." };
	}

	const [targetUser] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, userId as User.UserId))
		.limit(1);

	if (!targetUser) {
		return { success: false as const, error: "User not found." };
	}

	const passwordHash = await bcrypt.hash(newPassword, 10);

	// Bumping authSessionVersion kills issued JWTs, but the cak_ bearer path
	// checks neither passwordHash nor authSessionVersion — so without deleting
	// the rows, a reset left the user's extension/API token fully valid. That
	// defeats the usual reason to reset: the account is compromised.
	// This is the SECOND admin reset path (the email-based one in
	// reset-user-password.ts is the other); fixing one and missing its twin is
	// exactly how this defect survived. Atomic — a partial revocation is worse
	// than none because it still reports success.
	await db().transaction(async (tx) => {
		await tx
			.update(users)
			.set({
				passwordHash,
				authSessionVersion: sql`${users.authSessionVersion} + 1`,
			})
			.where(eq(users.id, userId as User.UserId));
		await tx
			.delete(authApiKeys)
			.where(eq(authApiKeys.userId, userId as User.UserId));
	});

	return { success: true as const };
}

export async function toggleUserAdmin(userId: string) {
	const admin = await requireAdmin();

	if (admin.id === userId) {
		return { success: false as const, error: "You cannot change your own admin status." };
	}

	const [targetUser] = await db()
		.select({ id: users.id, isAdmin: users.isAdmin })
		.from(users)
		.where(eq(users.id, userId as User.UserId))
		.limit(1);

	if (!targetUser) {
		return { success: false as const, error: "User not found." };
	}

	await db()
		.update(users)
		.set({ isAdmin: !targetUser.isAdmin })
		.where(eq(users.id, userId as User.UserId));

	return { success: true as const, isAdmin: !targetUser.isAdmin };
}

export async function revokeInvite(inviteId: string) {
	await requireAdmin();

	await db().delete(invites).where(eq(invites.id, inviteId));

	return { success: true as const };
}
