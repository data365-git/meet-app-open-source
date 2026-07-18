import("dotenv").then(({ config }) => config({ path: "../../.env" }));

import fs from "node:fs";
import path from "node:path";
import createNextIntlPlugin from "next-intl/plugin";
import workflowNext from "workflow/next";

const { withWorkflow } = workflowNext;
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const packageJson = JSON.parse(
	fs.readFileSync(path.resolve("./package.json"), "utf8"),
);
const { version } = packageJson;

const fallbackWebUrl = "https://web-production-e6fe4.up.railway.app";
const configuredWebUrl =
	[process.env.WEB_URL, process.env.NEXT_PUBLIC_WEB_URL, fallbackWebUrl]
		.map((value) => value?.trim())
		.find(Boolean) ?? fallbackWebUrl;

function getHostWithOptionalPort(value) {
	try {
		return new URL(value.includes("://") ? value : `https://${value}`).host;
	} catch {
		return value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	}
}

const serverActionAllowedOrigins = Array.from(
	new Set(
		[
			getHostWithOptionalPort(configuredWebUrl),
			getHostWithOptionalPort(fallbackWebUrl),
			"localhost:3000",
			"localhost:3001",
		].filter(Boolean),
	),
);

const ffmpegTracingIncludes = [
	"./node_modules/ffmpeg-static/ffmpeg",
	"./node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
];

const nextConfig = {
	reactStrictMode: true,
	serverExternalPackages: ["ffmpeg-static", "prettier"],
	outputFileTracingIncludes: {
		"/.well-known/workflow/v1/step": ffmpegTracingIncludes,
	},
	transpilePackages: [
		"@cap/ui",
		"@cap/utils",
		"@cap/web-api-contract",
		"@cap/web-domain",
		"@cap/env",
		"@cap/database",
		"next-mdx-remote",
	],
	typescript: {
		// Kept TRUE on purpose: the codebase imports with explicit `.ts` extensions
		// (e.g. `from "../helpers.ts"`), which `next build`'s type-check rejects
		// (allowImportingTsExtensions). Type safety IS enforced separately by the
		// root `tsc -b` gate (green). Flipping this to false only breaks the build
		// for no added safety. To flip it, first drop `.ts` extensions repo-wide.
		ignoreBuildErrors: true,
	},
	experimental: {
		optimizePackageImports: [
			"@cap/ui",
			"@cap/utils",
			"lucide-react",
			"framer-motion",
			"motion",
			"@fortawesome/free-solid-svg-icons",
			"@fortawesome/free-brands-svg-icons",
			"@tanstack/react-query",
			"recharts",
			"@radix-ui/react-dialog",
			"@radix-ui/react-dropdown-menu",
			"@radix-ui/react-popover",
			"@radix-ui/react-select",
			"@radix-ui/react-slider",
			"@radix-ui/react-tooltip",
			"date-fns",
		],
		turbopackFileSystemCacheForDev: true,
		serverActions: {
			allowedOrigins: serverActionAllowedOrigins,
		},
	},
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "**",
				port: "",
				pathname: "**",
			},
			{
				protocol: "https",
				hostname: "l.cap.so",
				port: "",
				pathname: "**",
			},
			process.env.NODE_ENV === "development" && {
				protocol: "http",
				hostname: "localhost",
				port: "9000",
				pathname: "**",
			},
		].filter(Boolean),
	},
	async headers() {
		return [
			{
				source: "/dashboard/:path*",
				headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
			},
			{
				// Baseline headers, safe on every route including /embed and /api.
				source: "/:path*",
				headers: [
					// Deliberately short + no includeSubDomains/preload. HSTS is sticky
					// per-host in the browser, so a lapsed cert on the self-hosted box
					// would hard-lock users out for the whole max-age with no
					// click-through. Ramp to 1 week -> 6 months -> 1 year only once cert
					// renewal has proven itself over several cycles. Never add `preload`:
					// it is effectively irreversible and would bake a throwaway hostname
					// into browsers permanently.
					{ key: "Strict-Transport-Security", value: "max-age=86400" },
					{ key: "X-Content-Type-Options", value: "nosniff" },
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
					// Denies ONLY features this app never uses. camera/microphone/
					// display-capture are deliberately omitted so they keep their default
					// `self` allowlist — the web recorder needs them and denying them
					// breaks recording with no error that points back here. autoplay and
					// fullscreen are omitted for the same reason on the video player.
					{
						key: "Permissions-Policy",
						value:
							"geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), idle-detection=(), browsing-topics=()",
					},
				],
			},
			{
				// Clickjacking protection everywhere EXCEPT the routes that are meant to
				// be embedded (/embed, /s, /c) and /login, whose frame policy is already
				// owned by proxy.ts — browsers intersect multiple CSP headers, so adding
				// frame-ancestors here would silently override that.
				source: "/:path((?!embed/|s/|c/|login).*)",
				headers: [
					{ key: "X-Frame-Options", value: "SAMEORIGIN" },
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'self'",
					},
				],
			},
		];
	},
	async rewrites() {
		return [
			{
				source: "/r/:path*",
				destination: "https://dub.cap.link/:path*",
			},
			{
				source: "/api/commercial/:path*",
				destination: "https://l.cap.so/api/commercial/:path*",
			},
			{
				source: "/s/:videoId",
				destination: "/s/:videoId",
				has: [
					{
						type: "host",
						value: "(?!cap.so|cap.link).*",
					},
				],
			},
			{
				source: "/c/:collectionId",
				destination: "/c/:collectionId",
				has: [
					{
						type: "host",
						value: "(?!cap.so|cap.link).*",
					},
				],
			},
		];
	},
	async redirects() {
		return [
			{
				source: "/roadmap",
				destination:
					"https://capso.notion.site/7aac740edeee49b5a23be901a7cb734e?v=9d4a3bf3d72d488cad9b899ab73116a1",
				permanent: true,
			},
			{
				source: "/updates",
				destination: "/blog",
				permanent: true,
			},
			{
				source: "/updates/:slug",
				destination: "/blog/:slug",
				permanent: true,
			},
			{
				source: "/docs/s3-config",
				destination: "/docs",
				permanent: true,
			},
		];
	},
	env: {
		appVersion: version,
	},
	output:
		process.env.NEXT_PUBLIC_DOCKER_BUILD === "true" ? "standalone" : undefined,
};

// Workflow plugin disabled — transcription/AI generation runs inline as
// fire-and-forget from lib/transcribe.ts and lib/generate-ai.ts.
export default withNextIntl(nextConfig);
