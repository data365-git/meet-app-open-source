/**
 * Owner law 2026-09-26: "the system must not waste money - resume from where
 * it stopped, never a full re-do". A transcript that COMPLETEs with gaps used
 * to delete its resume checkpoint, so repairing one 196 s gap in a 3 h
 * recording re-billed all ~30 chunks (~$1). saveTranscription now keeps the
 * final transcript as the resume seed while gaps remain, and the existing
 * isChunkCoveredByPartial gate then re-bills only the gap's chunk.
 *
 * RED against the pre-fix workflow: the source-shape test fails (it only
 * deleted the seed), and the behavioural test pins that the seed actually
 * limits the re-bill to the gap chunk.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Minimal mocks so workflows/transcribe.ts imports for its pure exports
// (same set as transcribe-chunk-coverage.test.ts).
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));

import { isChunkCoveredByPartial } from "@/workflows/transcribe";

const SRC = readFileSync(
	fileURLToPath(new URL("../../workflows/transcribe.ts", import.meta.url)),
	"utf8",
);

function ts(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = Math.floor(sec % 60);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(h)}:${p(m)}:${p(s)}.000`;
}

/** A 3 h transcript with a cue every 5 s, except one real gap [4839, 5035). */
function gappedFinalVtt(totalSec: number, gap: [number, number]): string {
	const out = ["WEBVTT", ""];
	for (let t = 0; t < totalSec; t += 5) {
		if (t >= gap[0] && t < gap[1]) continue;
		out.push(`${ts(t)} --> ${ts(t + 4)}`, `cue at ${t}`, "");
	}
	return out.join("\n");
}

const CHUNK_SEC = 360; // production chunk size since 8ef9e17
const TOTAL_SEC = 3 * 3600;

function chunksToRebill(seed: string | undefined): number[] {
	const rebill: number[] = [];
	for (let start = 0; start < TOTAL_SEC; start += CHUNK_SEC) {
		const covered =
			seed !== undefined && isChunkCoveredByPartial(seed, start, CHUNK_SEC);
		if (!covered) rebill.push(start);
	}
	return rebill;
}

describe("gap repair re-bills only the gap, never the whole recording", () => {
	it("with the final transcript as seed, only the chunk holding the 196 s gap is re-billed", () => {
		const seed = gappedFinalVtt(TOTAL_SEC, [4839, 5035]);
		expect(chunksToRebill(seed)).toEqual([4680]);
	});

	it("without a seed (the pre-fix state after COMPLETE) every chunk is re-billed", () => {
		expect(chunksToRebill(undefined)).toHaveLength(TOTAL_SEC / CHUNK_SEC);
	});

	it("saveTranscription keeps the final transcript as the seed while gaps remain, deletes it only when clean", () => {
		const start = SRC.indexOf("\nasync function saveTranscription(");
		expect(start).toBeGreaterThan(-1);
		const next = SRC.slice(start + 1).search(/\n(?:export |async function |function )/);
		const body = SRC.slice(start, start + 1 + next);
		expect(body).toMatch(
			/if \(remainingGaps\.length > 0 \|\| coverageUnknown\) \{\s*await bucket\s*\.putObject\(partialKey, transcription/,
		);
		expect(body).toMatch(/\} else \{\s*await bucket\s*\.deleteObject\(partialKey\)/);
		expect(body).toContain("transcription-partial.vtt");
	});
});

describe("a media timeline change drops the resume seed (no old-clock text spliced into new media)", () => {
	for (const rel of [
		"../../workflows/edit-video.ts",
		"../../actions/videos/restore-original.ts",
	]) {
		it(`${rel.split("/").pop()} deletes transcription-partial.vtt`, () => {
			const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
			expect(src).toMatch(
				/\.deleteObject\(`\$\{video\.ownerId\}\/\$\{videoId\}\/transcription-partial\.vtt`\)/,
			);
		});
	}
});
