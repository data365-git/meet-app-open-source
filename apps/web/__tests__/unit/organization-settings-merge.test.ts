import { describe, expect, it } from "vitest";
import {
	mergeOrganizationSettings,
	preserveProSettings,
} from "@/lib/organization-settings";

describe("mergeOrganizationSettings", () => {
	it("a single-key update preserves existing aiBudget, disable-flags, and defaultPlaybackSpeed", () => {
		const existing = {
			aiBudget: { monthlyUsdCents: 500, alertAtPct: 80, enabled: true },
			disableComments: true,
			disableCaptions: true,
			disableReactions: false,
			defaultPlaybackSpeed: 1.5,
			aiSpeedMode: "fast",
		} as unknown as Record<string, unknown>;

		const merged = mergeOrganizationSettings(existing, { aiSpeedMode: "cheap" });

		expect(merged).toEqual({
			...existing,
			aiSpeedMode: "cheap",
		});
	});

	it("explicit false/new values in the update still overwrite the existing value", () => {
		const existing = {
			disableComments: false,
			disableCaptions: false,
			defaultPlaybackSpeed: 1,
		};

		const merged = mergeOrganizationSettings(existing, {
			disableComments: true,
			defaultPlaybackSpeed: 2,
		});

		expect(merged).toEqual({
			disableComments: true,
			disableCaptions: false,
			defaultPlaybackSpeed: 2,
		});
	});

	it("merging onto null/undefined existing settings just returns the update", () => {
		expect(mergeOrganizationSettings(null, { aiSpeedMode: "cheap" })).toEqual({
			aiSpeedMode: "cheap",
		});
		expect(mergeOrganizationSettings(undefined, { aiSpeedMode: "cheap" })).toEqual({
			aiSpeedMode: "cheap",
		});
	});

	it("does not mutate the existing settings object", () => {
		const existing = { disableComments: true };
		const existingCopy = { ...existing };

		mergeOrganizationSettings(existing, { disableComments: false });

		expect(existing).toEqual(existingCopy);
	});

	it("a non-pro caller still cannot smuggle pro-only keys past preserveProSettings, and the merge preserves that", () => {
		const existingSettings = {
			disableSummary: true,
			disableChapters: true,
			disableTranscript: false,
			hideShareableLinkCapLogo: true,
			shareableLinkUseOrganizationIcon: false,
			aiGenerationLanguage: "en",
			aiSpeedMode: "fast",
			disableComments: false,
		} as const;

		// Non-pro caller attempts to flip a pro-gated key plus a non-gated key.
		const submitted = {
			disableSummary: false,
			aiSpeedMode: "cheap",
		} as const;

		const gated = preserveProSettings(submitted, existingSettings);
		const merged = mergeOrganizationSettings(existingSettings, gated);

		// Pro-gated key was NOT changed by the non-pro submission.
		expect(merged.disableSummary).toBe(true);
		expect(merged.disableChapters).toBe(true);
		expect(merged.aiGenerationLanguage).toBe("en");
		// Non-gated key from the submission still applied.
		expect(merged.aiSpeedMode).toBe("cheap");
		// Untouched key survived the merge.
		expect(merged.disableComments).toBe(false);
	});
});
