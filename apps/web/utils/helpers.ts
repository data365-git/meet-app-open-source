import { buildEnv } from "@cap/env";
import { type ClassValue, clsx } from "clsx";
import type { ReadonlyHeaders } from "next/dist/server/web/spec-extension/adapters/headers";
import type { NextRequest } from "next/server";
import { twMerge } from "tailwind-merge";

export function classNames(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

// Strict allowlist for credentialed cross-origin requests.
// SECURITY (S1, 2026-07-21): do NOT reflect arbitrary origins here — a
// previous version echoed any `origin` back with
// Access-Control-Allow-Credentials: true, letting any site read
// cookie-authenticated responses. Only echo an origin that is in this list.
export const allowedOrigins = [
	buildEnv.NEXT_PUBLIC_WEB_URL,
	"http://localhost:3001",
	"http://localhost:3000",
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
];

export function getHeaders(origin: string | null): Record<string, string> {
	const baseHeaders: Record<string, string> = {
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization",
	};

	// Only echo the origin (and allow credentials) if it's allowlisted.
	// Non-allowlisted origins get no Access-Control-Allow-Origin at all, so
	// the browser blocks the cross-origin read.
	if (origin && allowedOrigins.includes(origin)) {
		return {
			...baseHeaders,
			"Access-Control-Allow-Origin": origin,
			"Access-Control-Allow-Credentials": "true",
		};
	}

	return baseHeaders;
}

const rateLimitMap = new Map();

export function rateLimitMiddleware(
	limit: number,
	request: NextRequest | Promise<Response>,
	headersList: ReadonlyHeaders,
) {
	const ip = headersList.get("x-forwarded-for");
	const windowMs = 60 * 1000;

	if (!rateLimitMap.has(ip)) {
		rateLimitMap.set(ip, {
			count: 0,
			lastReset: Date.now(),
		});
	}

	const ipData = rateLimitMap.get(ip) as {
		count: number;
		lastReset: number;
	};

	if (Date.now() - ipData.lastReset > windowMs) {
		ipData.count = 0;
		ipData.lastReset = Date.now();
	}

	if (ipData.count >= limit) {
		return new Response("Too many requests", {
			status: 429,
		});
	}

	ipData.count += 1;

	return request;
}

export const CACHE_CONTROL_HEADERS = {
	"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
	Pragma: "no-cache",
	Expires: "0",
};
