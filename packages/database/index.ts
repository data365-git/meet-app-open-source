import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { sql } from "drizzle-orm";
import type { AnyMySqlColumn } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2/promise";

function createDrizzle() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL not found");

	if (!url.startsWith("mysql://"))
		throw new Error("DATABASE_URL is not a MySQL URL");

	// Explicit pool, not a bare URL: the memoized single connection never
	// auto-reconnected, so once it dropped (idle timeout, DB restart, network
	// blip) EVERY query on this instance failed until redeploy — surfacing as
	// intermittent "wrong password" logins and random 500s. A pool replaces
	// dead connections transparently and handles concurrent queries.
	const pool = createPool({
		uri: url,
		connectionLimit: 10,
		maxIdle: 10,
		idleTimeout: 60_000,
		enableKeepAlive: true,
	});
	return drizzle(pool);
}

let _cached: ReturnType<typeof createDrizzle> | undefined;

export const db = () => {
	if (!_cached) {
		_cached = createDrizzle();

		instrumentDrizzleClient(_cached);
	}
	return _cached;
};

// Use the incoming value if one exists, else fallback to the DBs existing value.
export const updateIfDefined = <T>(v: T | undefined, col: AnyMySqlColumn) =>
	sql`COALESCE(${v === undefined ? sql`NULL` : v}, ${col})`;
