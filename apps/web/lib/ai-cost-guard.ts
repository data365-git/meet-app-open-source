import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type AiOperation,
	aiUsageEvents,
	organizations,
	users,
} from "@cap/database/schema";
import { priceForMicros } from "@cap/utils";
import { Organisation, User, type Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";

export class BudgetExceededError extends Error {
	constructor(
		public scope: "user" | "org" | "video",
		public currentMicros: number,
		public capMicros: number,
	) {
		super(
			`AI budget exceeded for ${scope}: ${currentMicros} / ${capMicros} microdollars`,
		);
		this.name = "BudgetExceededError";
	}
}

// Default monthly AI spend cap (microdollars) applied ONLY when neither the
// user nor the org has configured an explicit budget. The upstream value was
// $1 — a SaaS free-tier guard that is wrong for a self-hosted instance whose
// owner brings their own Gemini key and pays their own bill: a single active
// day of recording/transcribing exhausts $1 and then silently blocks ALL AI
// (transcription + summary) with BudgetExceededError. Default to a generous
// runaway-loop backstop instead; owners who want a tighter cap can set a
// per-org/user budget in settings (org.settings.aiBudget / user prefs).
const DEFAULT_AI_BUDGET_CAP_MICROS = 100_000_000; // $100 / month
const DEFAULT_AI_VIDEO_BUDGET_CAP_MICROS = 20_000_000; // $20 / video

export function hasBudgetBeenReached({
	currentMicros,
	capMicros,
}: {
	currentMicros: number;
	capMicros: number | null;
}): boolean {
	return capMicros != null && capMicros > 0 && currentMicros >= capMicros;
}

export function previousSpendBeforeRecordedEvent({
	currentSpendMicros,
	eventCostMicros,
}: {
	currentSpendMicros: number;
	eventCostMicros: number;
}): number {
	return Math.max(0, currentSpendMicros - eventCostMicros);
}

function currentBillingMonth(): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

// Exported (2026-09-25, honest-AI-status): the generate route reports the
// monthly-cap numbers with its 402 refusal — one spend query, one definition.
export { currentBillingMonth };

export async function getMonthlySpendMicros(
	column: "orgId" | "userId",
	id: string,
	billingMonth: string,
): Promise<number> {
	const idCondition =
		column === "orgId"
			? eq(aiUsageEvents.orgId, Organisation.OrganisationId.make(id))
			: eq(aiUsageEvents.userId, User.UserId.make(id));

	const [result] = await db()
		.select({
			total: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
		})
		.from(aiUsageEvents)
		.where(and(idCondition, eq(aiUsageEvents.billingMonth, billingMonth)));

	return Number(result?.total ?? 0);
}

async function getVideoSpendMicros(videoId: string): Promise<number> {
	const [result] = await db()
		.select({
			total: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
		})
		.from(aiUsageEvents)
		.where(eq(aiUsageEvents.videoId, videoId as Video.VideoId));

	return Number(result?.total ?? 0);
}

type AiBudgetSettings = {
	monthlyUsdCents: number;
	alertAtPct: number;
	enabled: boolean;
};

function budgetToMicros(budget?: AiBudgetSettings | null): number | null {
	if (!budget?.enabled || budget.monthlyUsdCents <= 0) return null;
	return budget.monthlyUsdCents * 10_000;
}

export async function getAiBudgetCapsMicros({
	orgId,
	userId,
}: {
	orgId: string;
	userId: string;
}): Promise<{
	budgetCapUserMicros: number | null;
	budgetCapOrgMicros: number | null;
}> {
	const [[user], [org]] = await Promise.all([
		db()
			.select({ preferences: users.preferences })
			.from(users)
			.where(eq(users.id, User.UserId.make(userId)))
			.limit(1),
		db()
			.select({ settings: organizations.settings })
			.from(organizations)
			.where(eq(organizations.id, Organisation.OrganisationId.make(orgId)))
			.limit(1),
	]);

	return {
		budgetCapUserMicros: budgetToMicros(user?.preferences?.aiBudget),
		budgetCapOrgMicros: budgetToMicros(org?.settings?.aiBudget),
	};
}

export async function assertAiBudgetAvailable({
	orgId,
	userId,
	videoId,
}: {
	orgId: string;
	userId: string;
	videoId?: string;
}): Promise<void> {
	const billingMonth = currentBillingMonth();
	const { budgetCapUserMicros, budgetCapOrgMicros } =
		await getAiBudgetCapsMicros({ orgId, userId });
	const effectiveBudgetCapOrgMicros =
		budgetCapUserMicros == null && budgetCapOrgMicros == null
			? DEFAULT_AI_BUDGET_CAP_MICROS
			: budgetCapOrgMicros;

	if (budgetCapUserMicros != null && budgetCapUserMicros > 0) {
		const userSpend = await getMonthlySpendMicros(
			"userId",
			userId,
			billingMonth,
		);
		if (
			hasBudgetBeenReached({
				currentMicros: userSpend,
				capMicros: budgetCapUserMicros,
			})
		) {
			throw new BudgetExceededError("user", userSpend, budgetCapUserMicros);
		}
	}

	if (effectiveBudgetCapOrgMicros != null && effectiveBudgetCapOrgMicros > 0) {
		const orgSpend = await getMonthlySpendMicros("orgId", orgId, billingMonth);
		if (
			hasBudgetBeenReached({
				currentMicros: orgSpend,
				capMicros: effectiveBudgetCapOrgMicros,
			})
		) {
			throw new BudgetExceededError(
				"org",
				orgSpend,
				effectiveBudgetCapOrgMicros,
			);
		}
	}

	if (videoId) {
		const videoSpend = await getVideoSpendMicros(videoId);
		if (
			hasBudgetBeenReached({
				currentMicros: videoSpend,
				capMicros: DEFAULT_AI_VIDEO_BUDGET_CAP_MICROS,
			})
		) {
			throw new BudgetExceededError(
				"video",
				videoSpend,
				DEFAULT_AI_VIDEO_BUDGET_CAP_MICROS,
			);
		}
	}
}

interface CostGuardOptions<T> {
	orgId: string;
	userId: string;
	videoId?: string;
	operation: AiOperation;
	model: string;
	budgetCapUserMicros?: number | null;
	budgetCapOrgMicros?: number | null;
	recordUsageBestEffort?: boolean;
	batch?: boolean;
	/** Free-tier call (billing-off key): record the usage but at $0 cost. */
	free?: boolean;
	fn: () => Promise<
		T & {
			inputTokens: number;
			outputTokens: number;
			audioInTokens?: number;
			/** The model that ACTUALLY produced this result, when the caller's fn
			 * can fall back to a different model than `options.model` requested
			 * (e.g. transcribeWithGemini's overload fallback chain). When present,
			 * this — not options.model — is what gets priced and recorded, so
			 * spend is never attributed to a model that wasn't actually billed. */
			modelUsed?: string;
			/** The provider's OWN charge for the call, in microdollars. Present
			 * only for providers that return a real price (OpenRouter's
			 * `usage.cost`); when present it REPLACES the token-pricing table,
			 * because a vendor's invoice beats our estimate of it. Absent (the
			 * Gemini paths) keeps today's behaviour exactly. A `free: true` call
			 * still records $0 — free outranks any reported cost. */
			costUsdMicros?: number;
		}
	>;
}

export async function withCostGuard<T>(
	options: CostGuardOptions<T>,
): Promise<
	T & { inputTokens: number; outputTokens: number; audioInTokens?: number }
> {
	const billingMonth = currentBillingMonth();
	const configuredCaps = await getAiBudgetCapsMicros({
		orgId: options.orgId,
		userId: options.userId,
	});
	const budgetCapUserMicros =
		options.budgetCapUserMicros ?? configuredCaps.budgetCapUserMicros;
	const configuredBudgetCapOrgMicros =
		options.budgetCapOrgMicros ?? configuredCaps.budgetCapOrgMicros;
	const budgetCapOrgMicros =
		budgetCapUserMicros == null && configuredBudgetCapOrgMicros == null
			? DEFAULT_AI_BUDGET_CAP_MICROS
			: configuredBudgetCapOrgMicros;

	if (budgetCapUserMicros != null && budgetCapUserMicros > 0) {
		const userSpend = await getMonthlySpendMicros(
			"userId",
			options.userId,
			billingMonth,
		);
		if (
			hasBudgetBeenReached({
				currentMicros: userSpend,
				capMicros: budgetCapUserMicros,
			})
		) {
			throw new BudgetExceededError("user", userSpend, budgetCapUserMicros);
		}
	}

	if (budgetCapOrgMicros != null && budgetCapOrgMicros > 0) {
		const orgSpend = await getMonthlySpendMicros(
			"orgId",
			options.orgId,
			billingMonth,
		);
		if (
			hasBudgetBeenReached({
				currentMicros: orgSpend,
				capMicros: budgetCapOrgMicros,
			})
		) {
			throw new BudgetExceededError("org", orgSpend, budgetCapOrgMicros);
		}
	}

	if (options.videoId) {
		const videoSpend = await getVideoSpendMicros(options.videoId);
		if (
			hasBudgetBeenReached({
				currentMicros: videoSpend,
				capMicros: DEFAULT_AI_VIDEO_BUDGET_CAP_MICROS,
			})
		) {
			throw new BudgetExceededError(
				"video",
				videoSpend,
				DEFAULT_AI_VIDEO_BUDGET_CAP_MICROS,
			);
		}
	}

	const result = await options.fn();

	// The model that actually produced this result (e.g. after an overload
	// fallback chain inside fn) takes priority over the requested model — both
	// for pricing and for what gets recorded, so spend is never attributed to a
	// model that wasn't the one actually billed.
	const billedModel = result.modelUsed ?? options.model;

	const rawAudioInTokens = result.audioInTokens ?? 0;
	// Transcription input is essentially all audio; when the caller couldn't
	// determine an audio split (e.g. Gemini omitted promptTokensDetails), don't
	// silently bill the dominant cost at the cheaper text rate. Summary/refine
	// are genuinely text, so this only applies to transcription.
	const audioInTokens =
		options.operation === "transcription" &&
		rawAudioInTokens === 0 &&
		result.inputTokens > 0
			? result.inputTokens
			: rawAudioInTokens;
	// A provider-reported charge (OpenRouter's `usage.cost`) is the truth for
	// this event and outranks the pricing table — the table exists to ESTIMATE
	// a bill we cannot see. Anything that is not a usable POSITIVE number falls
	// through to the table rather than silently recording $0.
	//
	// ZERO is excluded deliberately (round-18 #5), the same rule as
	// costUsdToMicros: a PAID call reporting exactly $0 is a reporting failure,
	// not a price, and accepting it froze monthly/per-video spend at 0 so the
	// $100/month and $20/video backstops could never trip. The genuinely-free
	// Google path is unaffected — it records $0 via `options.free` below, which
	// is checked first and never consults this value.
	const reportedCostMicros =
		typeof result.costUsdMicros === "number" &&
		Number.isFinite(result.costUsdMicros) &&
		result.costUsdMicros > 0
			? Math.round(result.costUsdMicros)
			: undefined;
	const costUsdMicros = options.free
		? 0
		: (reportedCostMicros ??
			priceForMicros(billedModel, {
				textInTokens: Math.max(0, result.inputTokens - audioInTokens),
				audioInTokens,
				outputTokens: result.outputTokens,
				batch: options.batch,
			}));

	try {
		await db()
			.insert(aiUsageEvents)
			.values({
				id: nanoId(),
				orgId: options.orgId as Organisation.OrganisationId,
				userId: options.userId as User.UserId,
				videoId: (options.videoId as Video.VideoId) ?? null,
				operation: options.operation,
				model: billedModel,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				costUsdMicros,
				billingMonth,
			});

		// Check budget thresholds and create alerts
		if (budgetCapUserMicros != null && budgetCapUserMicros > 0) {
			const currentSpend = await getMonthlySpendMicros(
				"userId",
				options.userId,
				billingMonth,
			);
			const prevSpend = previousSpendBeforeRecordedEvent({
				currentSpendMicros: currentSpend,
				eventCostMicros: costUsdMicros,
			});
			const newSpend = currentSpend;

			const prevPct = (prevSpend / budgetCapUserMicros) * 100;
			const newPct = (newSpend / budgetCapUserMicros) * 100;

			// 100% threshold crossed
			if (prevPct < 100 && newPct >= 100) {
				const amountFormatted = (newSpend / 1_000_000).toFixed(2);
				const budgetFormatted = (budgetCapUserMicros / 1_000_000).toFixed(2);
				console.log(
					`[BUDGET_ALERT] User ${options.userId}: AI budget exceeded — new AI operations blocked until next month or budget raise ($${amountFormatted} of $${budgetFormatted})`,
				);
			}
			// 80% threshold crossed
			else if (prevPct < 80 && newPct >= 80) {
				const amountFormatted = (newSpend / 1_000_000).toFixed(2);
				const budgetFormatted = (budgetCapUserMicros / 1_000_000).toFixed(2);
				console.log(
					`[BUDGET_ALERT] User ${options.userId}: AI spend at 80% of monthly budget ($${amountFormatted} of $${budgetFormatted})`,
				);
			}
		}

		if (budgetCapOrgMicros != null && budgetCapOrgMicros > 0) {
			const currentSpend = await getMonthlySpendMicros(
				"orgId",
				options.orgId,
				billingMonth,
			);
			const prevSpend = previousSpendBeforeRecordedEvent({
				currentSpendMicros: currentSpend,
				eventCostMicros: costUsdMicros,
			});
			const newSpend = currentSpend;

			const prevPct = (prevSpend / budgetCapOrgMicros) * 100;
			const newPct = (newSpend / budgetCapOrgMicros) * 100;

			// 100% threshold crossed
			if (prevPct < 100 && newPct >= 100) {
				const amountFormatted = (newSpend / 1_000_000).toFixed(2);
				const budgetFormatted = (budgetCapOrgMicros / 1_000_000).toFixed(2);
				console.log(
					`[BUDGET_ALERT] Org ${options.orgId}: AI budget exceeded — new AI operations blocked until next month or budget raise ($${amountFormatted} of $${budgetFormatted})`,
				);
			}
			// 80% threshold crossed
			else if (prevPct < 80 && newPct >= 80) {
				const amountFormatted = (newSpend / 1_000_000).toFixed(2);
				const budgetFormatted = (budgetCapOrgMicros / 1_000_000).toFixed(2);
				console.log(
					`[BUDGET_ALERT] Org ${options.orgId}: AI spend at 80% of monthly budget ($${amountFormatted} of $${budgetFormatted})`,
				);
			}
		}
	} catch (error) {
		if (!options.recordUsageBestEffort) {
			throw error;
		}
		console.error("[ai-cost-guard] Failed to record AI usage:", error);
	}

	return result;
}
