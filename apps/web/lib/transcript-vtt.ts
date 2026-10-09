export function normalizeTranscriptCueText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function normalizeWebVttVoiceText(text: string): {
	speaker: string | null;
	text: string;
} {
	const rawText = normalizeTranscriptCueText(text);
	const voiceTagPattern =
		/<v\s+([^>]+)>([\s\S]*?)(?:<\/v>|(?=<v\s+[^>]+>)|$)/gi;
	const parts: Array<{ speaker: string | null; text: string }> = [];
	let lastIndex = 0;

	while (true) {
		const match = voiceTagPattern.exec(rawText);
		if (match === null) break;

		const plainBefore = stripWebVttTags(rawText.slice(lastIndex, match.index));
		if (plainBefore) {
			parts.push({ speaker: null, text: plainBefore });
		}

		const speaker = normalizeTranscriptCueText(match[1] ?? "");
		const spokenText = stripWebVttTags(match[2] ?? "");
		if (speaker && spokenText) {
			parts.push({ speaker, text: spokenText });
		}

		lastIndex = voiceTagPattern.lastIndex;
	}

	const plainAfter = stripWebVttTags(rawText.slice(lastIndex));
	if (plainAfter) {
		parts.push({ speaker: null, text: plainAfter });
	}

	if (parts.length === 0) {
		const stripped = stripWebVttTags(rawText);
		const colonMatch = stripped.match(/^([^:]{1,30}):\s+(.+)$/);
		if (colonMatch) {
			return {
				speaker: colonMatch[1]?.trim() ?? null,
				text: colonMatch[2]?.trim() ?? stripped,
			};
		}
		return { speaker: null, text: stripped };
	}

	const hasPlainText = parts.some((part) => part.speaker === null);
	const speakerNames = [
		...new Set(parts.map((part) => part.speaker).filter(Boolean)),
	];

	if (!hasPlainText && speakerNames.length === 1) {
		return {
			speaker: speakerNames[0] ?? null,
			text: normalizeTranscriptCueText(
				parts.map((part) => part.text).join(" "),
			),
		};
	}

	return {
		speaker: null,
		text: normalizeTranscriptCueText(
			parts
				.map((part) =>
					part.speaker ? `${part.speaker}: ${part.text}` : part.text,
				)
				.join(" "),
		),
	};
}

// Known WebVTT cue-span tag names. We ONLY strip angle-bracket runs whose tag
// name is one of these, so a legit text comparison like "5 < 10" is never
// touched. Covers opening (`<v Name>`, `<c.class>`), closing (`</v>`, `</c>`),
// orphan closings (a `</v>` whose opener was lost across a cue/chunk boundary —
// the Gemini bug that leaks `</v>` into rendered text), and attributed/spaced
// variants (`</v >`, `</c.yellow>`, `<lang uz>`, `</lang>`, `</ruby>`).
const WEBVTT_TAG_PATTERN =
	/<\/?(?:v|c|i|b|u|lang|ruby|rt)(?:\.[\w-]+)*(?:\s[^>]*)?>/gi;

function stripWebVttTags(text: string): string {
	return normalizeTranscriptCueText(text.replace(WEBVTT_TAG_PATTERN, ""));
}

/**
 * Final render-boundary sanitizer: strip any residual WebVTT cue-span tags
 * (including orphan closings like a lone `</v>`) from a fully-resolved,
 * display-ready caption string. `normalizeWebVttVoiceText` already removes
 * well-formed tags while extracting speakers, but a caption can reach a render
 * path (search highlight, copy/download) still carrying an orphan tag; applying
 * this as the last step guarantees the DOM never shows `</v>`. Legit `<`
 * comparisons in text are preserved (the pattern only matches known tag names).
 */
export function stripRenderedVttTags(text: string): string {
	return text.replace(WEBVTT_TAG_PATTERN, "");
}

export function updateVttEntryText(
	vttContent: string,
	entryId: number,
	newText: string,
): { content: string; updated: boolean } {
	const normalizedText = normalizeTranscriptCueText(newText);
	const lines = vttContent.split(/\r?\n/);
	const updatedLines: string[] = [];
	let index = 0;
	let updated = false;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const trimmedLine = line.trim();

		if (!/^\d+$/.test(trimmedLine)) {
			updatedLines.push(line);
			index++;
			continue;
		}

		const cueId = parseInt(trimmedLine, 10);
		const cueStart = index;
		let cueEnd = cueStart + 1;

		while (cueEnd < lines.length && (lines[cueEnd] ?? "").trim() !== "") {
			cueEnd++;
		}

		if (cueId !== entryId) {
			updatedLines.push(...lines.slice(cueStart, cueEnd));
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		const cueLines = lines.slice(cueStart, cueEnd);
		const timingIndex = cueLines.findIndex((cueLine) =>
			cueLine.includes("-->"),
		);

		if (timingIndex === -1) {
			updatedLines.push(...cueLines);
			if (cueEnd < lines.length) {
				updatedLines.push(lines[cueEnd] ?? "");
			}
			index = cueEnd + 1;
			continue;
		}

		updatedLines.push(...cueLines.slice(0, timingIndex + 1), normalizedText);
		if (cueEnd < lines.length) {
			updatedLines.push(lines[cueEnd] ?? "");
		}
		updated = true;
		index = cueEnd + 1;
	}

	return {
		content: updatedLines.join("\n"),
		updated,
	};
}
