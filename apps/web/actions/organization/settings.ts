"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { isAiGenerationLanguage } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isAiSpeedMode } from "@/lib/ai-speed-mode";
import {
	mergeOrganizationSettings,
	type OrganizationSettingsInput,
	preserveProSettings,
} from "@/lib/organization-settings";
import { normalizePlaybackSpeed } from "@/lib/playback-speed";
import { requireOrganizationSettingsManager } from "./authorization";

export async function updateOrganizationSettings(
	settings: OrganizationSettingsInput,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	if (!settings) {
		throw new Error("Settings are required");
	}

	if (
		settings.aiGenerationLanguage !== undefined &&
		!isAiGenerationLanguage(settings.aiGenerationLanguage)
	) {
		throw new Error("Unsupported AI generation language");
	}

	if (
		settings.aiSpeedMode !== undefined &&
		!isAiSpeedMode(settings.aiSpeedMode)
	) {
		throw new Error("Unsupported AI speed mode");
	}

	if (!user.activeOrganizationId) {
		throw new Error("Organization not found");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, user.activeOrganizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	await requireOrganizationSettingsManager(user.id, user.activeOrganizationId);

	const sanitizedSettings =
		settings.defaultPlaybackSpeed !== undefined
			? {
					...settings,
					defaultPlaybackSpeed: normalizePlaybackSpeed(
						settings.defaultPlaybackSpeed,
					),
				}
			: settings;

	const nextSettings = userIsPro(user)
		? sanitizedSettings
		: preserveProSettings(sanitizedSettings, organization.settings);

	const mergedSettings = mergeOrganizationSettings(
		organization.settings,
		nextSettings,
	);

	await db()
		.update(organizations)
		.set({ settings: mergedSettings })
		.where(eq(organizations.id, user.activeOrganizationId));

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");

	return { success: true };
}
