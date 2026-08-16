"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { aiUsageEvents, organizationMembers, organizations, videos } from "@cap/database/schema";
import { priceForMicros } from "@cap/utils";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { Organisation, Video } from "@cap/web-domain";

function currentBillingMonth(): string {
	const now = new Date();
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${year}-${month}`;
}

const emptyResult = {
	totalUsdCents: 0,
	breakdown: {} as Record<string, number>,
	capUsdCents: null as number | null,
	percentUsed: 0,
	freeTierSavingsUsdCents: null as number | null,
};

export async function getMonthlySpend(scope: {
	type: "user" | "org" | "video";
	id: string;
}): Promise<{
	totalUsdCents: number;
	breakdown: Record<string, number>;
	capUsdCents: number | null;
	percentUsed: number;
	/** Video scope only (null for user/org): re-priced value of this video's
	 * $0 free-tier AI usage events, "how much this WOULD have cost at paid
	 * rates" — the price-honesty complement to totalUsdCents (Wave 2.2). */
	freeTierSavingsUsdCents: number | null;
}> {
	const user = await getCurrentUser();
	if (!user?.id) return emptyResult;

	if (scope.type === "user") {
		// A user may only read their own spend.
		if (scope.id !== user.id) return emptyResult;
	} else if (scope.type === "org") {
		// Org spend: caller must be owner or a member of that org.
		const [org] = await db()
			.select({ ownerId: organizations.ownerId })
			.from(organizations)
			.where(eq(organizations.id, scope.id as Organisation.OrganisationId))
			.limit(1);

		if (!org) return emptyResult;

		const isOrgOwner = org.ownerId === user.id;
		if (!isOrgOwner) {
			const [membership] = await db()
				.select({ id: organizationMembers.id })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.userId, user.id),
						eq(
							organizationMembers.organizationId,
							scope.id as Organisation.OrganisationId,
						),
					),
				)
				.limit(1);

			if (!membership) return emptyResult;
		}
	} else if (scope.type === "video") {
		// Video spend: caller must own the video.
		const [video] = await db()
			.select({ ownerId: videos.ownerId })
			.from(videos)
			.where(and(eq(videos.id, scope.id as Video.VideoId), isNull(videos.deletedAt)))
			.limit(1);

		if (!video || video.ownerId !== user.id) return emptyResult;
	}

	const billingMonth = currentBillingMonth();

	const colMap = {
		user: aiUsageEvents.userId,
		org: aiUsageEvents.orgId,
		video: aiUsageEvents.videoId,
	} as const;

	const col = colMap[scope.type];

	// A single video's cost panel must show its ALL-TIME spend — a video
	// recorded near a month boundary must never show "0 so'm" just because
	// most of its AI work landed in the previous billing month (Wave 2.2
	// price-honesty). User/org scopes stay month-scoped: those back the
	// monthly AI-budget cap cards, which are inherently a per-month figure.
	const monthFilter =
		scope.type === "video"
			? []
			: [eq(aiUsageEvents.billingMonth, billingMonth)];

	const rows = await db()
		.select({
			operation: aiUsageEvents.operation,
			totalMicros: sql<number>`COALESCE(SUM(${aiUsageEvents.costUsdMicros}), 0)`,
		})
		.from(aiUsageEvents)
		.where(and(sql`${col} = ${scope.id}`, ...monthFilter))
		.groupBy(aiUsageEvents.operation);

	let totalMicros = 0;
	const breakdown: Record<string, number> = {};

	// Do NOT round to whole cents here. Owner-reported 2026-08-16: the panel
	// showed 903 + 903 so'm against a total of 1 935 so'm — the parts summed to
	// LESS than the whole, which reads as a broken price. Cause: one cent is
	// ~129 so'm at the display rate, so rounding each operation to a whole cent
	// is a ~60 so'm error PER CARD, and the total rounds independently. On that
	// video: transcription 7.36c and summary 7.16c each rounded DOWN to 7 (903
	// so'm), while the total 14.52c rounded UP to 15 (1 935 so'm) — the missing
	// 129 so'm was exactly that one cent.
	//
	// Cents stay the unit of the returned contract (every consumer expects it),
	// but they are now FRACTIONAL: `formatUzs` already rounds once, at display,
	// so the cards add up to the total. Consumers checked before this change —
	// both AiBudgetCards (`.toFixed(2)` / formatUzs) and AiSpend handle a
	// fractional value correctly, and the cost GUARD does not read this function
	// at all (it has its own getMonthlySpendMicros in lib/ai-cost-guard.ts).
	for (const row of rows) {
		const micros = Number(row.totalMicros);
		breakdown[row.operation] = micros / 10_000;
		totalMicros += micros;
	}

	const totalUsdCents = totalMicros / 10_000;

	const capUsdCents: number | null = null;

	const percentUsed =
		capUsdCents != null && capUsdCents > 0
			? Math.round((totalUsdCents / capUsdCents) * 100)
			: 0;

	// Free-tier savings (video scope only): re-price this video's $0 events
	// (recorded with `costUsdMicros: 0` when withCostGuard's `free` option was
	// set — the "cheap" mode ladder) at the model's PAID rate, so the owner
	// sees what the run would have cost if it hadn't waited for free quota.
	// Embedding rows are excluded — those price at $0 unconditionally
	// (gemini-embedding-001 in the pricing table), so a $0 embedding event is
	// not a "savings", it is just how embeddings are priced.
	// These events don't record the audio/text token split, so — per the
	// price-honesty spec — every token is re-priced at the model's TEXT rate,
	// an intentional under-estimate for transcription (audio costs more per
	// token than text); the panel labels the figure "taxminan" (approximate)
	// for exactly this reason.
	let freeTierSavingsUsdCents: number | null = null;
	if (scope.type === "video") {
		const freeRows = await db()
			.select({
				model: aiUsageEvents.model,
				inputTokens: aiUsageEvents.inputTokens,
				outputTokens: aiUsageEvents.outputTokens,
			})
			.from(aiUsageEvents)
			.where(
				and(
					eq(aiUsageEvents.videoId, scope.id as Video.VideoId),
					eq(aiUsageEvents.costUsdMicros, 0),
					ne(aiUsageEvents.operation, "embedding"),
				),
			);

		let savingsMicros = 0;
		for (const row of freeRows) {
			savingsMicros += priceForMicros(row.model, {
				textInTokens: row.inputTokens,
				audioInTokens: 0,
				outputTokens: row.outputTokens,
			});
		}
		// Fractional for the same reason as the breakdown above: formatUzs is the
		// single rounding point.
		freeTierSavingsUsdCents = savingsMicros / 10_000;
	}

	return {
		totalUsdCents,
		breakdown,
		capUsdCents,
		percentUsed,
		freeTierSavingsUsdCents,
	};
}
