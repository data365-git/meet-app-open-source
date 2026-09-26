// @vitest-environment jsdom
//
// Transient AI-provider failures (owner order 2026-09-25: "yolg'on va bugsiz,
// hech qachon quruq xato"; live evidence: ccgg9nqjwmw8ehy, Gemini 503). A
// generation that dies on a temporary provider error (503/overloaded/timeout)
// must (a) classify as TRANSIENT - never BUDGET/QUOTA/OTHER, (b) render the
// honest "retrying automatically (n/3)" / "retries used up - press Retry"
// sentences, and (c) be re-kicked by the recovery cron on a bounded ladder
// that books its attempt BEFORE the launch. Each assertion must go RED when
// its mapping is removed (mutation-checked in the GLM report).
import type { Video } from "@cap/web-domain";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The panel under jsdom: translations and the design-system dropdown are
// passthroughs so the MESSAGE KEY (and its JSON'd values) is assertable.
vi.mock("next-intl", () => ({
	useTranslations:
		() =>
		(key: string, values?: Record<string, string>) =>
			values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock("@cap/ui", () => {
	const passthrough =
		(tag: string) =>
		({ children }: { children?: unknown }) =>
			createElement(tag, null, children as never);
	return {
		DropdownMenu: passthrough("div"),
		DropdownMenuContent: passthrough("div"),
		DropdownMenuItem: passthrough("div"),
		DropdownMenuTrigger: passthrough("div"),
	};
});

import { GenerateAiPanel } from "@/app/s/[videoId]/_components/GenerateAiPanel";
import {
	aiGenerationErrorKindForPage,
	classifyAiGenerationError,
} from "@/app/s/[videoId]/_components/transcription-error-message";

// --- Classifier: the TRANSIENT kind, ONE pattern, no second copy -----------

describe("classifyAiGenerationError - TRANSIENT (503 / overloaded)", () => {
	it("the SANITIZED 503 shape (what the DB actually stores) is TRANSIENT", () => {
		// sanitizeAiErrorMessageForUi keeps the prefix up to "(HTTP 503)" and
		// strips the body - the stored text is exactly this shape.
		expect(
			classifyAiGenerationError("Gemini generateContent failed (HTTP 503)"),
		).toBe("TRANSIENT");
	});

	it("the RAW 503/overloaded message is TRANSIENT", () => {
		expect(
			classifyAiGenerationError(
				"Gemini generateContent failed (HTTP 503): The model is overloaded. Please try again later.",
			),
		).toBe("TRANSIENT");
	});

	it("body-only evidence 'overloaded' (no HTTP marker) is TRANSIENT", () => {
		expect(classifyAiGenerationError("The model is overloaded")).toBe(
			"TRANSIENT",
		);
	});

	it("budget stays BUDGET, quota 429 stays QUOTA (order: BUDGET, QUOTA, TRANSIENT)", () => {
		expect(classifyAiGenerationError("AI budget exceeded")).toBe("BUDGET");
		// A 429 is quota-like FIRST - its fix is a top-up, not patience.
		expect(classifyAiGenerationError("429 RESOURCE_EXHAUSTED: quota")).toBe(
			"QUOTA",
		);
		expect(
			classifyAiGenerationError(
				'OpenRouter completion failed (HTTP 402): {"error":{"message":"insufficient credits"}}',
			),
		).toBe("QUOTA");
	});

	it("OTHER is unchanged: permanent errors and a project-number '500' trap", () => {
		expect(classifyAiGenerationError("Invalid audio format")).toBe("OTHER");
		expect(classifyAiGenerationError(null)).toBe("OTHER");
		// Word boundaries (round-16 #3): a project number contains "500" but a
		// permanent 403 must not become transient.
		expect(
			classifyAiGenerationError(
				"Gemini upload init failed (HTTP 403): Permission denied on project 763029500123",
			),
		).toBe("OTHER");
	});
});

// --- Panel: the honest transient sentences ---------------------------------

const VIDEO_ID = "vid_1" as Video.VideoId;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
	true;

type PanelProps = Parameters<typeof GenerateAiPanel>[0];

function renderPanel(props: Partial<PanelProps>) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			createElement(GenerateAiPanel, {
				videoId: VIDEO_ID,
				canGenerate: true,
				duration: 600,
				...props,
			} as PanelProps),
		);
	});
	const text = container.textContent ?? "";
	act(() => root.unmount());
	container.remove();
	return text;
}

const transientError = {
	transcriptionStatus: "COMPLETE" as const,
	aiGenerationStatus: "ERROR" as const,
	aiGenerationErrorCode: "TRANSIENT" as const,
};

describe("GenerateAiPanel - TRANSIENT rendering", () => {
	it("attempts remaining: owner sees 'retrying automatically (n/3)' with the real n - never the bare failure", () => {
		const text = renderPanel({
			...transientError,
			aiTransientRetryAttempts: 1,
		});
		expect(text).toContain("aiSummaryTransientRetrying");
		expect(text).toContain('"n":"2"');
		expect(text).not.toContain("aiAnalysisFailed");
		expect(text).not.toContain("aiSummaryTransientExhausted");
	});

	it("first failure (attempts=0, shows 1/3) still promises the automatic retry", () => {
		const text = renderPanel({
			...transientError,
			aiTransientRetryAttempts: 0,
		});
		expect(text).toContain("aiSummaryTransientRetrying");
		expect(text).toContain('"n":"1"');
	});

	it("ladder spent (attempts = 3): owner is told the retries are used up and pointed at Retry", () => {
		const text = renderPanel({
			...transientError,
			aiTransientRetryAttempts: 3,
		});
		expect(text).toContain("aiSummaryTransientExhausted");
		expect(text).not.toContain("aiSummaryTransientRetrying");
		expect(text).not.toContain("aiAnalysisFailed");
	});

	it("public viewer: retrying sentence WITHOUT the attempt counter", () => {
		const text = renderPanel({
			...transientError,
			aiTransientRetryAttempts: 1,
			canGenerate: false,
		});
		expect(text).toContain("aiSummaryTransientRetryingPublic");
		expect(text).not.toContain('"n"');
	});

	it("public viewer: exhausted sentence WITHOUT the button instruction", () => {
		const text = renderPanel({
			...transientError,
			aiTransientRetryAttempts: 3,
			canGenerate: false,
		});
		expect(text).toContain("aiSummaryTransientExhaustedPublic");
		expect(text).not.toContain("aiSummaryTransientRetrying");
	});
});

// --- Cron: the bounded transient re-kick pass -------------------------------

const state = vi.hoisted(() => ({
	selectResults: [] as unknown[][],
	selectCall: 0,
	/** where() arguments of every SELECT, stringified for fragment checks. */
	whereArgs: [] as string[],
	/** Raw template strings of every sql fragment - a literal `?` in one is
	 * bound as a placeholder by mysql2 (blind review 2026-09-26, finding 1). */
	rawStrings: [] as string[],
	/** affectedRows the transient compare-and-set booking reports. */
	bookingAffected: 1,
}));

const updateSetMock = vi.hoisted(() =>
	vi.fn((_arg: Record<string, unknown>) => ({
		where: () => Promise.resolve([{ affectedRows: state.bookingAffected }]),
	})),
);
const startAiGenerationMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true })),
);
const transcribeVideoMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true })),
);

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => {
				const builder = {
					leftJoin: () => builder,
					where: (...args: unknown[]) => {
						// Serialize drizzle sql fragments (strings.join("?")) and the
						// eq/isNull/or shapes, so WHERE-clause content is assertable.
						for (const arg of args) {
							if (
								typeof arg === "object" &&
								arg !== null &&
								"strings" in (arg as Record<string, unknown>)
							) {
								const frag = arg as {
									strings: TemplateStringsArray;
									values?: unknown[];
								};
								state.rawStrings.push(...frag.strings);
								state.whereArgs.push(
									`${frag.strings.join("?")} ${JSON.stringify(frag.values ?? [])}`,
								);
							} else {
								state.whereArgs.push(JSON.stringify(arg));
							}
						}
						const result = state.selectResults[state.selectCall++] ?? [];
						const promise = Promise.resolve(result) as Promise<unknown[]> & {
							limit: () => Promise<unknown[]>;
							orderBy: () => unknown;
						};
						promise.limit = () => Promise.resolve(result);
						promise.orderBy = () => promise;
						return promise;
					},
				};
				return builder;
			},
		}),
		update: () => ({ set: updateSetMock }),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		name: "videos.name",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		deletedAt: "videos.deletedAt",
		updatedAt: "videos.updatedAt",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		updatedAt: "videoUploads.updatedAt",
		rawFileKey: "videoUploads.rawFileKey",
		mode: "videoUploads.mode",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	like: vi.fn((field: unknown, pattern: unknown) => ({ like: field, pattern })),
	or: vi.fn((...args: unknown[]) => ({ or: args })),
	lte: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	sql: Object.assign(
		vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
			strings,
			values,
		})),
		{ raw: vi.fn((s: string) => s) },
	),
}));

vi.mock("next/server", () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));

vi.mock("@/lib/ops-alert", () => ({
	sendOpsAlert: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: startAiGenerationMock,
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(() => Promise.resolve("started")),
}));
vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: vi.fn(),
}));

const { GET } = await import("@/app/api/cron/recover-stale-ai-jobs/route");

const CRON_SECRET = "test-cron-secret";

function cronRequest(): Request {
	return {
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "authorization"
					? `Bearer ${CRON_SECRET}`
					: null,
		},
	} as unknown as Request;
}

const THIRTY_MIN_AGO = () =>
	new Date(Date.now() - 30 * 60 * 1000).toISOString();

function transientRow(metadata: Record<string, unknown>) {
	return {
		id: "vid-transient-1",
		ownerId: "owner-1",
		name: "503 victim",
		metadata,
	};
}

describe("recover-stale-ai-jobs - transient generation re-kick", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectResults = [];
		state.selectCall = 0;
		state.whereArgs = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	// Query order in the route: 0 stale transcription, 1 quota-blocked,
	// 2 stale aiGeneration, 3 pending request, 4 refinement, 5 stale upload,
	// 6 transient generation ERROR rows.
	function armTransient(rows: unknown[]) {
		state.selectResults = [[], [], [], [], [], [], rows];
	}

	it("books the attempt BEFORE startAiGeneration, kicks as a retry, and counts it", async () => {
		armTransient([
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "Gemini generateContent failed (HTTP 503)",
				aiGenerationErrorTransient: true,
				aiTransientRetryAttempts: 1,
				aiTransientRetryAt: THIRTY_MIN_AGO(),
			}),
		]);

		const res = await GET(cronRequest());
		const body = (await res.json()) as Record<string, unknown>;

		expect(startAiGenerationMock).toHaveBeenCalledTimes(1);
		expect(startAiGenerationMock).toHaveBeenCalledWith(
			"vid-transient-1",
			"owner-1",
			{ force: true, isRetry: true },
		);
		const bookedIndex = updateSetMock.mock.calls.findIndex(
			([arg]) =>
				(arg as { metadata?: { aiTransientRetryAttempts?: number } })
					?.metadata?.aiTransientRetryAttempts === 2,
		);
		expect(bookedIndex).toBeGreaterThanOrEqual(0);
		// The booking lands BEFORE the launch, so a run that keeps dying on
		// 503s is bounded even if startAiGeneration never returns.
		expect(
			updateSetMock.mock.invocationCallOrder[bookedIndex ?? -1],
		).toBeLessThan(
			startAiGenerationMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
		expect(body.transientRetried).toBe(1);
	});

	it("NEVER re-kicks a spent ladder (attempts >= 3)", async () => {
		armTransient([
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "Gemini generateContent failed (HTTP 503)",
				aiGenerationErrorTransient: true,
				aiTransientRetryAttempts: 3,
				aiTransientRetryAt: THIRTY_MIN_AGO(),
			}),
		]);

		const res = await GET(cronRequest());
		const body = (await res.json()) as Record<string, unknown>;

		expect(startAiGenerationMock).not.toHaveBeenCalled();
		expect(body.transientRetried).toBe(0);
	});

	it("NEVER re-kicks a non-transient death (budget / empty result / invalid input)", async () => {
		armTransient([
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "AI budget exceeded",
			}),
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "AI generation returned no usable content",
			}),
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "Invalid audio format",
			}),
		]);

		await GET(cronRequest());

		expect(startAiGenerationMock).not.toHaveBeenCalled();
	});

	it("the WHERE clause carries the cap, the flag arm, the transient words and the 25-min gap", async () => {
		armTransient([]);

		await GET(cronRequest());

		const sqlText = state.whereArgs.join(" ");
		// Bounded ladder in SQL, not only in JS (the "<" cap with the bound
		// MAX_TRANSIENT_RETRY_ATTEMPTS = 3). The mock serializes the drizzle
		// sql fragments nested inside and()/or() as JSON, so the values array
		// appears literally; ["videos.metadata",3] is unique to this cap
		// (quota binds 12, rowless binds 2).
		expect(sqlText).toContain("$.aiTransientRetryAttempts");
		expect(sqlText).toContain("), 0) < ");
		expect(sqlText).toContain('],"values":["videos.metadata",3]');
		// The durable flag is the ONLY arm: no SQL word-match fallback that
		// would silently re-kick old failures on paid AI (blind review
		// 2026-09-26, finding 2).
		expect(sqlText).toContain("$.aiGenerationErrorTransient')) = 'true'");
		expect(sqlText).not.toContain("REGEXP_LIKE");
		// Minimum gap between attempts.
		expect(sqlText).toContain("$.aiTransientRetryAt");
	});

	it("no sql fragment carries a literal '?' (mysql2 would bind a value into it and the whole cron would 500)", async () => {
		armTransient([]);

		await GET(cronRequest());

		const withMark = state.rawStrings.filter((s) => s.includes("?"));
		expect(withMark).toEqual([]);
	});

	it("an UNFLAGGED transient-looking row (pre-flag history) is never re-kicked", async () => {
		armTransient([
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "Gemini generateContent failed (HTTP 503)",
			}),
		]);

		await GET(cronRequest());

		expect(startAiGenerationMock).not.toHaveBeenCalled();
	});

	it("compare-and-set: when the booking matches 0 rows (owner pressed Retry / overlapping cron), nothing is kicked", async () => {
		state.bookingAffected = 0;
		armTransient([
			transientRow({
				aiGenerationStatus: "ERROR",
				aiGenerationError: "Gemini generateContent failed (HTTP 503)",
				aiGenerationErrorTransient: true,
				aiTransientRetryAttempts: 1,
				aiTransientRetryAt: THIRTY_MIN_AGO(),
			}),
		]);

		const res = await GET(cronRequest());
		const body = (await res.json()) as Record<string, unknown>;
		state.bookingAffected = 1;

		expect(startAiGenerationMock).not.toHaveBeenCalled();
		expect(body.transientRetried).toBe(0);
	});
});

describe("aiGenerationErrorKindForPage - 'retrying' is promised only when the cron will retry", () => {
	it("flag set -> TRANSIENT, even when the stored text lost the evidence", () => {
		expect(
			aiGenerationErrorKindForPage({
				aiGenerationError: "Gemini generateContent failed (HTTP 502)",
				aiGenerationErrorTransient: true,
			}),
		).toBe("TRANSIENT");
	});

	it("unflagged 503 text -> OTHER (the cron never retries it, so no promise)", () => {
		expect(
			aiGenerationErrorKindForPage({
				aiGenerationError: "Gemini generateContent failed (HTTP 503)",
			}),
		).toBe("OTHER");
	});

	it("BUDGET and QUOTA keep their own truths", () => {
		expect(
			aiGenerationErrorKindForPage({ aiGenerationError: "AI budget exceeded" }),
		).toBe("BUDGET");
		expect(
			aiGenerationErrorKindForPage({
				aiGenerationError: "429 RESOURCE_EXHAUSTED: quota",
			}),
		).toBe("QUOTA");
	});
});
