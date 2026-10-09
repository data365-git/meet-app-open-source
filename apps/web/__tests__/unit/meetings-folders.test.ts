import { describe, expect, it, vi } from "vitest";

// meetings/page.tsx must query org-level folders (mirroring caps/page.tsx) and
// pass them through to <Meetings>, so a meeting moved into a folder is still
// reachable from the Meetings page via a folder card — instead of silently
// vanishing (it is excluded from the root list by `isNull(videos.folderId)`).

function makeChain(result: unknown) {
	const chain: Record<string, unknown> = {};
	const methods = [
		"from",
		"leftJoin",
		"innerJoin",
		"where",
		"groupBy",
		"orderBy",
		"limit",
		"offset",
	];
	for (const m of methods) {
		chain[m] = vi.fn(() => chain);
	}
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
		Promise.resolve(result).then(resolve, reject);
	chain.catch = (reject: (e: unknown) => unknown) =>
		Promise.resolve(result).catch(reject);
	return chain;
}

const MEETING_FOLDER = {
	id: "folder-1",
	name: "Standups",
	color: "normal" as const,
	public: false,
	parentId: null,
	videoCount: 1,
};

function setup(opts: { folders: unknown[] }) {
	vi.resetModules();

	const selectCalls: unknown[][] = [];
	const chains = [
		makeChain([{ count: 0 }]), // totalCountResult
		makeChain([]), // videoData (empty -> avoids needing Database/ImageUploads context)
		makeChain(opts.folders), // foldersData
		makeChain([{ settings: null }]), // organizationSettingsRow
	];
	let callIndex = 0;
	const selectMock = vi.fn((cols: unknown) => {
		selectCalls.push([cols]);
		const chain = chains[callIndex++];
		return chain;
	});

	vi.doMock("@cap/database", () => ({
		db: () => ({ select: selectMock }),
	}));

	vi.doMock("@cap/database/auth/session", () => ({
		getCurrentUser: vi.fn(async () => ({
			id: "user-1",
			activeOrganizationId: "org-1",
		})),
	}));

	vi.doMock("@cap/env", () => ({
		buildEnv: { NEXT_PUBLIC_IS_CAP: false },
		NODE_ENV: "test",
		serverEnv: vi.fn(() => ({
			TINYBIRD_TOKEN: undefined,
			TINYBIRD_HOST: undefined,
		})),
	}));

	vi.doMock("@cap/web-backend", () => ({
		Database: {},
		ImageUploads: {},
		resolveEffectiveVideoRules: vi.fn(() => ({
			hasInheritedPassword: false,
			inheritedPasswordSources: [],
			inheritedSettings: {},
		})),
	}));

	vi.doMock("next/navigation", () => ({
		redirect: vi.fn(() => {
			throw new Error("redirect() should not be called for a logged-in user");
		}),
	}));

	vi.doMock("@/lib/server", async () => {
		const { Effect } = await import("effect");
		return { runPromise: (effect: unknown) => Effect.runPromise(effect as never) };
	});

	// The real Meetings.tsx ("use client") transitively imports the web
	// recorder dialog, which touches browser-only APIs at module scope and
	// hangs under Node. We only need the props MeetingsPage hands it — those
	// live on the returned React element regardless of what the component is.
	vi.doMock("../../app/(org)/dashboard/meetings/Meetings", () => ({
		Meetings: () => null,
	}));

	return { selectCalls };
}

// MeetingsPage is an async Server Component: calling it does NOT render —
// it returns a React element descriptor whose `.props` we can inspect
// directly, without needing a DOM/rendering environment.
describe("MeetingsPage folders pass-through", () => {
	it("passes the org's folders through to <Meetings>, including one with a meeting inside it", async () => {
		setup({ folders: [MEETING_FOLDER] });

		const { default: MeetingsPage } = await import(
			"../../app/(org)/dashboard/meetings/page"
		);

		const element = (await MeetingsPage({
			searchParams: Promise.resolve({}),
		} as never)) as { props: Record<string, unknown> };

		const folders = element.props.folders as unknown[];
		expect(folders).toBeDefined();
		expect(folders.length).toBe(1);
		expect(folders[0]).toMatchObject({ id: "folder-1", name: "Standups" });
	});

	it("renders no folders when the org has none, without throwing", async () => {
		setup({ folders: [] });

		const { default: MeetingsPage } = await import(
			"../../app/(org)/dashboard/meetings/page"
		);

		const element = (await MeetingsPage({
			searchParams: Promise.resolve({}),
		} as never)) as { props: Record<string, unknown> };

		expect(element.props.folders).toEqual([]);
	});
});
