// @vitest-environment jsdom
/**
 * Outcome tests for the refined-transcript chapter blocks
 * (app/s/[videoId]/_components/panels/RefinedTranscriptPanel.tsx).
 *
 * These drive the rendered component the way a user does — clicking the
 * title, the body and the play button — and assert what is on screen
 * afterwards (paragraphs visible? player seeked?), not which handler exists.
 */
import { NextIntlClientProvider } from "next-intl";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefinedTranscriptPanel } from "@/app/s/[videoId]/_components/panels/RefinedTranscriptPanel";

interface Chapter {
	startSec: number;
	title: string;
	paragraphs: string[];
}

/**
 * Narrowing helpers that THROW instead of asserting non-null.
 *
 * A DOM lookup that quietly yields undefined and then flows into `expect`
 * turns a real failure into a passing test — a `!` or an `as` here would buy
 * a green typecheck by removing the only signal that the panel stopped
 * rendering something. These fail loudly and name what was missing.
 */
function must<T>(value: T | null | undefined, label: string): T {
	if (value === null || value === undefined) {
		throw new Error("expected " + label + " to exist");
	}
	return value;
}

function at<T>(items: readonly T[], index: number, label: string): T {
	return must(items[index], label + " at index " + String(index));
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
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	// jsdom has no layout: neutralise the panel's follow-scroll target.
	Element.prototype.scrollTo = () => {};
});

afterEach(() => {
	const mounted = root;
	if (mounted) {
		act(() => mounted.unmount());
		root = null;
	}
	host?.remove();
	host = null;
});

function mount(
	chapters: Chapter[] | undefined,
	onVideoJump = vi.fn<(seconds: number) => void>(),
) {
	const container = document.createElement("div");
	host = container;
	document.body.appendChild(container);
	const mounted = createRoot(container);
	root = mounted;
	const paint = (next: Chapter[] | undefined) => {
		act(() => {
			mounted.render(
				createElement(NextIntlClientProvider, {
					locale: "en",
					messages,
					children: createElement(RefinedTranscriptPanel, {
						refinedTranscript: next ? { chapters: next } : undefined,
						onVideoJump,
						duration: 300,
						currentTime: 0,
						videoTitle: "Recording",
					}),
				}),
			);
		});
	};
	paint(chapters);
	return { paint, onVideoJump };
}

function sections(): HTMLElement[] {
	return Array.from(must(host, "mounted panel").querySelectorAll("section"));
}

function isOpen(section: HTMLElement, chapter: Chapter): boolean {
	const firstParagraph = at(chapter.paragraphs, 0, "chapter paragraph");
	return (section.textContent ?? "").includes(firstParagraph);
}

function titleButton(
	section: HTMLElement,
	chapter: Chapter,
): HTMLButtonElement {
	const found = Array.from(section.querySelectorAll("button")).find(
		(button) => button.textContent === chapter.title,
	);
	return must(found, "title button " + chapter.title);
}

function chevronButton(section: HTMLElement): HTMLButtonElement {
	return must(
		section.querySelector<HTMLButtonElement>(
			'button[aria-label="Toggle chapter"]',
		),
		"chevron button",
	);
}

function playButton(section: HTMLElement): HTMLButtonElement {
	return must(
		section.querySelector<HTMLButtonElement>(
			'button[aria-label^="Play from chapter"]',
		),
		"play button",
	);
}

function click(element: Element) {
	act(() => {
		element.dispatchEvent(
			new MouseEvent("click", { bubbles: true, cancelable: true }),
		);
	});
}

/** Section plus its chapter, so the two never drift apart at a call site. */
function block(secs: HTMLElement[], index: number) {
	return {
		section: at(secs, index, "section"),
		chapter: at(CHAPTERS, index, "chapter"),
	};
}

describe("RefinedTranscriptPanel chapter blocks", () => {
	it("opens exactly the first chapter on first render", () => {
		mount(CHAPTERS);
		const secs = sections();
		expect(secs).toHaveLength(3);
		const one = block(secs, 0);
		const two = block(secs, 1);
		const three = block(secs, 2);
		expect(isOpen(one.section, one.chapter)).toBe(true);
		expect(isOpen(two.section, two.chapter)).toBe(false);
		expect(isOpen(three.section, three.chapter)).toBe(false);
	});

	it("still opens only the first chapter when the transcript arrives late", () => {
		const { paint } = mount(undefined);
		expect(sections()).toHaveLength(0); // empty state first
		paint(CHAPTERS);
		const secs = sections();
		const one = block(secs, 0);
		const two = block(secs, 1);
		const three = block(secs, 2);
		expect(isOpen(one.section, one.chapter)).toBe(true);
		expect(isOpen(two.section, two.chapter)).toBe(false);
		expect(isOpen(three.section, three.chapter)).toBe(false);
	});

	it("toggles a block open and closed when its title is clicked", () => {
		mount(CHAPTERS);
		const one = block(sections(), 0);
		const title = titleButton(one.section, one.chapter);
		expect(title.getAttribute("aria-expanded")).toBe("true");

		click(title); // open -> closed
		expect(isOpen(one.section, one.chapter)).toBe(false);
		expect(title.getAttribute("aria-expanded")).toBe("false");

		click(title); // closed -> open again
		expect(isOpen(one.section, one.chapter)).toBe(true);
		expect(title.getAttribute("aria-expanded")).toBe("true");
	});

	it("closing then opening another block keeps only one open (accordion)", () => {
		mount(CHAPTERS);
		const secs = sections();
		const one = block(secs, 0);
		const two = block(secs, 1);
		const three = block(secs, 2);

		click(titleButton(two.section, two.chapter)); // open chapter two
		expect(isOpen(two.section, two.chapter)).toBe(true);
		expect(isOpen(one.section, one.chapter)).toBe(false);
		expect(
			secs.filter((section, i) => isOpen(section, at(CHAPTERS, i, "chapter")))
				.length,
		).toBe(1);

		click(chevronButton(three.section)); // chevron opens chapter three
		expect(isOpen(three.section, three.chapter)).toBe(true);
		expect(isOpen(two.section, two.chapter)).toBe(false);
	});

	it("clicking the block body, its timestamp or its title never seeks", () => {
		const { onVideoJump } = mount(CHAPTERS);
		const secs = sections();
		const one = block(secs, 0);
		const two = block(secs, 1);

		const body = one.section.querySelector("p"); // body of the open first block
		expect(body).not.toBeNull();
		click(must(body, "block body paragraph"));

		click(one.section); // the block itself
		click(must(one.section.querySelector("span"), "timestamp chip"));
		click(titleButton(two.section, two.chapter)); // a title

		expect(onVideoJump).not.toHaveBeenCalled();
	});

	it("seeks with the chapter start time only from the play button", () => {
		const { onVideoJump } = mount(CHAPTERS);
		const three = block(sections(), 2);

		click(playButton(three.section));
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
