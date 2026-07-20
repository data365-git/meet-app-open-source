import { describe, expect, it } from "vitest";

import { transcriptionErrorMessageKey } from "@/app/s/[videoId]/_components/transcription-error-message";

describe("transcriptionErrorMessageKey", () => {
	it("tells the OWNER plainly that the AI account needs topping up", () => {
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: "QUOTA",
				canGenerate: true,
			}),
		).toBe("aiTranscriptionQuotaFailed");
	});

	it("gives a PUBLIC viewer the same promise without exposing the billing state", () => {
		// A share link reaches strangers; they should learn the recording is safe
		// and a retry is coming, not that the host ran out of money.
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: "QUOTA",
				canGenerate: false,
			}),
		).toBe("aiTranscriptionQuotaFailedPublic");
	});

	it("uses the generic transcription message for a GENUINE failure", () => {
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: "FAILED",
				canGenerate: true,
			}),
		).toBe("aiTranscriptionFailed");
	});

	it("does not claim a quota problem when no reason was recorded", () => {
		// Videos that failed before this feature shipped have no code stored.
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "ERROR",
				transcriptionErrorCode: null,
				canGenerate: true,
			}),
		).toBe("aiTranscriptionFailed");
	});

	it("never shows a transcription message when the AI pass is what failed", () => {
		expect(
			transcriptionErrorMessageKey({
				transcriptionStatus: "COMPLETE",
				transcriptionErrorCode: "QUOTA",
				canGenerate: true,
			}),
		).toBe("aiGenerationError");
	});
});
