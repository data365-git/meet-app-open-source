import { afterEach, describe, expect, it, vi } from "vitest";
import {
	lockLandscape,
	unlockOrientation,
} from "@/app/s/[videoId]/_components/utils/orientation-lock";

const originalScreen = globalThis.screen;

function setScreen(orientation: unknown) {
	Object.defineProperty(globalThis, "screen", {
		configurable: true,
		value: orientation === undefined ? undefined : { orientation },
	});
}

afterEach(() => {
	Object.defineProperty(globalThis, "screen", {
		configurable: true,
		value: originalScreen,
	});
});

describe("lockLandscape", () => {
	it("calls orientation.lock with \"landscape\"", () => {
		const lock = vi.fn(() => Promise.resolve());
		setScreen({ lock });
		lockLandscape();
		expect(lock).toHaveBeenCalledTimes(1);
		expect(lock).toHaveBeenCalledWith("landscape");
	});

	it("swallows a rejected lock() promise (no unhandled rejection)", async () => {
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		const lock = vi.fn(() => Promise.reject(new Error("not allowed")));
		setScreen({ lock });

		lockLandscape();
		// Let the microtask queue drain so an unswallowed rejection would surface.
		await new Promise((resolve) => setImmediate(resolve));

		process.off("unhandledRejection", unhandled);
		expect(lock).toHaveBeenCalledWith("landscape");
		expect(unhandled).not.toHaveBeenCalled();
	});

	it("swallows a synchronous throw from lock()", () => {
		const lock = vi.fn(() => {
			throw new Error("sync boom");
		});
		setScreen({ lock });
		expect(() => lockLandscape()).not.toThrow();
	});

	it("does not throw when orientation.lock is missing", () => {
		setScreen({});
		expect(() => lockLandscape()).not.toThrow();
	});

	it("does not throw when screen is undefined", () => {
		setScreen(undefined);
		expect(() => lockLandscape()).not.toThrow();
	});
});

describe("unlockOrientation", () => {
	it("calls orientation.unlock when available", () => {
		const unlock = vi.fn();
		setScreen({ unlock });
		unlockOrientation();
		expect(unlock).toHaveBeenCalledTimes(1);
	});

	it("does not throw when orientation.unlock is missing", () => {
		setScreen({});
		expect(() => unlockOrientation()).not.toThrow();
	});

	it("does not throw when screen is undefined", () => {
		setScreen(undefined);
		expect(() => unlockOrientation()).not.toThrow();
	});
});
