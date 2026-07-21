import { z } from "zod";

// Pure validation helpers for the developer-SDK upload /complete route,
// split out of upload.ts (which pulls in @cap/database / @cap/web-backend and
// isn't safe to import directly in unit tests) so they can be exercised in
// isolation. Mirrors the split already used for the web/extension /complete
// path: apps/web/app/api/upload/[...route]/multipart-utils.ts.

export const developerCompletePartSchema = z.object({
	partNumber: z.number().int().min(1).max(10000),
	etag: z.string().min(1),
	size: z.number().nonnegative(),
});

export const developerCompletePartsSchema = z
	.array(developerCompletePartSchema)
	// A completed multipart upload MUST have >=1 part; an empty array is
	// forwarded to S3 as a malformed completion and yields a broken 0-byte
	// object. Reject it cleanly instead (matches the web/extension /complete
	// convention in multipart.ts, C8).
	.min(1, "A completed upload must include at least one part");
