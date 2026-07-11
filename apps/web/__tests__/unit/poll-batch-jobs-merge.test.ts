import { describe, expect, it } from "vitest";
import {
	mergeBatchChunkIntoPartial,
	removeBatchJob,
} from "@/lib/batch-merge";

const cueCount = (vtt: string) =>
	vtt.split(/\r?\n\r?\n/).filter((b) => b.includes("-->")).length;

describe("mergeBatchChunkIntoPartial", () => {
	const partial =
		"WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nSalom dunyo.\n";
	// A chunk that belongs at 900s (chunk-relative timings).
	const batchChunk =
		"WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\nBu ikkinchi qism.\n\n2\n00:00:04.000 --> 00:00:08.000\nDavomi shu yerda.\n";

	it("merges a collected Batch chunk at its absolute offset", () => {
		const merged = mergeBatchChunkIntoPartial(partial, batchChunk, 900);
		expect(merged).toContain("Salom dunyo.");
		expect(merged).toContain("Bu ikkinchi qism.");
		expect(merged).toContain("Davomi shu yerda.");
		// The batch cue lands near 15:00 (900s), not at 0s.
		expect(merged).toContain("00:15:00.000");
		expect(cueCount(merged)).toBe(3);
	});

	it("is idempotent: merging the same chunk twice does not duplicate cues", () => {
		const once = mergeBatchChunkIntoPartial(partial, batchChunk, 900);
		const twice = mergeBatchChunkIntoPartial(once, batchChunk, 900);
		expect(cueCount(twice)).toBe(cueCount(once));
		// The repeated batch text appears exactly once, not twice.
		expect(twice.split("Bu ikkinchi qism.").length - 1).toBe(1);
	});

	it("treats a missing partial (empty WEBVTT) as an empty base", () => {
		const merged = mergeBatchChunkIntoPartial("WEBVTT\n\n", batchChunk, 900);
		expect(cueCount(merged)).toBe(2);
		expect(merged).toContain("Bu ikkinchi qism.");
	});
});

describe("removeBatchJob", () => {
	const jobs = [
		{ batchName: "batches/a", fileName: "files/a", startSec: 0, durationSec: 900, submittedAt: "t1" },
		{ batchName: "batches/b", fileName: "files/b", startSec: 900, durationSec: 900, submittedAt: "t2" },
	];

	it("removes only the named job", () => {
		const out = removeBatchJob(jobs, "batches/a");
		expect(out).toHaveLength(1);
		expect(out[0]?.batchName).toBe("batches/b");
	});

	it("is a no-op for an unknown job and tolerates undefined", () => {
		expect(removeBatchJob(jobs, "batches/z")).toHaveLength(2);
		expect(removeBatchJob(undefined, "batches/a")).toEqual([]);
	});
});
