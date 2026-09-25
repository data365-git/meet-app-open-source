import { describe, expect, it, vi } from "vitest";

// ─── Mock heavy production dependencies that transcribe.ts imports ────────────
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({ decrypt: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
vi.mock("@/lib/ai-cost-guard", () => ({ withCostGuard: vi.fn() }));
vi.mock("@/lib/ai-generation-request", () => ({
  shouldStartAiAfterTranscription: vi.fn(),
}));
vi.mock("@/lib/audio-enhance", () => ({
  ENHANCED_AUDIO_CONTENT_TYPE: "audio/wav",
  ENHANCED_AUDIO_EXTENSION: "wav",
  enhanceAudioFromUrl: vi.fn(),
}));
vi.mock("@/lib/audio-extract", () => ({
  checkHasAudioTrack: vi.fn(),
  extractAudioChunksFromUrl: vi.fn(),
  extractAudioFromUrl: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcription-settings", () => ({
  isTranscriptionDisabled: vi.fn(),
}));
vi.mock("@/lib/video-alive", () => ({ assertVideoNotDeleted: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
  FatalError: class FatalError extends Error {
    readonly _tag = "FatalError";
  },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { mergeChunkedWebVtt } from "@/lib/gemini-transcribe";
import { transcribeAudioChunks } from "@/workflows/transcribe";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };
const STARTS = [0, 900, 1800, 2700];
const audio = {
  chunks: STARTS.map((startSec) => ({
    key: `chunk-${startSec}`,
    url: `https://example.com/audio-${startSec}.mp3`,
    startSec,
    durationSec: 900 as number | null,
  })),
  totalDurationSec: STARTS.length * 900,
};

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000`;
}

function cue(n: number, startSec: number, text: string): string {
  return `${n}\n${fmt(startSec)} --> ${fmt(startSec + 2)}\n${text}\n`;
}

/** Checkpoint: chunks 1, 2 and 4 (0, 900, 2700) densely covered; chunk 3
 *  (1800) holds two stale cues with a 590s hole → fails the coverage gate. */
function partialWithSparseChunk3(): string {
  const cues: string[] = [];
  let n = 1;
  for (const base of [0, 900]) {
    for (let s = 0; s <= 500; s += 100) cues.push(cue(n++, base + s, `seeded-${base + s}`));
  }
  cues.push(cue(n++, 1810, "stale-1800-a"));
  cues.push(cue(n++, 2400, "stale-1800-b"));
  for (let s = 0; s <= 500; s += 100) cues.push(cue(n++, 2700 + s, `seeded-${2700 + s}`));
  return `WEBVTT\n\n${cues.join("\n")}\n`;
}

const FRESH_CHUNK3 =
  `WEBVTT\n\n${cue(1, 10, "fresh-1800-a")}\n${cue(2, 100, "fresh-1800-b")}\n` +
  `${cue(3, 200, "fresh-1800-c")}\n${cue(4, 300, "fresh-1800-d")}\n` +
  `${cue(5, 400, "fresh-1800-e")}\n${cue(6, 500, "fresh-1800-f")}\n`;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const SEEDED = [0, 900, 2700].flatMap((b) =>
  [0, 100, 200, 300, 400, 500].map((s) => `seeded-${b + s}`),
);

describe("transcribeAudioChunks — resume replaces a re-transcribed chunk's stale seed cues", () => {
  it("fresh chunk-3 cues appear once, stale chunk-3 seed cues are gone, covered chunks untouched (result AND checkpoint)", async () => {
    const stub = vi.fn(async () => FRESH_CHUNK3);
    let lastCheckpoint = "";
    const onProgress = vi.fn(
      async (p: { transcribedChunks: Array<{ vtt: string; offsetSec: number }> }) => {
        lastCheckpoint = mergeChunkedWebVtt(p.transcribedChunks);
      },
    );

    const result = await transcribeAudioChunks(
      audio,
      null,
      CTX,
      stub,
      onProgress,
      partialWithSparseChunk3(),
    );

    // Only chunk 3 was re-transcribed.
    expect(stub).toHaveBeenCalledTimes(1);
    for (const out of [result, lastCheckpoint]) {
      for (const f of ["a", "b", "c", "d", "e", "f"]) {
        expect(count(out, `fresh-1800-${f}`)).toBe(1);
      }
      expect(out).not.toContain("stale-1800-a");
      expect(out).not.toContain("stale-1800-b");
      for (const s of SEEDED) expect(count(out, `${s}\n`)).toBe(1);
      // Covered chunks keep their exact timings.
      expect(out).toContain(`${fmt(2700)} --> `);
      expect(out).toContain(`${fmt(900)} --> `);
    }
  });

  it("re-transcription of chunk 3 FAILS → the old chunk-3 seed cues are still present", async () => {
    const stub = vi.fn(async () => {
      throw new Error("transient API error");
    });

    const result = await transcribeAudioChunks(
      audio,
      null,
      CTX,
      stub,
      undefined,
      partialWithSparseChunk3(),
    );

    expect(count(result, "stale-1800-a")).toBe(1);
    expect(count(result, "stale-1800-b")).toBe(1);
    for (const s of SEEDED) expect(count(result, `${s}\n`)).toBe(1);
  });

  it("re-transcription of chunk 3 returns NO cues → the old chunk-3 seed cues are still present", async () => {
    const stub = vi.fn(async () => "WEBVTT\n\n");

    const result = await transcribeAudioChunks(
      audio,
      null,
      CTX,
      stub,
      undefined,
      partialWithSparseChunk3(),
    );

    expect(count(result, "stale-1800-a")).toBe(1);
    expect(count(result, "stale-1800-b")).toBe(1);
  });
});
