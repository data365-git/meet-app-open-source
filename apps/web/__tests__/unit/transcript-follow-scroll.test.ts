import { describe, expect, it } from "vitest";
import {
	computeFollowScrollTop,
	isNearActiveRow,
} from "@/app/s/[videoId]/_components/utils/transcript-utils";

describe("computeFollowScrollTop", () => {
	it("does not move the container when the active row is already fully visible", () => {
		const target = computeFollowScrollTop({
			rowOffsetTop: 200,
			rowHeight: 40,
			containerScrollTop: 100,
			containerClientHeight: 300, // visible range [100, 400]; row [200, 240] fits
			containerScrollHeight: 2000,
		});
		expect(target).toBe(100);
	});

	it("scrolls up so the row's top aligns with the view when the row is above the viewport", () => {
		const target = computeFollowScrollTop({
			rowOffsetTop: 50,
			rowHeight: 40,
			containerScrollTop: 300, // visible range [300, 600]; row [50, 90] is above
			containerClientHeight: 300,
			containerScrollHeight: 2000,
		});
		expect(target).toBe(50);
	});

	it("scrolls down so the row's bottom aligns with the view when the row is below the viewport", () => {
		const target = computeFollowScrollTop({
			rowOffsetTop: 900,
			rowHeight: 40,
			containerScrollTop: 100, // visible range [100, 400]; row [900, 940] is below
			containerClientHeight: 300,
			containerScrollHeight: 2000,
		});
		expect(target).toBe(940 - 300);
	});

	it("clamps the target within [0, scrollHeight - clientHeight]", () => {
		const target = computeFollowScrollTop({
			rowOffsetTop: 1990,
			rowHeight: 40,
			containerScrollTop: 0,
			containerClientHeight: 300,
			containerScrollHeight: 2000,
		});
		// Row bottom (2030) minus clientHeight (300) = 1730, but max scrollTop is 1700.
		expect(target).toBe(1700);
	});
});

describe("isNearActiveRow", () => {
	it("is near when the row center matches the viewport center", () => {
		const near = isNearActiveRow({
			rowOffsetTop: 200,
			rowHeight: 40,
			containerScrollTop: 70, // view center = 70 + 150 = 220; row center = 220
			containerClientHeight: 300,
		});
		expect(near).toBe(true);
	});

	it("is near within the default 1.5 row-height threshold", () => {
		const rowHeight = 40;
		const near = isNearActiveRow({
			rowOffsetTop: 200,
			rowHeight,
			// distance = 1.5 * rowHeight exactly -> still within threshold (<=)
			containerScrollTop: 70 - 1.5 * rowHeight,
			containerClientHeight: 300,
		});
		expect(near).toBe(true);
	});

	it("is NOT near once scrolled well past the threshold (user scrolled away)", () => {
		const near = isNearActiveRow({
			rowOffsetTop: 200,
			rowHeight: 40,
			containerScrollTop: 70 - 500, // far above the active row
			containerClientHeight: 300,
		});
		expect(near).toBe(false);
	});

	it("supports a custom threshold", () => {
		const near = isNearActiveRow({
			rowOffsetTop: 200,
			rowHeight: 40,
			containerScrollTop: 70 - 100, // 100px away from center
			containerClientHeight: 300,
			thresholdRowHeights: 1, // 1 row-height = 40px, so 100px away is NOT near
		});
		expect(near).toBe(false);
	});
});
