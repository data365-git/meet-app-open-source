"use client";

import type { ShareLanguage } from "@cap/database/types";

export const LANGUAGE_LABELS: Record<ShareLanguage, string> = {
	uz: "O'zbekcha",
	ru: "Русский",
	en: "English",
};

export const ALL_LANGUAGES: ShareLanguage[] = ["uz", "ru", "en"];

/**
 * Best-effort detection of the BASE content language from a sample of its text
 * (e.g. the summary overview). Lets the picker label the original by its real
 * language ("O'zbekcha") instead of a vague "Original", and avoids offering to
 * "generate" the language the video is already in. Cyrillic → ru; Uzbek-Latin
 * markers (oʻ/gʻ + common function words) → uz; otherwise → en. Defaults to uz
 * (the app's primary market) when there is no text to judge.
 */
export function detectShareLanguage(text: string | undefined | null): ShareLanguage {
	if (!text) return "uz";
	if (/[А-Яа-яЁё]/.test(text)) return "ru";
	const t = text.toLowerCase();
	const uzMarkers =
		/(o['ʻ]|g['ʻ])/.test(t) ||
		/\b(va|bu|uchun|bilan|ekan|qanday|hamda|emas|kerak|yoki|lekin|hodisa|ushbu|orqali|hisoblanadi|mumkin)\b/.test(
			t,
		);
	if (uzMarkers) return "uz";
	return "en";
}

export interface TranscriptLanguageOptions {
	baseLanguage?: ShareLanguage;
	available: ShareLanguage[];
	selected: "base" | ShareLanguage;
	onSelect: (value: "base" | ShareLanguage) => void;
	canGenerate: boolean;
	generatingLanguage: ShareLanguage | null;
	onGenerate: (language: ShareLanguage) => void;
}
