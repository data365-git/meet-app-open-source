// ── Minimal fake DOM for the extension's page scripts ───────────────────────
//
// vitest.config.ts runs this package in the "node" environment and jsdom is not
// a dependency here, so DOM-driven tests hand-roll their globals — the same way
// offscreen/recorder.test.ts hand-rolls the media globals.
//
// `documentFromHtml` deliberately builds the element set BY PARSING THE REAL
// .html FILE rather than from a hand-written id list. A test that invents its
// own ids would keep passing after the markup lost the element it is asserting
// on; this one goes red, which is the whole point.

class FakeClassList {
	private readonly set = new Set<string>();

	constructor(initial = "") {
		for (const c of initial.split(/\s+/)) if (c) this.set.add(c);
	}

	add(c: string): void {
		this.set.add(c);
	}

	remove(c: string): void {
		this.set.delete(c);
	}

	contains(c: string): boolean {
		return this.set.has(c);
	}

	toggle(c: string, force?: boolean): boolean {
		const on = force === undefined ? !this.set.has(c) : force;
		if (on) this.set.add(c);
		else this.set.delete(c);
		return on;
	}
}

export class FakeText {
	constructor(public data: string) {}
}

export type FakeNode = FakeElement | FakeText;

export class FakeElement {
	readonly id: string;
	readonly classList: FakeClassList;
	readonly tagName: string;
	className = "";
	disabled = false;
	title = "";
	readonly style: Record<string, string> = {};
	readonly dataset: Record<string, string> = {};
	children: FakeNode[] = [];
	private readonly listeners = new Map<string, Array<(e?: unknown) => void>>();

	constructor(id: string, className = "", tagName = "div") {
		this.id = id;
		this.className = className;
		this.tagName = tagName;
		this.classList = new FakeClassList(className);
	}

	/** DOM semantics: reading concatenates descendant text, writing replaces it. */
	get textContent(): string {
		return this.children
			.map((c) => (c instanceof FakeText ? c.data : c.textContent))
			.join("");
	}

	set textContent(value: string) {
		this.children = value === "" ? [] : [new FakeText(value)];
	}

	appendChild(node: FakeNode): FakeNode {
		this.children.push(node);
		return node;
	}

	removeChild(node: FakeNode): FakeNode {
		const i = this.children.indexOf(node);
		if (i >= 0) this.children.splice(i, 1);
		return node;
	}

	get firstChild(): FakeNode | null {
		return this.children[0] ?? null;
	}

	set innerHTML(value: string) {
		if (value !== "") throw new Error("fake innerHTML only supports clearing");
		this.children = [];
	}

	/** Every element in this subtree, self included. */
	descendants(): FakeElement[] {
		const out: FakeElement[] = [this];
		for (const c of this.children) {
			if (c instanceof FakeElement) out.push(...c.descendants());
		}
		return out;
	}

	addEventListener(
		type: string,
		fn: (e?: unknown) => void,
		opts?: { once?: boolean },
	): void {
		const wrapped = opts?.once
			? (e?: unknown) => {
					this.removeEventListener(type, wrapped);
					fn(e);
				}
			: fn;
		const list = this.listeners.get(type) ?? [];
		list.push(wrapped);
		this.listeners.set(type, list);
	}

	removeEventListener(type: string, fn: (e?: unknown) => void): void {
		const list = this.listeners.get(type);
		if (!list) return;
		const i = list.indexOf(fn);
		if (i >= 0) list.splice(i, 1);
	}

	/** Fire the handlers the product code registered — the same path a real click takes. */
	click(): void {
		for (const fn of [...(this.listeners.get("click") ?? [])]) fn();
	}

	get hidden(): boolean {
		return this.classList.contains("hidden");
	}
}

export class FakeDocument {
	title = "";
	readonly elements = new Map<string, FakeElement>();

	getElementById(id: string): FakeElement | null {
		return this.elements.get(id) ?? null;
	}

	createElement(tag: string): FakeElement {
		return new FakeElement("", "", tag);
	}

	createTextNode(data: string): FakeText {
		return new FakeText(data);
	}
}

/**
 * Build a FakeDocument containing exactly the id'd elements the given HTML
 * declares, preserving each one's class attribute (so `hidden` starts correct).
 */
export function documentFromHtml(html: string): FakeDocument {
	const doc = new FakeDocument();
	const tagRe = /<([a-zA-Z][\w-]*)\s([^>]*)>/g;
	for (const [, , attrs] of html.matchAll(tagRe)) {
		const id = /\bid="([^"]*)"/.exec(attrs)?.[1];
		if (!id) continue;
		const className = /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? "";
		doc.elements.set(id, new FakeElement(id, className));
	}
	return doc;
}
