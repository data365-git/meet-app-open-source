// Multi-file import (owner order 2026-09-26): pick up to 20 files, they
// upload strictly one after another, a waiting file can be removed from the
// queue, and one cancelled/failed file must not sink the rest. These tests
// pin runUploadQueue's behaviour with a fake `upload` — behavioural, not
// snapshot: breaking the behaviour (e.g. making the loop parallel, or
// letting one failure abort the batch) turns the corresponding test red.
import { describe, expect, it } from "vitest";
import {
	queueAfterStart,
	capBatch,
	MAX_BATCH_FILES,
	runUploadQueue,
	type UploadQueueItem,
} from "@/app/(org)/dashboard/import/file/upload-queue";

function makeItems(count: number): UploadQueueItem[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `item-${i + 1}`,
		file: new File([`bytes-${i + 1}`], `file-${i + 1}.mp4`, {
			type: "video/mp4",
		}),
	}));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe("runUploadQueue", () => {
	it("(a) is strictly sequential: the 2nd upload starts only after the 1st resolves", async () => {
		const items = makeItems(2);
		const events: string[] = [];
		const firstGate = deferred<string>();

		const queuePromise = runUploadQueue({
			items,
			upload: (file) => {
				events.push(`start:${file.name}`);
				if (file.name === "file-1.mp4") return firstGate.promise;
				events.push("second-started");
				return Promise.resolve("id-2");
			},
			isRemoved: () => false,
			onStart: (index) => events.push(`onStart:${index}`),
		});

		// Give the loop a chance to (wrongly) start the 2nd upload early.
		await new Promise((r) => setTimeout(r, 20));
		expect(events).not.toContain("second-started");
		expect(events).toContain("start:file-1.mp4");

		firstGate.resolve("id-1");
		const result = await queuePromise;
		expect(events).toContain("second-started");
		expect(result).toEqual({ uploaded: 2, notUploaded: 0, removed: 0 });
	});

	it("(b) never passes a removed id to upload — it is skipped and counted", async () => {
		const items = makeItems(3);
		const uploadedNames: string[] = [];

		const result = await runUploadQueue({
			items,
			upload: async (file) => {
				uploadedNames.push(file.name);
				return `id-${file.name}`;
			},
			isRemoved: (id) => id === "item-2",
		});

		expect(uploadedNames).toEqual(["file-1.mp4", "file-3.mp4"]);
		expect(result).toEqual({ uploaded: 2, notUploaded: 0, removed: 1 });
	});

	it("(c) a null result (cancelled/failed) for item 2 of 3 still uploads items 1 and 3", async () => {
		const items = makeItems(3);
		const uploadedNames: string[] = [];

		const result = await runUploadQueue({
			items,
			upload: async (file) => {
				uploadedNames.push(file.name);
				return file.name === "file-2.mp4" ? null : `id-${file.name}`;
			},
			isRemoved: () => false,
		});

		expect(uploadedNames).toEqual(["file-1.mp4", "file-2.mp4", "file-3.mp4"]);
		expect(result).toEqual({ uploaded: 2, notUploaded: 1, removed: 0 });
	});

	it("(d) a thrown error for item 1 counts as notUploaded and the loop continues", async () => {
		const items = makeItems(3);
		const uploadedNames: string[] = [];

		const result = await runUploadQueue({
			items,
			upload: async (file) => {
				uploadedNames.push(file.name);
				if (file.name === "file-1.mp4") {
					throw new Error("network gone");
				}
				return `id-${file.name}`;
			},
			isRemoved: () => false,
		});

		expect(uploadedNames).toEqual(["file-1.mp4", "file-2.mp4", "file-3.mp4"]);
		expect(result).toEqual({ uploaded: 2, notUploaded: 1, removed: 0 });
	});
});

describe("batch cap", () => {
	it("(e) MAX_BATCH_FILES is 20", () => {
		expect(MAX_BATCH_FILES).toBe(20);
	});

	it("(e) capBatch takes the first 20 of 25 and reports the 5 dropped", () => {
		const realFiles = Array.from(
			{ length: 25 },
			(_, i) => new File(["x"], `f-${i + 1}.mp4`),
		);

		const { taken, dropped } = capBatch(realFiles);
		expect(taken).toHaveLength(20);
		expect(dropped).toBe(5);
		expect(taken[0]?.name).toBe("f-1.mp4");
		expect(taken[19]?.name).toBe("f-20.mp4");
	});

	it("(e) capBatch is a no-op at or below the limit", () => {
		const realFiles = Array.from(
			{ length: 20 },
			(_, i) => new File(["x"], `f-${i + 1}.mp4`),
		);
		const { taken, dropped } = capBatch(realFiles);
		expect(taken).toHaveLength(20);
		expect(dropped).toBe(0);
	});
});

describe("queueAfterStart - a removed file stays removed", () => {
	it("drops only the starting file and never re-adds one the user removed", () => {
		const original = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
		// user removed "c" while "a" was uploading; now "b" starts
		const live = original.filter((e) => e.id !== "a" && e.id !== "c");
		expect(queueAfterStart(live, "b").map((e) => e.id)).toEqual(["d"]);
	});
	it("empty/undefined live queue is safe", () => {
		expect(queueAfterStart(undefined, "x")).toEqual([]);
	});
});
