"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	accounts,
	aiUsageEvents,
	authApiKeys,
	comments,
	folders,
	notifications,
	organizationInvites,
	organizationMembers,
	organizations,
	sessions,
	spaceMembers,
	spaces,
	users,
	verificationTokens,
	videos,
} from "@cap/database/schema";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

// Verified SERVER-side before anything is deleted. Compared as the exact
// English literal in every locale — the dialog renders it verbatim.
const CONFIRMATION_PHRASE = "delete my all data";

export async function deleteAccount(
	confirmationPhrase: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Not authenticated" };

	if (confirmationPhrase !== CONFIRMATION_PHRASE) {
		return {
			ok: false,
			error: `Type "${CONFIRMATION_PHRASE}" exactly to confirm deletion.`,
		};
	}

	// Owned orgs do NOT blanket-block erasure: the legacy invite path gave many
	// users a personal single-member org they never asked for, so refusing all
	// owners would dead-end the erasure feature for most real accounts. A
	// SOLE-member org dies with the account — no other tenant can be affected,
	// by definition. Only an org with OTHER members blocks (their shared data
	// must not vanish under them).
	const ownedOrgs = await db()
		.select({ id: organizations.id, name: organizations.name })
		.from(organizations)
		.where(eq(organizations.ownerId, user.id));

	const soleMemberOrgIds: (typeof ownedOrgs)[number]["id"][] = [];
	for (const org of ownedOrgs) {
		const members = await db()
			.select({ userId: organizationMembers.userId })
			.from(organizationMembers)
			.where(eq(organizationMembers.organizationId, org.id));
		const others = members.filter((m) => m.userId !== user.id);
		if (others.length > 0) {
			return {
				ok: false,
				error: `Your organization "${org.name}" still has other members. Remove them or transfer ownership before deleting your account.`,
			};
		}
		soleMemberOrgIds.push(org.id);
	}

	// Real erasure, storage FIRST, account row LAST. Every owned video —
	// with no deletedAt filter, so Trash is purged too — goes through the one
	// proven Videos.permanentlyDelete path (objects before rows, idempotent,
	// owner-scoped). If any purge fails the account is left intact so the
	// user can simply retry; already-erased videos then succeed quietly.
	const ownedVideos = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(eq(videos.ownerId, user.id));

	try {
		await runPromise(
			Effect.gen(function* () {
				const videosService = yield* Videos;
				for (const { id } of ownedVideos)
					yield* videosService.permanentlyDelete(id);
			}).pipe(Effect.provide(makeCurrentUserLayer(user))),
		);
	} catch (error) {
		console.error("Account erasure: video purge failed, account kept", error);
		return {
			ok: false,
			error:
				"Some of your videos could not be erased. Nothing else was deleted — please try again.",
		};
	}

	// Rows keyed to the user. Video-keyed rows (shared/space videos,
	// transcript chunks, storage objects, ...) already cascaded with the
	// videos above. Shared org structures (spaces/folders the user created
	// in orgs they do not own) are deliberately NOT touched — only the
	// user's own membership rows go. aiUsageEvents must go before the users
	// row: its FK has no ON DELETE and would reject the user delete.
	await db().transaction(async (tx) => {
		await tx.delete(comments).where(eq(comments.authorId, user.id));
		await tx
			.delete(notifications)
			.where(eq(notifications.recipientId, user.id));
		await tx.delete(authApiKeys).where(eq(authApiKeys.userId, user.id));
		await tx.delete(aiUsageEvents).where(eq(aiUsageEvents.userId, user.id));
		await tx.delete(spaceMembers).where(eq(spaceMembers.userId, user.id));
		await tx
			.delete(verificationTokens)
			.where(eq(verificationTokens.identifier, user.email));
		await tx
			.delete(organizationMembers)
			.where(eq(organizationMembers.userId, user.id));
		// Sole-member orgs die with the account. Scoped children first (no FK
		// cascade exists for organizationId columns), then the org row. Known,
		// accepted orphans — same policy as Videos.permanentlyDelete: rows in
		// storageIntegrations/s3Buckets (org-level custom storage creds) are an
		// open owner decision and are NOT deleted here.
		for (const orgId of soleMemberOrgIds) {
			await tx
				.delete(organizationInvites)
				.where(eq(organizationInvites.organizationId, orgId));
			await tx.delete(folders).where(eq(folders.organizationId, orgId));
			await tx.delete(spaces).where(eq(spaces.organizationId, orgId));
			await tx.delete(organizations).where(eq(organizations.id, orgId));
		}
		await tx.delete(sessions).where(eq(sessions.userId, user.id));
		await tx.delete(accounts).where(eq(accounts.userId, user.id));
		await tx.delete(users).where(eq(users.id, user.id));
	});

	return { ok: true };
}
