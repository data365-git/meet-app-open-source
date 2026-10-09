/**
 * In-memory brute-force throttle for credentials login.
 *
 * Per-instance by design (single-container deployment today): after
 * MAX_FAILURES failed attempts for the same email within WINDOW_MS, further
 * attempts are rejected until the window slides. Successful login clears the
 * email's history. DB outages must NOT count as failures — only a genuinely
 * wrong password / unknown user records one.
 */

export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 5 * 60 * 1000;

const failures = new Map<string, number[]>();

/** Pure decision: given past failure timestamps, is another attempt allowed? */
export function isLoginAllowed(
	timestamps: number[],
	now: number,
	max: number = LOGIN_MAX_FAILURES,
	windowMs: number = LOGIN_WINDOW_MS,
): boolean {
	const cutoff = now - windowMs;
	let recent = 0;
	for (const t of timestamps) if (t > cutoff) recent++;
	return recent < max;
}

export function checkLoginAllowed(email: string, now = Date.now()): boolean {
	const list = failures.get(email);
	if (!list) return true;
	// Prune while we're here so the map can't grow unboundedly.
	const cutoff = now - LOGIN_WINDOW_MS;
	const recent = list.filter((t) => t > cutoff);
	if (recent.length === 0) failures.delete(email);
	else failures.set(email, recent);
	return isLoginAllowed(recent, now);
}

export function recordLoginFailure(email: string, now = Date.now()): void {
	const list = failures.get(email) ?? [];
	list.push(now);
	failures.set(email, list);
}

export function clearLoginFailures(email: string): void {
	failures.delete(email);
}
