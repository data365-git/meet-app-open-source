/**
 * How many rows did a drizzle/mysql2 write actually touch?
 *
 * mysql2 hands drizzle a `[ResultSetHeader, FieldPacket[]]` tuple, but a few
 * call sites see the bare header, so both shapes are read. Anything else
 * (including a test double that resolves `[]`) counts as ZERO — a conditional
 * write whose result cannot be read must never be treated as "it won", because
 * every caller here uses the count to decide whether it owns the job.
 */
export function getAffectedRows(result: unknown): number {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}

	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
}
