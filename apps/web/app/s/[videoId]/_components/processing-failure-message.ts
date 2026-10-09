/**
 * Single translation point between the STORED processing-error token and
 * what a share-page viewer reads (round-20 #1).
 *
 * `videoUploads.processingError` holds allowlist TOKENS ("Upload
 * interrupted", "Upload stalled", "Processing stalled" — see
 * lib/processing-error.ts) because ops and retry classification need stable
 * strings. But a viewer must never see a token raw: rendering
 * `errorMessage || t(...)` showed bare untranslated English for the most
 * common failure class. Known tokens map to their own localized keys;
 * anything else — empty, legacy raw text, ops-only tokens like
 * "Mux failed: 503" — falls back to the localized actionable sentence.
 */
const TOKEN_MESSAGE_KEYS: Record<string, string> = {
	"Upload interrupted": "progressUploadInterrupted",
	"Upload stalled": "progressUploadStalledError",
	"Processing stalled": "progressProcessingStalled",
	// Stall-detection KEYS from getStalledProcessingMessage (round-21): the
	// same field carries them, and they are already share-namespace keys —
	// they pass through to t() unchanged. One field, one kind of value.
	progressDidNotStart: "progressDidNotStart",
	progressStalled: "progressStalled",
	progressFinishingStalled: "progressFinishingStalled",
};

export function processingFailureMessageKey(
	errorMessage: string | null,
	canRetryProcessing: boolean,
): string {
	const known = errorMessage ? TOKEN_MESSAGE_KEYS[errorMessage] : undefined;
	if (known) return known;
	return canRetryProcessing
		? "progressProcessingFailed"
		: "progressProcessingFailedOwner";
}
