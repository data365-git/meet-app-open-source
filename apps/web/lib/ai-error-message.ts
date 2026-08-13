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
	// The stable prefix every Gemini HTTP failure carries ("... failed
	// (HTTP 400)") identifies the failure class without the body.
	const prefix = message.match(/^[^:{\n]*\(HTTP \d+\)/);
	if (prefix) return prefix[0];
	// No HTTP prefix (e.g. "empty transcript from Gemini"): first line,
	// bounded.
	const firstLine = message.split("\n", 1)[0] ?? "";
	return firstLine.slice(0, 200);
}
