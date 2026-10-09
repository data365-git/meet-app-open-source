/**
 * UI/database-safe rendering of an AI-path error (round-16 #2).
 *
 * Thrown messages now carry the upstream response BODY on purpose — the
 * broken-key classifier needs the API_KEY_INVALID evidence — but whatever
 * markError persists into `videos.metadata.transcriptionError.message` is
 * spread into the share page's RSC payload and shown to every viewer of the
 * link, public included. Google bodies carry upstream detail (project
 * numbers, service names, internal reasons) that strangers have no business
 * seeing. So: the FULL message goes to the server log at the persist site;
 * the database gets this short, stable reason.
 */
export function sanitizeAiErrorMessageForUi(message: string): string {
	// The stable "... failed (HTTP nnn)" marker identifies the failure class
	// without the body. Lazy from the START so WRAPPED messages keep their
	// wrapper context ("Transcription quota/credits exhausted for v1: ...")
	// and still stop before the body — the old anchored arm could not cross
	// the wrapper's colon and fell through to a fallback that leaked ~95
	// chars of Google's JSON into a public share page (round-17 #1).
	const prefix = message.match(/^[\s\S]*?\(HTTP \d+\)/);
	if (prefix) return prefix[0].slice(0, 200);
	// No HTTP marker (e.g. "empty transcript from Gemini"): first line, cut
	// before any body brace, bounded.
	const firstLine = message.split("\n", 1)[0] ?? "";
	const brace = firstLine.indexOf("{");
	return (brace === -1 ? firstLine : firstLine.slice(0, brace))
		.trimEnd()
		.replace(/:$/, "")
		.slice(0, 200);
}
