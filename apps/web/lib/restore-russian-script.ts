/**
 * Deterministic post-guard for the "romanized Russian" transcription bug.
 *
 * The transcription prompt orders Gemini to keep Russian words in Cyrillic
 * (любой, сразу…), but the model still occasionally romanizes them ("lyuboy",
 * "srazu"). A prompt is a request; this guard is a guarantee for the words
 * that actually recur in real meetings.
 *
 * Scope is deliberately CONSERVATIVE: only words that are unambiguously
 * spoken Russian and are NOT accepted Uzbek-Latin vocabulary. Never add
 * legitimate Uzbek loanwords here (byudjet, klient, proyekt, dogovor…) —
 * those are correct Uzbek spellings, not romanization mistakes.
 *
 * Applied at the transcript SOURCE (before storage) so every consumer
 * (panels, captions, summaries, translations) sees the corrected text.
 */

// romanized (lowercase) → Cyrillic (lowercase). Variants map to one target.
const ROMANIZED_RUSSIAN: Record<string, string> = {
	lyuboy: "любой",
	lyubaya: "любая",
	lyuboe: "любое",
	lyubie: "любые",
	lyubye: "любые",
	srazu: "сразу",
	seychas: "сейчас",
	sichas: "сейчас",
	konechno: "конечно",
	kanechno: "конечно",
	voobshe: "вообще",
	vapshe: "вообще",
	vaabshe: "вообще",
	vobshem: "в общем",
	prosto: "просто",
	tochno: "точно",
	dazhe: "даже",
	znachit: "значит",
	koroche: "короче",
	kstati: "кстати",
	ladno: "ладно",
	davay: "давай",
	davayte: "давайте",
	uzhe: "уже",
	poka: "пока",
	naprimer: "например",
	obyazatelno: "обязательно",
	abyazatelno: "обязательно",
	poluchaetsya: "получается",
	paluchaetsya: "получается",
	deystvitelno: "действительно",
	naverno: "наверно",
	navernoe: "наверное",
	vsyo: "всё",
	nichego: "ничего",
	nichevo: "ничего",
	pochemu: "почему",
	potomu: "потому",
	chto: "что",
	shto: "что",
};

const PATTERN = new RegExp(
	`\\b(${Object.keys(ROMANIZED_RUSSIAN).join("|")})\\b`,
	"gi",
);

/** Match the source word's capitalization on the Cyrillic replacement. */
function matchCase(source: string, target: string): string {
	if (source === source.toUpperCase() && source.length > 1) {
		return target.toUpperCase();
	}
	if (source[0] === source[0]?.toUpperCase()) {
		return (target[0]?.toUpperCase() ?? "") + target.slice(1);
	}
	return target;
}

/**
 * Replace romanized Russian words with their Cyrillic originals throughout a
 * transcript (VTT or plain text). Word-boundary + case-preserving; leaves all
 * timestamps, markup (`**bold**`, voice tags) and everything else untouched.
 */
export function restoreRussianScript(text: string): string {
	if (!text) return text;
	return text.replace(PATTERN, (match) => {
		const target = ROMANIZED_RUSSIAN[match.toLowerCase()];
		return target ? matchCase(match, target) : match;
	});
}
