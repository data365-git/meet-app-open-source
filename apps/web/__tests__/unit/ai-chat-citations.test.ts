import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderInline } from "@/app/s/[videoId]/_components/AIChatPopup";

// Owner spotted this in the live UI (2026-08-10): most timestamps in an AI
// answer were clickable chips, but the last ones — "[1:45:45, 2:01:40]" — were
// plain grey text. The model groups several citations into ONE bracket, and the
// old pattern only accepted a bracket holding a single timestamp, so a grouped
// citation silently lost its links.

function chips(nodes: React.ReactNode[]) {
	return nodes.filter(
		(n): n is ReactElement<{ className?: string; children?: unknown }> =>
			typeof n === "object" &&
			n !== null &&
			"props" in n &&
			(n as ReactElement<{ className?: string }>).props?.className ===
				"ai-citation",
	);
}

function labelOf(node: ReactElement<{ children?: unknown }>): string {
	// children render as ["[", "1:45:45", "]"]
	const kids = node.props.children as unknown[];
	return kids.flat().join("");
}

describe("AI chat timestamp citations", () => {
	it("links a single timestamp", () => {
		const out = renderInline("Shu yerda [4:12] aytildi.", vi.fn(), "k");
		expect(chips(out).map(labelOf)).toEqual(["[4:12]"]);
	});

	it("links an hour-long timestamp", () => {
		const out = renderInline("Keyin [1:25:50] da.", vi.fn(), "k");
		expect(chips(out).map(labelOf)).toEqual(["[1:25:50]"]);
	});

	it("links EVERY timestamp when several share one bracket", () => {
		const out = renderInline(
			"ko'rib chiqildi [1:45:45, 2:01:40].",
			vi.fn(),
			"k",
		);
		expect(chips(out).map(labelOf)).toEqual(["[1:45:45]", "[2:01:40]"]);
	});

	it("jumps to the right second for each chip in a group", () => {
		const jump = vi.fn();
		const out = renderInline("[1:45:45, 2:01:40]", jump, "k");
		const [first, second] = chips(out);
		(first?.props as { onClick: () => void }).onClick();
		(second?.props as { onClick: () => void }).onClick();
		expect(jump.mock.calls).toEqual([[6345], [7300]]);
	});

	it("keeps the separator the model wrote between grouped chips", () => {
		const out = renderInline("[1:45:45, 2:01:40]", vi.fn(), "k");
		// A bare space here would silently edit the sentence the user reads.
		expect(out).toContain(", ");
	});

	it("still renders bold and leaves ordinary brackets alone", () => {
		const out = renderInline("**ERP** va [eslatma] matn", vi.fn(), "k");
		expect(chips(out)).toHaveLength(0);
		expect(out.join("")).toContain("[eslatma]");
	});
});
