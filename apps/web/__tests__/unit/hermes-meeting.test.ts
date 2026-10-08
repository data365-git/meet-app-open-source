import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, it } from "vitest";
import {
	applyHermesAck,
	buildHermesMeetingFileName,
	checkHermesQueueToken,
	isInMeetingsLibrary,
	validateHermesClientFields,
} from "@/lib/hermes-meeting";

// ADR 2026-10-08: meeting recordings go to the Hermes CRM folder on the Mac.
// The Mac PULLS them: data365 keeps a token-protected queue, the Mac polls it
// every 5 min, writes `YYYY-MM-DD_<clientName>_<company>_meet.txt` and ACKs.
// These tests pin the pure core of that contract: the file name (Tashkent
// date + sanitising), the token gate, queue selection and the idempotent ack.

const QUEUED_META = (
	over: Partial<NonNullable<VideoMetadata["hermes"]>> = {},
): VideoMetadata => ({
	hermes: {
		status: "queued",
		clientName: "Ali",
		company: "ACME",
		queuedAt: "2026-10-08T10:00:00.000Z",
		...over,
	},
});

describe("buildHermesMeetingFileName", () => {
	it("formats the recording date in Asia/Tashkent (UTC+5, no DST)", () => {
		// 20:30Z on Oct 8 is already Oct 9 in Tashkent — a UTC formatter
		// would name the file with yesterday's date.
		expect(
			buildHermesMeetingFileName({
				clientName: "Bunyod",
				company: "Hermes",
				recordedAt: "2026-10-08T20:30:00.000Z",
			}),
		).toBe("2026-10-09_Bunyod_Hermes_meet.txt");

		// 18:59:59Z vs 19:00:00Z is the Tashkent midnight boundary.
		expect(
			buildHermesMeetingFileName({
				clientName: "A",
				company: "B",
				recordedAt: "2026-01-01T18:59:59.000Z",
			}),
		).toBe("2026-01-01_A_B_meet.txt");
		expect(
			buildHermesMeetingFileName({
				clientName: "A",
				company: "B",
				recordedAt: "2026-01-01T19:00:00.000Z",
			}),
		).toBe("2026-01-02_A_B_meet.txt");
	});

	it("accepts a Date object too", () => {
		expect(
			buildHermesMeetingFileName({
				clientName: "A",
				company: "B",
				recordedAt: new Date("2026-03-05T02:00:00.000Z"),
			}),
		).toBe("2026-03-05_A_B_meet.txt");
	});

	it("turns spaces into underscores in both name parts", () => {
		expect(
			buildHermesMeetingFileName({
				clientName: "Ali  Vali",
				company: "ACME Corp LLC",
				recordedAt: "2026-10-08T05:00:00.000Z",
			}),
		).toBe("2026-10-08_Ali_Vali_ACME_Corp_LLC_meet.txt");
	});

	it("strips characters illegal in macOS/Windows file names", () => {
		expect(
			buildHermesMeetingFileName({
				clientName: 'A/BC:D*E?F"G<H>I|J',
				company: "Kompaniya",
				recordedAt: "2026-10-08T05:00:00.000Z",
			}),
		).toBe("2026-10-08_ABCDEFGHIJ_Kompaniya_meet.txt");
	});

	it("strips backslashes too (Windows path separator)", () => {
		expect(
			buildHermesMeetingFileName({
				clientName: "A\\BC",
				company: "Kompaniya",
				recordedAt: "2026-10-08T05:00:00.000Z",
			}),
		).toBe("2026-10-08_ABC_Kompaniya_meet.txt");
	});

	it("strips trailing dots AFTER the trailing underscore/space removal", () => {
		// "A. " -> "A._" after the space swap -> the trailing dot must not
		// survive behind the stripped underscore (Windows dislikes it).
		expect(
			buildHermesMeetingFileName({
				clientName: "A. ",
				company: "Kompaniya",
				recordedAt: "2026-10-08T05:00:00.000Z",
			}),
		).toBe("2026-10-08_A_Kompaniya_meet.txt");
	});

	it("keeps Uzbek/Cyrillic letters readable", () => {
		expect(
			buildHermesMeetingFileName({
				clientName: "Йиғилиш",
				company: "Компания",
				recordedAt: "2026-10-08T05:00:00.000Z",
			}),
		).toBe("2026-10-08_Йиғилиш_Компания_meet.txt");
	});
});

describe("checkHermesQueueToken", () => {
	it("is 503 when HERMES_QUEUE_TOKEN is unset", () => {
		expect(checkHermesQueueToken("Bearer anything", undefined)).toEqual({
			ok: false,
			status: 503,
		});
		expect(checkHermesQueueToken(null, undefined)).toEqual({
			ok: false,
			status: 503,
		});
	});

	it("is 401 when the header is missing or has no Bearer scheme", () => {
		const expected = "sekret-token";
		expect(checkHermesQueueToken(null, expected)).toEqual({
			ok: false,
			status: 401,
		});
		expect(checkHermesQueueToken("", expected)).toEqual({
			ok: false,
			status: 401,
		});
		expect(checkHermesQueueToken("sekret-token", expected)).toEqual({
			ok: false,
			status: 401,
		});
	});

	it("accepts the right token and rejects a wrong one", () => {
		const expected = "sekret-token";
		expect(checkHermesQueueToken(`Bearer ${expected}`, expected)).toEqual({
			ok: true,
		});
		expect(checkHermesQueueToken("Bearer boshqa-token", expected)).toEqual({
			ok: false,
			status: 401,
		});
	});

	it("never leaks via length: a longer token sharing the prefix is still 401", () => {
		const expected = "abc";
		expect(checkHermesQueueToken("Bearer abcdefghijk", expected)).toEqual({
			ok: false,
			status: 401,
		});
		expect(checkHermesQueueToken("Bearer a", expected)).toEqual({
			ok: false,
			status: 401,
		});
	});
});

describe("applyHermesAck", () => {
	it("marks the video delivered with the Mac-side fileName", () => {
		const next = applyHermesAck(
			QUEUED_META(),
			"2026-10-09_Bunyod_Hermes_meet.txt",
			"2026-10-09T06:00:00.000Z",
		);
		expect(next.hermes?.status).toBe("delivered");
		expect(next.hermes?.fileName).toBe("2026-10-09_Bunyod_Hermes_meet.txt");
		expect(next.hermes?.deliveredAt).toBe("2026-10-09T06:00:00.000Z");
		// Who was queued survives, for the data365-side mark.
		expect(next.hermes?.clientName).toBe("Ali");
		expect(next.hermes?.company).toBe("ACME");
	});

	it("is idempotent: a repeated ack does not move deliveredAt", () => {
		const first = applyHermesAck(
			QUEUED_META(),
			"a.txt",
			"2026-10-09T06:00:00.000Z",
		);
		const again = applyHermesAck(first, "a.txt", "2026-10-10T09:00:00.000Z");
		expect(again).toEqual(first);
	});

	it("leaves anything but queued unchanged (a declined video is never delivered)", () => {
		const declined: VideoMetadata = { hermes: { status: "declined" } };
		expect(
			applyHermesAck(declined, "a.txt", "2026-10-09T06:00:00.000Z"),
		).toEqual(declined);
	});
});

describe("validateHermesClientFields", () => {
	it("trims both fields", () => {
		expect(validateHermesClientFields("  Ali ", " ACME ")).toEqual({
			clientName: "Ali",
			company: "ACME",
		});
	});

	it("rejects empty (after trim) fields", () => {
		expect(validateHermesClientFields("", "ACME")).toBeNull();
		expect(validateHermesClientFields("   ", "ACME")).toBeNull();
		expect(validateHermesClientFields("Ali", "")).toBeNull();
		expect(validateHermesClientFields("Ali", "   ")).toBeNull();
	});

	it("rejects fields longer than 60 characters", () => {
		expect(validateHermesClientFields("a".repeat(61), "ACME")).toBeNull();
		expect(validateHermesClientFields("Ali", "b".repeat(61))).toBeNull();
		expect(validateHermesClientFields("a".repeat(60), "b".repeat(60))).toEqual({
			clientName: "a".repeat(60),
			company: "b".repeat(60),
		});
	});
});

describe("isInMeetingsLibrary", () => {
	it("trusts libraryKind when set", () => {
		expect(isInMeetingsLibrary({ libraryKind: "meeting", source: null })).toBe(
			true,
		);
		expect(
			isInMeetingsLibrary({
				libraryKind: "recording",
				source: { type: "extensionWeb", context: "meeting" },
			}),
		).toBe(false);
	});

	it("falls back to the captured-as-meeting rule only when libraryKind is NULL", () => {
		expect(
			isInMeetingsLibrary({
				libraryKind: null,
				source: { type: "extensionWeb", context: "meeting" },
			}),
		).toBe(true);
		expect(
			isInMeetingsLibrary({
				libraryKind: null,
				source: { type: "extensionWeb", context: "other" },
			}),
		).toBe(false);
		expect(isInMeetingsLibrary({ libraryKind: null, source: null })).toBe(
			false,
		);
	});
});
