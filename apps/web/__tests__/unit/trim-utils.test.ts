import { describe, expect, it } from "vitest";
import {
	isFullSelection,
	isMp4Source,
	shouldUploadOriginal,
} from "@/components/PreUploadTrimmer/trim-utils";

describe("isFullSelection", () => {
	it("true when the range spans the whole video (within tolerance)", () => {
		expect(isFullSelection(0, 120, 120)).toBe(true);
		expect(isFullSelection(0.03, 119.97, 120)).toBe(true);
	});
	it("false when the start or end was moved", () => {
		expect(isFullSelection(5, 120, 120)).toBe(false);
		expect(isFullSelection(0, 100, 120)).toBe(false);
	});
	it("false when duration is unknown", () => {
		expect(isFullSelection(0, 0, 0)).toBe(false);
	});
});

describe("isMp4Source", () => {
	it("true for mp4 mime or extension", () => {
		expect(isMp4Source("video/mp4", "clip.mp4")).toBe(true);
		expect(isMp4Source("", "CLIP.MP4")).toBe(true);
		expect(isMp4Source("video/mp4", "no-extension")).toBe(true);
	});
	it("false for non-mp4 sources", () => {
		expect(isMp4Source("video/quicktime", "clip.mov")).toBe(false);
		expect(isMp4Source("", "clip.webm")).toBe(false);
	});
});

describe("shouldUploadOriginal", () => {
	it("true only for an untrimmed mp4 (skip ffmpeg, upload as-is)", () => {
		expect(
			shouldUploadOriginal({
				inSec: 0,
				outSec: 600,
				duration: 600,
				fileType: "video/mp4",
				fileName: "big.mp4",
			}),
		).toBe(true);
	});
	it("false when the user actually trimmed", () => {
		expect(
			shouldUploadOriginal({
				inSec: 10,
				outSec: 600,
				duration: 600,
				fileType: "video/mp4",
				fileName: "big.mp4",
			}),
		).toBe(false);
	});
	it("false for a non-mp4 source even when untrimmed (needs transcode)", () => {
		expect(
			shouldUploadOriginal({
				inSec: 0,
				outSec: 600,
				duration: 600,
				fileType: "video/quicktime",
				fileName: "big.mov",
			}),
		).toBe(false);
	});
});
