import { buildEnv } from "@cap/env";

// SECURITY (S1, 2026-07-21): cap.so / cap.link removed — this fork is
// self-hosted and does not control those domains. This list feeds
// HttpApiBuilder.middlewareCors({ allowedOrigins, credentials: true }) in
// lib/server.ts, so anything added here can read cookie-authenticated
// responses. Keep it a strict allowlist, never a wildcard.
export const allowedOrigins = [
	buildEnv.NEXT_PUBLIC_WEB_URL,
	"http://localhost:3001",
	"http://localhost:3000",
	"tauri://localhost",
	"http://tauri.localhost",
	"https://tauri.localhost",
];
