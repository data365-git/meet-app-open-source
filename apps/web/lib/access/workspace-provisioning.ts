import "server-only";

import { db } from "@cap/database";
import { organizationMembers } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * Owner's access model: a self-signup is a REQUESTER — an account with no
 * organization membership, parked on the pending screen until an admin adds
 * them. Requesters must not be able to hand themselves a workspace, because a
 * workspace is what unlocks recording and paid AI on the owner's bill.
 *
 * Blocking the dashboard render is not enough: the org-creating paths
 * (`createOrganization`, and the onboarding RPC's "skip to dashboard" /
 * organizationSetup branches) are reachable directly by any signed-in user.
 * This is the shared gate for all of them.
 *
 * Allowed: platform admins, and anyone who ALREADY belongs to an organization
 * (a real member creating an additional workspace is legitimate).
 */
export async function mayProvisionWorkspace(
	user: { id: User.UserId; isAdmin?: boolean | null } | null | undefined,
): Promise<boolean> {
	if (!user) return false;
	if (user.isAdmin) return true;

	const [membership] = await db()
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(eq(organizationMembers.userId, user.id))
		.limit(1);

	return Boolean(membership);
}

export async function assertMayProvisionWorkspace(
	user: { id: User.UserId; isAdmin?: boolean | null } | null | undefined,
): Promise<void> {
	if (!(await mayProvisionWorkspace(user))) {
		throw new Error(
			"Unauthorized: your account is not part of a workspace yet. An admin must add you first.",
		);
	}
}
