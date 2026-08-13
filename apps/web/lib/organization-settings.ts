import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
} from "@cap/web-domain";

// Plain (non-"use server") home for the org-settings shape + pure helpers.
// These CANNOT live in actions/organization/settings.ts: that file has a
// module-level "use server", and Next.js requires every export of such a file
// to be an async Server Action — exporting a sync helper there passes
// typecheck/vitest but fails `next build`.

export type OrganizationSettingsInput = {
	disableSummary?: boolean;
	disableCaptions?: boolean;
	disableChapters?: boolean;
	disableReactions?: boolean;
	disableTranscript?: boolean;
	disableComments?: boolean;
	hideShareableLinkCapLogo?: boolean;
	shareableLinkUseOrganizationIcon?: boolean;
	aiGenerationLanguage?: AiGenerationLanguage;
	defaultPlaybackSpeed?: number;
};

const proOrganizationSettingKeys = [
	"disableSummary",
	"disableChapters",
	"disableTranscript",
	"hideShareableLinkCapLogo",
	"shareableLinkUseOrganizationIcon",
	"aiGenerationLanguage",
] as const satisfies readonly (keyof OrganizationSettingsInput)[];

const defaultProOrganizationSettings = {
	disableSummary: false,
	disableChapters: false,
	disableTranscript: false,
	hideShareableLinkCapLogo: false,
	shareableLinkUseOrganizationIcon: false,
	aiGenerationLanguage: AI_GENERATION_LANGUAGE_AUTO,
} as const satisfies Pick<
	Required<OrganizationSettingsInput>,
	(typeof proOrganizationSettingKeys)[number]
>;

export const preserveProSettings = (
	submittedSettings: OrganizationSettingsInput,
	existingSettings: OrganizationSettingsInput | null | undefined,
) => ({
	...submittedSettings,
	...Object.fromEntries(
		proOrganizationSettingKeys.map((key) => [
			key,
			existingSettings?.[key] ?? defaultProOrganizationSettings[key],
		]),
	),
});

/**
 * Merges a partial settings update onto the organization's existing settings
 * JSON column, so callers that submit only a subset of keys don't erase the
 * rest. `nextSettings` must contain only keys the caller explicitly set — no
 * `key: undefined` entries — so this is a plain last-write-wins shallow merge.
 */
export const mergeOrganizationSettings = (
	existingSettings: OrganizationSettingsInput | null | undefined,
	nextSettings: OrganizationSettingsInput,
): OrganizationSettingsInput => ({
	...(existingSettings ?? {}),
	...nextSettings,
});
