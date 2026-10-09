import { describe, expect, it } from "vitest";
import { isSequentialPartList } from "@/app/api/upload/[...route]/multipart-utils";
import {
	developerCompletePartsSchema,
	developerCompletePartSchema,
} from "@/app/api/developer/sdk/v1/[...route]/upload-validation";

// Developer-SDK /complete endpoint guard: the schema-level checks below plus
// isSequentialPartList (the same runtime guard the web and extension
// /complete paths use, apps/web/app/api/upload/[...route]/multipart.ts) are
// applied together in that order before a submitted part list is ever sent to
// S3's CompleteMultipartUpload.
//
// Established convention in this codebase (confirmed via
// multipart-upload-utils.test.ts): S3/R2 tolerate sparse part numbers in
// general, but this app's /complete paths do NOT — they require an exact,
// gapless 1..N sequence (isSequentialPartList rejects both gaps and
// duplicates). The SDK path matches that convention rather than inventing a
// looser one.
function validPart(overrides: Partial<{ partNumber: number; etag: string; size: number }> = {}) {
	return { partNumber: 1, etag: "etag-1", size: 100, ...overrides };
}

describe("developer SDK /complete part validation", () => {
	describe("schema-level checks (unambiguously invalid input)", () => {
		it("accepts a well-formed part", () => {
			expect(developerCompletePartSchema.safeParse(validPart()).success).toBe(
				true,
			);
		});

		it("rejects an empty parts array", () => {
			const result = developerCompletePartsSchema.safeParse([]);
			expect(result.success).toBe(false);
		});

		it("rejects a non-positive part number", () => {
			expect(
				developerCompletePartSchema.safeParse(validPart({ partNumber: 0 }))
					.success,
			).toBe(false);
			expect(
				developerCompletePartSchema.safeParse(validPart({ partNumber: -1 }))
					.success,
			).toBe(false);
		});

		it("rejects a part number above the S3 10000 ceiling", () => {
			expect(
				developerCompletePartSchema.safeParse(validPart({ partNumber: 10001 }))
					.success,
			).toBe(false);
		});

		it("rejects a malformed (empty) etag", () => {
			expect(
				developerCompletePartSchema.safeParse(validPart({ etag: "" })).success,
			).toBe(false);
		});

		it("rejects a negative size", () => {
			expect(
				developerCompletePartSchema.safeParse(validPart({ size: -1 })).success,
			).toBe(false);
		});
	});

	describe("isSequentialPartList guard (matches web/extension /complete convention)", () => {
		it("accepts a contiguous 1..N list", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 1 },
					{ partNumber: 2 },
					{ partNumber: 3 },
				]),
			).toBe(true);
		});

		it("accepts a contiguous list submitted out of order", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 3 },
					{ partNumber: 1 },
					{ partNumber: 2 },
				]),
			).toBe(true);
		});

		it("rejects duplicate part numbers", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 1 },
					{ partNumber: 2 },
					{ partNumber: 2 },
				]),
			).toBe(false);
		});

		it("rejects a sparse/non-contiguous part list (gap)", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 1 },
					{ partNumber: 3 },
					{ partNumber: 4 },
				]),
			).toBe(false);
		});

		it("rejects a part list that doesn't start at 1", () => {
			expect(
				isSequentialPartList([{ partNumber: 2 }, { partNumber: 3 }]),
			).toBe(false);
		});
	});

	describe("full guard composition (schema + isSequentialPartList), as applied by the route", () => {
		function passesFullGuard(
			parts: { partNumber: number; etag: string; size: number }[],
		) {
			const schemaResult = developerCompletePartsSchema.safeParse(parts);
			if (!schemaResult.success) return false;
			return isSequentialPartList(schemaResult.data);
		}

		it("accepts a valid contiguous list", () => {
			expect(
				passesFullGuard([validPart({ partNumber: 1 }), validPart({ partNumber: 2 })]),
			).toBe(true);
		});

		it("rejects an empty list", () => {
			expect(passesFullGuard([])).toBe(false);
		});

		it("rejects duplicate part numbers", () => {
			expect(
				passesFullGuard([
					validPart({ partNumber: 1 }),
					validPart({ partNumber: 1, etag: "etag-1b" }),
				]),
			).toBe(false);
		});

		it("rejects a sparse/gapped list", () => {
			expect(
				passesFullGuard([validPart({ partNumber: 1 }), validPart({ partNumber: 3 })]),
			).toBe(false);
		});

		it("rejects a malformed etag even inside an otherwise contiguous list", () => {
			expect(
				passesFullGuard([
					validPart({ partNumber: 1 }),
					validPart({ partNumber: 2, etag: "" }),
				]),
			).toBe(false);
		});
	});
});
