import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Round-18: `videoUploads.processingError` reaches the share page
// (ProgressCircle) for anyone with the link, and upload/ffmpeg/S3 failures
// can embed a PRESIGNED URL — a working access credential — in the message.
// The persisted value is therefore an ALLOWLIST token (the same shape the
// timestampRefinement writer already uses): the known failure family, or
// "failed". Never the raw message, never a URL fragment.
import { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";
import { persistableProcessingError } from "@/lib/processing-error";

// A realistic AWS SDK failure: the SDK echoes the request URL — presigned,
// signature included — into the error message.
const S3_PRESIGNED_ERROR = new Error(
	'AccessDenied: Access Denied. Request failed for PUT "https://capso-prod.3c47d1e2.r2.cloudflarestorage.com/owner-1/vid-123/result.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=b1946ac92492d2347c6235b4d2611184%2F20260813%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260813T120000Z&X-Amz-Expires=3600&X-Amz-Signature=8bd7f0a2c9e64d3f5a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071&X-Amz-SignedHeaders=host" (HTTP 403)',
);

describe("persistableProcessingError — allowlist, never the raw message", () => {
	it("an S3 error carrying a presigned URL persists as a bare token: no http, no signature, no query string", () => {
		const out = persistableProcessingError(S3_PRESIGNED_ERROR);
		expect(out).toBe("failed");
		expect(out).not.toContain("http");
		expect(out).not.toContain("X-Amz-Signature");
		expect(out).not.toContain("?");
	});

	it("a KNOWN failure family inside a message that ALSO carries a presigned URL persists as the token only", () => {
		const out = persistableProcessingError(
			new Error(
				'Mux failed: 503 while uploading to "https://capso-prod.r2.cloudflarestorage.com/o/v/result.mp4?X-Amz-Signature=deadbeef&X-Amz-Expires=3600"',
			),
		);
		expect(out).toBe("Mux failed: 503");
		expect(out).not.toContain("http");
		expect(out).not.toContain("X-Amz-Signature");
		expect(out).not.toContain("?");
	});

	it("the operator can still tell WHICH failure family it was, and retryability is preserved end to end", () => {
		const retryables = [
			"Mux failed: 503 (upstream)",
			"fetch failed: connect ETIMEDOUT 10.0.0.4:443",
			"Segment manifest not found for vid-123",
			"Request timed out after 30000ms",
		];
		for (const raw of retryables) {
			const persisted = persistableProcessingError(new Error(raw));
			expect(persisted).not.toBe("failed");
			expect(isRetryableDesktopSegmentsFinalizationError(persisted)).toBe(true);
		}
		// A known family that is NOT retryable stays classifiable as such.
		const notRetryable = persistableProcessingError(
			new Error("Mux failed: 404 — segment missing"),
		);
		expect(notRetryable).toBe("Mux failed: 404");
		expect(isRetryableDesktopSegmentsFinalizationError(notRetryable)).toBe(
			false,
		);
	});
});

describe("every processingError persist site routes through the allowlist (the CLASS, not one table)", () => {
	const read = (rel: string) =>
		readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

	it("all five writers use persistableProcessingError; none persists a raw message", () => {
		const writers = [
			"../../lib/video-processing.ts",
			"../../workflows/process-video.ts",
			"../../workflows/import-loom-video.ts",
			"../../workflows/finalize-desktop-recording.ts",
			"../../workflows/admin-reprocess-video.ts",
		];
		for (const rel of writers) {
			const src = read(rel);
			expect(src, rel).toMatch(/processingError: persistableProcessingError\(/);
			expect(src, rel).not.toMatch(/processingError: errorMessage/);
			expect(src, rel).not.toMatch(
				/processingError: error instanceof Error/,
			);
		}
	});
});
