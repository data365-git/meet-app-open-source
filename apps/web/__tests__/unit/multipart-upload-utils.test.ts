import { describe, expect, it } from "vitest";
import {
	getMultipartFileKey,
	getSubpath,
	isRawRecorderUpload,
	isSequentialPartList,
} from "@/app/api/upload/[...route]/multipart-utils";

describe("multipart upload utils", () => {
	it("builds a multipart file key from video id and subpath", () => {
		expect(
			getMultipartFileKey("user-123", {
				videoId: "video-456",
				subpath: "raw-upload.webm",
			}),
		).toBe("user-123/video-456/raw-upload.webm");
	});

	it("defaults the multipart subpath to result.mp4", () => {
		const input: { subpath?: string } = {};

		expect(
			getMultipartFileKey("user-123", {
				videoId: "video-456",
			}),
		).toBe("user-123/video-456/result.mp4");
		expect(getSubpath(input)).toBe("result.mp4");
	});

	it("parses deprecated fileKey input into the current user-scoped key", () => {
		expect(
			getMultipartFileKey("user-123", {
				fileKey: "legacy-owner/video-456/raw-upload.webm",
			}),
		).toBe("user-123/video-456/raw-upload.webm");
		expect(
			getSubpath({
				fileKey: "legacy-owner/video-456/raw-upload.webm",
			}),
		).toBeUndefined();
	});

	it("detects raw recorder uploads", () => {
		expect(isRawRecorderUpload("raw-upload.webm")).toBe(true);
		expect(isRawRecorderUpload("raw-upload.mp4")).toBe(true);
		expect(isRawRecorderUpload("result.mp4")).toBe(false);
	});

	it("rejects missing video ids", () => {
		expect(() =>
			getMultipartFileKey("user-123", {
				subpath: "raw-upload.webm",
			}),
		).toThrow("Video id not found");
	});

	// P3.3 — server-side backstop against a gapped part list (e.g. produced by
	// a mis-built client retry path). /complete must reject before it ever
	// reaches completeMultipart, which would otherwise fail or assemble a
	// corrupt object.
	describe("isSequentialPartList", () => {
		it("accepts a sequential, in-order part list", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 1 },
					{ partNumber: 2 },
					{ partNumber: 3 },
				]),
			).toBe(true);
		});

		it("accepts a sequential part list submitted out of order", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 2 },
					{ partNumber: 3 },
					{ partNumber: 1 },
				]),
			).toBe(true);
		});

		it("rejects a gapped part list (part 2 missing)", () => {
			expect(
				isSequentialPartList([
					{ partNumber: 1 },
					{ partNumber: 3 },
					{ partNumber: 4 },
				]),
			).toBe(false);
		});

		it("rejects a part list that doesn't start at 1", () => {
			expect(isSequentialPartList([{ partNumber: 2 }, { partNumber: 3 }])).toBe(
				false,
			);
		});
	});
});
