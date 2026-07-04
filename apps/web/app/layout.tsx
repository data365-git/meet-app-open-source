import "@/app/globals.css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import Script from "next/script";
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
			</head>
			<body suppressHydrationWarning>
				<Script src="/theme-script.js" strategy="beforeInteractive" />
				<NextIntlClientProvider locale={locale} messages={messages}>
					<main className="w-full">{children}</main>
				</NextIntlClientProvider>
			</body>
		</html>
	);
}
