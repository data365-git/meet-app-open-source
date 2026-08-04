import "@/app/globals.css";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";

// The theme decision MUST run before the first paint, or the page renders light
// and only turns dark once the script finally executes — exactly what the owner
// hit ("dark mode didn't work until I reloaded"). Measured on the live build:
// next/script beforeInteractive emitted only a <link rel=preload> into <head>
// and pushed the real execution into <body> via Next's deferred loader, after
// hydration. A cached reload then ran it early enough to look correct, which is
// what made the bug read as intermittent rather than constant.
//
// Read the ONE source file at module scope and inline it: no second copy of the
// logic to drift, and no network fetch to wait on. If the read ever fails, emit
// nothing rather than a half-applied theme — the page still works, it just does
// not pre-theme, and that is a visible-but-safe degradation.
let INLINE_THEME_SCRIPT = "";
try {
	INLINE_THEME_SCRIPT = readFileSync(
		join(process.cwd(), "public", "theme-script.js"),
		"utf8",
	);
} catch {
	INLINE_THEME_SCRIPT = "";
}
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import type { PropsWithChildren } from "react";

export const metadata: Metadata = {
	metadataBase: new URL(process.env.NEXT_PUBLIC_WEB_URL ?? process.env.WEB_URL ?? "https://data365.uz"),
	title: "data365",
	description: "data365 — uchrashuv yozuvlari va AI tahlil platformasi",
	openGraph: {
		title: "data365",
		description: "data365 — uchrashuv yozuvlari va AI tahlil platformasi",
		type: "website",
		url: process.env.NEXT_PUBLIC_WEB_URL ?? "https://data365.uz",
		siteName: "data365",
	},
};

export default async function RootLayout({ children }: PropsWithChildren) {
	const locale = await getLocale();
	const messages = await getMessages();

	return (
		<html className={GeistSans.className} lang={locale}>
			<head>
				<link
					rel="apple-touch-icon"
					sizes="180x180"
					href="/apple-touch-icon.png"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="32x32"
					href="/favicon-32x32.png"
				/>
				<link
					rel="icon"
					type="image/png"
					sizes="16x16"
					href="/favicon-16x16.png"
				/>
				<link rel="manifest" href="/site.webmanifest" />
				<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#005cb1" />
				<link rel="shortcut icon" href="/favicon.ico" />
				<meta name="msapplication-TileColor" content="#005cb1" />
				<meta name="theme-color" content="#ffffff" />
				{INLINE_THEME_SCRIPT ? (
					// Plain synchronous <script> in <head>: it executes before the
					// body is painted. next/script cannot be used here — that is
					// what deferred it into <body> and caused the light-then-dark
					// flash. biome-ignore lint/security/noDangerouslySetInnerHtml:
					// the content is our own repo file, never user input.
					<script
						// biome-ignore lint/security/noDangerouslySetInnerHtml: own repo file
						dangerouslySetInnerHTML={{ __html: INLINE_THEME_SCRIPT }}
					/>
				) : null}
			</head>
			<body suppressHydrationWarning>
				<NextIntlClientProvider locale={locale} messages={messages}>
					<main className="w-full">{children}</main>
				</NextIntlClientProvider>
			</body>
		</html>
	);
}
