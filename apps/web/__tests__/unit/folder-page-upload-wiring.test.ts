import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Task 1 root cause (qa-fixes): the folder page's toolbar rendered
// `<UploadCapButton size="sm" />` WITHOUT `folderId`, even though `folderId`
// is in scope — so every upload from inside a folder silently landed in
// root. `upload-cap-button-fast-path.test.ts` proves the button itself
// carries a given folderId all the way to createVideoForServerProcessing;
// this test proves the folder page actually HANDS it that folderId.
describe("folder page wires folderId into the toolbar upload button", () => {
	it("passes folderId to UploadCapButton", () => {
		const source = readFileSync(
			fileURLToPath(
				new URL(
					"../../app/(org)/dashboard/folder/[id]/page.tsx",
					import.meta.url,
				),
			),
			"utf8",
		);

		const match = source.match(/<UploadCapButton\s+([^/]*?)\/>/);
		expect(match).not.toBeNull();
		const props = match?.[1] ?? "";
		expect(props).toContain("folderId={folderId}");
	});
});
