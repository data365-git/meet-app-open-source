import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export const metadata: Metadata = {
	title: "Browser Extension — data365",
};

export default async function ExtensionPage() {
	const t = await getTranslations("extension");

	const richValues = {
		b: (c: React.ReactNode) => (
			<span className="font-semibold text-gray-12">{c}</span>
		),
		code: (c: React.ReactNode) => (
			<code className="rounded border border-gray-5 bg-gray-3 px-1.5 py-0.5 text-xs font-mono text-gray-12">
				{c}
			</code>
		),
	};

	return (
		<div className="flex flex-col w-full h-full">
			<div className="flex flex-wrap gap-3 items-center mb-10 w-full">
				<div>
					<p className="mt-1 text-gray-10 text-md">{t("intro")}</p>
				</div>
			</div>

			<div className="max-w-lg">
				<a
					href="/365-extension.zip"
					download
					className="inline-flex items-center gap-2 rounded-lg bg-[var(--brand)] px-5 py-2.5 text-sm font-semibold text-[var(--brand-fg)] transition-colors hover:brightness-95"
				>
					<svg
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						strokeLinecap="round"
						strokeLinejoin="round"
						className="size-4"
						aria-hidden="true"
					>
						<path d="M12 3v13M5 14l7 7 7-7" />
						<path d="M3 21h18" />
					</svg>
					{t("download")}
				</a>

				<ol className="mt-8 flex flex-col gap-4">
					{[
						t.rich("step1", richValues),
						t.rich("step2", richValues),
						t.rich("step3", richValues),
						t.rich("step4", richValues),
						t("step5"),
						t.rich("step6", richValues),
					].map((step, i) => (
						<li key={i} className="flex gap-4 items-start">
							<span className="flex-shrink-0 flex items-center justify-center size-7 rounded-full bg-[var(--brand)] text-[var(--brand-fg)] text-sm font-bold">
								{i + 1}
							</span>
							<p className="text-sm text-gray-11 pt-1">{step}</p>
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}
