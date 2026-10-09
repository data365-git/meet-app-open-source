// Regression test: newly created recordings must default to PRIVATE.
//
// Every video-creation call site (extension `createInstantRecording` in
// packages/web-backend/src/Videos/index.ts, the web upload path in
// apps/web/actions/video/upload.ts, create-for-processing.ts, loom.ts, and
// the desktop API route) sets `public: serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC`
// with no other logic. So the single source of truth for "is a brand new
// recording publicly viewable by an anonymous user" is:
//   1. the CAP_VIDEOS_DEFAULT_PUBLIC env default (this file), and
//   2. VideosPolicy.canView's handling of `public: false`, which
//      apps/web/__tests__/unit/videos-policy.test.ts already covers
//      ("private video without membership" -> denies anonymous user).
//
// This test exercises the real (unmocked) @cap/env schema — not a stub —
// so it fails if anyone flips the default back to public.
import { beforeEach, describe, expect, it, vi } from "vitest";

const REQUIRED_ENV = {
	DATABASE_URL: "mysql://user:pass@localhost:3306/test",
	WEB_URL: "https://example.test",
	NEXTAUTH_SECRET: "test-secret",
	NEXTAUTH_URL: "https://example.test",
	CAP_AWS_BUCKET: "test-bucket",
	CAP_AWS_REGION: "us-east-1",
	INVITE_TOKEN_SECRET: "test-invite-secret",
};

describe("CAP_VIDEOS_DEFAULT_PUBLIC (new-recording visibility default)", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		for (const [key, value] of Object.entries(REQUIRED_ENV)) {
			vi.stubEnv(key, value);
		}
		// Explicitly unset — mirrors an operator who never set this Railway var,
		// which is the documented/undocumented-but-real default in
		// docs/DEPLOY_CHECKLIST.md and RAILWAY_ENV.md.
		vi.stubEnv("CAP_VIDEOS_DEFAULT_PUBLIC", undefined as unknown as string);
	});

	it("defaults new recordings to private when unset", async () => {
		const { serverEnv } = await import("@cap/env");
		expect(serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC).toBe(false);
	});
});
