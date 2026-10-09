import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-10-09 prod incident (video z89zsr2jz1q4eym): result.mp4 was a 151 s
// truncation of a 2095.68 s recording; extractAudio probed it, OVERWROTE
// videos.duration with 151.03 and transcribed 2.5 min as COMPLETE. Mocks
// mirror transcribe-delete-abort.test.ts.
const H = vi.hoisted(() => ({
	set: vi.fn(),
	checkHasAudioTrack: vi.fn(),
	existingKeys: new Set<string>(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [] }),
			}),
		}),
		update: () => ({
			set: (values: unknown) => {
				H.set(values);
				return { where: async () => undefined };
			},
		}),
	}),
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({ decrypt: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: () => ({
		pipe: async () => [
			{
				getInternalSignedObjectUrl: (key: string) => ({
					pipe: async () => `https://signed.test/${key}`,
				}),
				putObject: vi.fn(),
			},
		],
	}),
}));
vi.mock("@/lib/ai-generation-request", () => ({
	shouldStartAiAfterTranscription: vi.fn(),
}));
vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/wav",
	ENHANCED_AUDIO_EXTENSION: "wav",
	enhanceAudioFromUrl: vi.fn(),
}));
vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: (url: string) => H.checkHasAudioTrack(url),
	extractAudioChunksFromUrl: vi.fn(),
	extractAudioFromUrl: vi.fn(),
	extractAudioSpanFromUrl: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcription-settings", () => ({
	isTranscriptionDisabled: vi.fn(),
}));
vi.mock("@/lib/restore-russian-script", () => ({
	restoreRussianScript: (s: string) => s,
}));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("@/lib/video-alive", () => ({ assertVideoNotDeleted: vi.fn() }));
vi.mock("@/lib/ai-cost-guard", () => ({ withCostGuard: vi.fn() }));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: class BatchFallbackError extends Error {},
	transcribeChunkWithBatch: vi.fn(),
	submitChunkBatch: vi.fn(),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: vi.fn(async () => undefined),
}));
vi.mock("@/lib/gemini-transcribe", () => ({
	transcribeWithGemini: vi.fn(),
	extractSpeakerLabels: () => [],
	mergeChunkedWebVtt: () => "",
	rescaleChunkVtt: (vtt: string) => ({
		vtt,
		applied: false,
		reason: "test",
		factor: 1,
	}),
	setRescaleAnchorProbe: vi.fn(),
}));

import {
	extractAudio,
	INCOMPLETE_VIDEO_TRANSCRIPTION_ERROR,
} from "@/workflows/transcribe";

const video = (duration: number | null) =>
	({ id: "v1", ownerId: "o1", duration }) as never;

describe("extractAudio — truncated source guard", () => {
	beforeEach(() => {
		H.set.mockClear();
		H.checkHasAudioTrack.mockReset();
		H.existingKeys = new Set(["o1/v1/result.mp4"]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => ({
				ok: [...H.existingKeys].some((k) => String(url).endsWith(k)),
			})),
		);
	});

	it("with a raw-upload present: switches to it and never overwrites duration with the short probe", async () => {
		H.existingKeys.add("o1/v1/raw-upload.mp4");
		H.checkHasAudioTrack.mockImplementation(async (url: string) =>
			url.endsWith("result.mp4")
				? { hasAudio: true, durationSec: 151.03 }
				: { hasAudio: false, durationSec: 2095.68 },
		);

		await extractAudio("v1", "u1", video(2095.68));

		const probed = H.checkHasAudioTrack.mock.calls.map((c) => String(c[0]));
		expect(probed.at(-1)).toContain("raw-upload.mp4");
		expect(H.set).not.toHaveBeenCalledWith({ duration: 151.03 });
	});

	it("without a raw-upload: fails with the honest error, duration untouched", async () => {
		H.checkHasAudioTrack.mockResolvedValue({
			hasAudio: true,
			durationSec: 151.03,
		});

		await expect(extractAudio("v1", "u1", video(2095.68))).rejects.toThrow(
			INCOMPLETE_VIDEO_TRANSCRIPTION_ERROR,
		);
		expect(INCOMPLETE_VIDEO_TRANSCRIPTION_ERROR).toBe(
			"Video fayli to'liq emas — transkript qilinmadi. Videoni qayta yuklang.",
		);
		expect(H.set).not.toHaveBeenCalled();
	});

	it("a legit first write (stored duration null) still writes the probe", async () => {
		H.checkHasAudioTrack.mockResolvedValue({
			hasAudio: false,
			durationSec: 151.03,
		});

		await extractAudio("v1", "u1", video(null));

		expect(H.set).toHaveBeenCalledWith({ duration: 151.03 });
	});

	it("a client-estimated duration a few percent long is corrected, not refused", async () => {
		H.checkHasAudioTrack.mockResolvedValue({
			hasAudio: false,
			durationSec: 585,
		});

		await extractAudio("v1", "u1", video(600));

		expect(H.set).toHaveBeenCalledWith({ duration: 585 });
	});
});
