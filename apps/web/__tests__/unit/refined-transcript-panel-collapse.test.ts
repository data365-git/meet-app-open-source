// @vitest-environment jsdom
/**
 * Outcome tests for the refined-transcript chapter blocks
 * (app/s/[videoId]/_components/panels/RefinedTranscriptPanel.tsx).
 *
 * These drive the rendered component the way a user does — clicking the
 * title, the body and the play button — and assert what is on screen
 * afterwards (paragraphs visible? player seeked?), not which handler exists.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinedTranscriptPanel } from "@/app/s/[videoId]/_components/panels/RefinedTranscriptPanel";

interface Chapter {
	startSec: number;
	title: string;
	paragraphs: string[];
}

const CHAPTERS: Chapter[] = [
	{ startSec: 0, title: "Chapter One", paragraphs: ["one-body"] },
	{ startSec: 30, title: "Chapter Two", paragraphs: ["two-body"] },
	{ startSec: 60, title: "Chapter Three", paragraphs: ["three-body"] },
];

const messages = {
	share: {
		copied: "Copied",
		copyTranscript: "Copy transcript",
		downloadTxt: "Download TXT",
		downloadDocx: "Download DOCX",
		noRefinedTranscript: "No refined transcript yet",
		refinedTranscriptDesc: "A cleaned-up transcript will appear here.",
		toggleChapter: "Toggle chapter",
		playFromChapter: "Play from chapter {title}",
	},
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
		true;
	// jsdom has no layout: neutralise the panel's follow-scroll target.
	Element.prototype.scrollTo = () => {};
});

afterEach(() => {
	if (root) {
		act(() => root.unmount());
		root = null;
	}
	host?.remove();
	host = null;
});

function mount(
	chapters: Chapter[] | undefined,
	onVideoJump = vi.fn<(seconds: number) => void>(),
) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const paint = (next: Chapter[] | undefined) => {
		act(() => {
			root.render(
				createElement(
					NextIntlClientProvider,
					{ locale: "en", messages },
					createElement(RefinedTranscriptPanel, {
						refinedTranscript: next ? { chapters: next } : undefined,
						onVideoJump,
						duration: 300,
						currentTime: 0,
						videoTitle: "Recording",
					}),
				),
			);
		});
	};
	paint(chapters);
	return { paint, onVideoJump };
}

function sections(): HTMLElement[] {
	if (!host) throw new Error("panel not mounted");
	return Array.from(host.querySelectorAll("section"));
}

function isOpen(section: HTMLElement, chapter: Chapter): boolean {
	return (section.textContent ?? "").includes(chapter.paragraphs[0]);
}

function titleButton(section: HTMLElement, chapter: Chapter): HTMLButtonElement {
	const found = Array.from(section.querySelectorAll("button")).find(
		(button) => button.textContent === chapter.title,
	);
	if (!found) throw new Error(`title button not found: ${chapter.title}`);
	return found as HTMLButtonElement;
}

function chevronButton(section: HTMLElement): HTMLButtonElement {
	return section.querySelector(
		'button[aria-label="Toggle chapter"]',
	) as HTMLButtonElement | null as HTMLButtonElement;
}

function playButton(section: HTMLElement): HTMLButtonElement {
	return section.querySelector(
		'button[aria-label^="Play from chapter"]',
	) as HTMLButtonElement | null as HTMLButtonElement;
}

function click(element: Element) {
	act(() => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
}

describe("RefinedTranscriptPanel chapter blocks", () => {
	it("opens exactly the first chapter on first render", () => {
		mount(CHAPTERS);
		const secs = sections();
		expect(secs).toHaveLength(3);
		expect(isOpen(secs[0], CHAPTERS[0])).toBe(true);
		expect(isOpen(secs[1], CHAPTERS[1])).toBe(false);
		expect(isOpen(secs[2], CHAPTERS[2])).toBe(false);
	});

	it("still opens only the first chapter when the transcript arrives late", () => {
		const { paint } = mount(undefined);
		expect(sections()).toHaveLength(0); // empty state first
		paint(CHAPTERS);
		const secs = sections();
		expect(isOpen(secs[0], CHAPTERS[0])).toBe(true);
		expect(isOpen(secs[1], CHAPTERS[1])).toBe(false);
		expect(isOpen(secs[2], CHAPTERS[2])).toBe(false);
	});

	it("toggles a block open and closed when its title is clicked", () => {
		mount(CHAPTERS);
		const secs = sections();
		const title = titleButton(secs[0], CHAPTERS[0]);
		expect(title.getAttribute("aria-expanded")).toBe("true");

		click(title); // open -> closed
		expect(isOpen(secs[0], CHAPTERS[0])).toBe(false);
		expect(title.getAttribute("aria-expanded")).toBe("false");

		click(title); // closed -> open again
		expect(isOpen(secs[0], CHAPTERS[0])).toBe(true);
		expect(title.getAttribute("aria-expanded")).toBe("true");
	});

	it("closing then opening another block keeps only one open (accordion)", () => {
		mount(CHAPTERS);
		const secs = sections();
		click(titleButton(secs[1], CHAPTERS[1])); // open chapter two
		expect(isOpen(secs[1], CHAPTERS[1])).toBe(true);
		expect(isOpen(secs[0], CHAPTERS[0])).toBe(false);
		expect(
			secs.filter((section, i) => isOpen(section, CHAPTERS[i])).length,
		).toBe(1);

		click(chevronButton(secs[2])); // chevron opens chapter three
		expect(isOpen(secs[2], CHAPTERS[2])).toBe(true);
		expect(isOpen(secs[1], CHAPTERS[1])).toBe(false);
	});

	it("clicking the block body, its timestamp or its title never seeks", () => {
		const { onVideoJump } = mount(CHAPTERS);
		const secs = sections();

		const body = secs[0].querySelector("p"); // body of the open first block
		expect(body).not.toBeNull();
		click(body as Element);

		click(secs[0]); // the block itself
		click(secs[0].querySelector("span") as Element); // timestamp chip
		click(titleButton(secs[1], CHAPTERS[1])); // a title

		expect(onVideoJump).not.toHaveBeenCalled();
	});

	it("seeks with the chapter start time only from the play button", () => {
		const { onVideoJump } = mount(CHAPTERS);
		const secs = sections();

		click(playButton(secs[2]));
		expect(onVideoJump).toHaveBeenCalledTimes(1);
		expect(onVideoJump).toHaveBeenCalledWith(60);
	});

	it("renders a chevron on every chapter row", () => {
		mount(CHAPTERS);
		for (const section of sections()) {
			const chevron = chevronButton(section);
			expect(chevron).toBeTruthy();
			const svg = chevron.querySelector("svg");
			expect(svg).not.toBeNull();
			const polyline = chevron.querySelector("svg polyline");
			expect(polyline?.getAttribute("points")).toBe("6 9 12 15 18 9");
			// fixed hit box + overflow visible so it can never be clipped away
			expect(chevron.className).toContain("size-5");
			expect(svg?.style.overflow).toBe("visible");
			expect(chevron.getAttribute("aria-expanded")).not.toBeNull();
		}
	});
});
