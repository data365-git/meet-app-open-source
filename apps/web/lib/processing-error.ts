/**
 * Allowlist for `videoUploads.processingError` (round-18).
 *
 * That field reaches the share page's ProgressCircle for ANYONE with the
 * link, and the errors on this path are upload / ffmpeg / S3 failures — an
 * AWS SDK error can echo the request's PRESIGNED URL, signature and all,
 * into its message. A presigned URL is a working access credential, not
 * mere upstream detail, so nothing raw may ever be persisted here.
 *
 * The safe set is small and knowable — the viewer needs WHICH stage failed
 * and whether to retry, never the upstream text — so this is an ALLOWLIST
 * (the same shape workflows/transcribe.ts already uses for
 * timestampRefinement), not a sanitizer: the persisted value is exactly the
 * MATCHED TOKEN of a known failure family, or the literal "failed". Even
 * when a known token appears inside a message that also carries a URL, only
 * the token survives.
 *
 * The token list is a superset of what
 * lib/desktop-segments-retryable-errors.ts matches on, so retry
 * classification of the PERSISTED value keeps working — pinned by test.
 * Full raw detail belongs in the server log at the persist site.
 */
const KNOWN_PROCESSING_FAILURE_TOKENS: readonly RegExp[] = [
	/Mux failed: \d{3}/,
	/Application failed to respond/i,
	/SERVER_BUSY/,
	/Server is at capacity/i,
	/Failed to start segment muxing/i,
	/fetch failed/i,
	/Segment manifest not found/i,
	/Segment manifest is not marked as complete/i,
	/timed out/i,
	/timeout/i,
	// Known causes on the upload-abort paths (round-19 #2) — static literals
	// passed by our own writers, never derived from upstream text.
	/Upload interrupted/,
	/Upload stalled/,
	/Processing stalled/,
];

export function persistableProcessingError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	for (const pattern of KNOWN_PROCESSING_FAILURE_TOKENS) {
		const match = raw.match(pattern);
		if (match) return match[0];
	}
	// EMPTY, not "failed" (round-19 #1): the share page reads
	// `errorMessage || t("progressProcessingFailedOwner")`, so a truthy bare
	// word suppressed the localized sentence that tells the viewer what to
	// do. Falsy keeps the identical security property and restores the copy.
	return "";
}
