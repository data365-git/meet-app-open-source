import { getFreeQuotaStatus } from "@/lib/free-quota-meter";
import { getOpenRouterBalance } from "@/lib/openrouter-balance";

/**
 * Admin-only status line at the top of the dashboard: is the FREE Gemini key
 * working (or did its daily quota end), how many free requests were made
 * today (OUR count — Google exposes no remaining-quota API, so there is
 * never a "remaining N" number), and the exact OpenRouter balance.
 *
 * Rendered inside <Suspense fallback={null}> by the dashboard layout so it
 * can never delay the page, and every failure inside renders nothing.
 */

const tashkentTimeFormatter = new Intl.DateTimeFormat("en-GB", {
	timeZone: "Asia/Tashkent",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});
// en-CA yields ISO-like "YYYY-MM-DD".
const tashkentDayFormatter = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Asia/Tashkent",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
});

/** "12:00" in Tashkent time, prefixed with "ertaga " when the reset lands on
 * a later Tashkent calendar day than `now` (e.g. a late-evening PT reset). */
export function formatResetAtTashkent(resetAt: Date, now: Date): string {
	const time = tashkentTimeFormatter.format(resetAt);
	const isLaterDay =
		tashkentDayFormatter.format(resetAt) !== tashkentDayFormatter.format(now);
	return isLaterDay ? `ertaga ${time}` : time;
}

/** Pure text builder for the badge line — exported for tests. The rendered
 * line reads: Bepul AI: {status} · {detail} · OpenRouter: {balance} */
export function buildAiQuotaStatusText(input: {
	requestsToday: number;
	exhausted: boolean;
	/** Daily limit hit on SOME models but not all - quotas are per model. */
	partial?: boolean;
	resetAt: Date;
	balance: number | null;
	now?: Date;
}): { status: string; detail: string; balance: string } {
	const now = input.now ?? new Date();
	const time = formatResetAtTashkent(input.resetAt, now);
	return {
		status: input.exhausted
			? input.partial
				? "ayrim modellarda limit tugadi"
				: "kunlik limit tugadi"
			: "ishlayapti",
		detail: input.exhausted
			? `${time} da tiklanadi`
			: `bugun ${input.requestsToday} so'rov · yangilanadi ${time}`,
		balance:
			input.balance === null ? "—" : `$${input.balance.toFixed(2)}`,
	};
}

export default async function AiQuotaStatus() {
	try {
		const now = new Date();
		const [quota, balance] = await Promise.all([
			getFreeQuotaStatus(now),
			getOpenRouterBalance(),
		]);

		const exhausted = quota.exhaustedModels.length > 0;
		const text = buildAiQuotaStatusText({
			requestsToday: quota.requestsToday,
			exhausted,
			partial: exhausted && quota.exhaustedModels.length < quota.perModel.length,
			resetAt: quota.resetAt,
			balance,
			now,
		});
		const balanceIsLow = balance !== null && balance < 1;
		const warnClass = "font-medium text-amber-11";

		return (
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 w-full min-w-0 text-xs text-gray-10">
				<p className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
					<span>Bepul AI:</span>
					<span className={exhausted ? warnClass : undefined}>
						{text.status}
					</span>
					<span aria-hidden="true">·</span>
					<span>{text.detail}</span>
					<span aria-hidden="true">·</span>
					<span>OpenRouter:</span>
					<span className={balanceIsLow ? warnClass : undefined}>
						{text.balance}
					</span>
				</p>
				{quota.perModel.length > 0 ? (
					<details className="min-w-0">
						<summary className="cursor-pointer list-none">
							batafsil
						</summary>
						<div className="flex flex-col gap-0.5 pt-1">
							{quota.perModel.map((row) => (
								<span key={row.model}>
									{row.model}: {row.requests} so'rov
									{row.exhausted ? " · kunlik limit tugadi" : ""}
								</span>
							))}
						</div>
					</details>
				) : null}
			</div>
		);
	} catch {
		// A badge must never break or delay the dashboard.
		return null;
	}
}
