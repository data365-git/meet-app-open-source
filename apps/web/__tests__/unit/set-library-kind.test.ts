import { organizationMembers, videos } from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The contract under test: moving a video between the Recordings and Meetings
// libraries writes ONLY `libraryKind`. `videos.source` is the immutable record
// of HOW the video was captured — playback (api vs playlist), sharing
// (ShareVideo) and editing (save-edits) all branch on `source.type`, so
// rewriting it to fake a library membership would make the moved video
// unplayable. These tests apply the action's real SET payload to a fake row and
// assert the row's source bytes are unchanged.

// Spy on the REAL drizzle helpers (don't stub them out) so we can assert WHICH
// columns the membership guard filters on — the db fakes ignore the predicate
// entirely, so an error branch alone would prove nothing.
const { eqSpy } = vi.hoisted(() => ({ eqSpy: vi.fn() }));
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: (...args: Parameters<typeof actual.eq>) => {
			eqSpy(...args);
			return actual.eq(...args);
		},
	};
});

const getCurrentUserMock = vi.fn();
const selectWhereMock = vi.fn();
const updateWhereMock = vi.fn(async () => undefined);
const setPayloads: Record<string, unknown>[] = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: selectWhereMock }) }),
		update: () => ({
			set: (payload: Record<string, unknown>) => {
				setPayloads.push(payload);
				return { where: updateWhereMock };
			},
		}),
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("server-only", () => ({}));

type FakeVideoRow = {
	id: string;
	ownerId: string;
	orgId: string;
	libraryKind: "recording" | "meeting" | null;
	source: Record<string, unknown>;
};

function loomImportedVideo(): FakeVideoRow {
	return {
		id: "vid-loom",
		ownerId: "user-1",
		orgId: "org-1",
		libraryKind: null,
		// A Loom import lands as a plain remote MP4. If a move rewrote this to
		// look like an extension meeting capture, playback and sharing would
		// resolve the wrong storage path.
		source: { type: "webMP4" },
	};
}

/** Apply the action's real SET payload to a row, the way MySQL would. */
function applySetPayload(row: FakeVideoRow, payload: Record<string, unknown>) {
	return { ...row, ...payload } as FakeVideoRow;
}

function arrangeCaller(rows: FakeVideoRow[]) {
	getCurrentUserMock.mockResolvedValueOnce({
		id: "user-1",
		activeOrganizationId: "org-1",
	});
	selectWhereMock
		// membership lookup
		.mockResolvedValueOnce([{ organizationId: "org-1" }])
		// videos the caller is allowed to touch
		.mockResolvedValueOnce(rows.map((r) => ({ id: r.id })));
}

async function importAction() {
	return (await import("@/actions/videos/set-library-kind"))
		.setVideosLibraryKind;
}

describe("setVideosLibraryKind", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setPayloads.length = 0;
	});

	it("writes ONLY libraryKind — source is byte-identical after a move", async () => {
		const row = loomImportedVideo();
		const before = JSON.stringify(row.source);

		arrangeCaller([row]);
		const setVideosLibraryKind = await importAction();

		const result = await setVideosLibraryKind(["vid-loom"] as never, "meeting");

		expect(result).toEqual({ success: true, movedIds: ["vid-loom"] });
		expect(setPayloads).toHaveLength(1);
		// The teeth: the SET clause contains exactly one column.
		expect(Object.keys(setPayloads[0]!)).toEqual(["libraryKind"]);
		expect(setPayloads[0]).not.toHaveProperty("source");

		const after = applySetPayload(row, setPayloads[0]!);
		expect(after.libraryKind).toBe("meeting");
		expect(JSON.stringify(after.source)).toBe(before);
	});

	it("moves a Loom-imported webMP4 video to Meetings and back, source untouched", async () => {
		const original = loomImportedVideo();
		const originalBytes = JSON.stringify(original.source);
		const setVideosLibraryKind = await importAction();

		arrangeCaller([original]);
		const toMeetings = await setVideosLibraryKind(
			["vid-loom"] as never,
			"meeting",
		);
		expect(toMeetings.success).toBe(true);
		const inMeetings = applySetPayload(original, setPayloads[0]!);
		expect(inMeetings.libraryKind).toBe("meeting");

		arrangeCaller([inMeetings]);
		const backToRecordings = await setVideosLibraryKind(
			["vid-loom"] as never,
			"recording",
		);
		expect(backToRecordings.success).toBe(true);
		const backHome = applySetPayload(inMeetings, setPayloads[1]!);

		expect(backHome.libraryKind).toBe("recording");
		// Round-tripped through both libraries: still the same webMP4 source.
		expect(JSON.stringify(backHome.source)).toBe(originalBytes);
		expect(backHome.source.type).toBe("webMP4");
		for (const payload of setPayloads) {
			expect(Object.keys(payload)).toEqual(["libraryKind"]);
		}
	});

	it("moves a LIST of videos in one write", async () => {
		const rows: FakeVideoRow[] = [
			{ ...loomImportedVideo(), id: "vid-a" },
			{
				...loomImportedVideo(),
				id: "vid-b",
				source: { type: "extensionWeb", context: "meeting" },
			},
			{ ...loomImportedVideo(), id: "vid-c", source: { type: "desktopMP4" } },
		];
		const before = rows.map((r) => JSON.stringify(r.source));

		arrangeCaller(rows);
		const setVideosLibraryKind = await importAction();

		const result = await setVideosLibraryKind(
			["vid-a", "vid-b", "vid-c"] as never,
			"recording",
		);

		expect(result).toEqual({
			success: true,
			movedIds: ["vid-a", "vid-b", "vid-c"],
		});
		expect(setPayloads).toHaveLength(1);
		expect(Object.keys(setPayloads[0]!)).toEqual(["libraryKind"]);
		rows.forEach((row, i) => {
			const after = applySetPayload(row, setPayloads[0]!);
			expect(after.libraryKind).toBe("recording");
			expect(JSON.stringify(after.source)).toBe(before[i]);
		});
	});

	it("is membership-guarded: scopes the lookup to the caller and never writes when nothing is accessible", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-attacker",
			activeOrganizationId: "org-attacker",
		});
		selectWhereMock
			.mockResolvedValueOnce([{ organizationId: "org-attacker" }])
			// Scoped lookup finds nothing: the video belongs to someone else.
			.mockResolvedValueOnce([]);

		const setVideosLibraryKind = await importAction();
		const result = await setVideosLibraryKind(["vid-victim"] as never, "meeting");

		expect(result).toEqual({
			success: false,
			error: "No videos found or not accessible",
		});
		expect(setPayloads).toHaveLength(0);
		expect(updateWhereMock).not.toHaveBeenCalled();

		// Prove the guard is keyed on the caller AND on video ownership, not just
		// "is someone logged in".
		expect(eqSpy).toHaveBeenCalledWith(
			organizationMembers.userId,
			"user-attacker",
		);
		expect(eqSpy).toHaveBeenCalledWith(videos.ownerId, "user-attacker");
	});

	it("rejects an unauthenticated caller and an invalid library", async () => {
		getCurrentUserMock.mockResolvedValueOnce(null);
		const setVideosLibraryKind = await importAction();
		expect(await setVideosLibraryKind(["vid-a"] as never, "meeting")).toEqual({
			success: false,
			error: "Unauthorized",
		});

		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1" });
		expect(
			await setVideosLibraryKind(["vid-a"] as never, "archive" as never),
		).toEqual({ success: false, error: "Invalid library" });

		expect(setPayloads).toHaveLength(0);
	});
});
