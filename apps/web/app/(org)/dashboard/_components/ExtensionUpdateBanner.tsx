"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

const DISMISS_KEY = "data365-ext-reinstall-v1-dismissed";

export default function ExtensionUpdateBanner() {
	const t = useTranslations("extensionBanner");
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		try {
			if (localStorage.getItem(DISMISS_KEY) !== "true") {
				setVisible(true);
			}
		} catch {
			// localStorage unavailable (e.g. private browsing with blocked storage)
		}
	}, []);

	if (!visible) return null;

	function dismiss() {
		try {
			localStorage.setItem(DISMISS_KEY, "true");
		} catch {
			// ignore
		}
		setVisible(false);
	}

	return (
		<div className="flex w-full items-start gap-2 border-b border-gray-4 bg-gray-3 px-3 py-2 text-sm text-gray-12 sm:items-center sm:gap-3 sm:px-4 sm:py-2.5">
			<p className="min-w-0 flex-1 text-xs leading-5 text-gray-11 sm:text-sm">
				<span className="font-medium text-gray-12">{t("title")}</span>{" "}
				<span className="ml-1 hidden sm:inline">{t("bodyFull")}</span>
				<span className="ml-1 sm:hidden">{t("bodyShort")}</span>
			</p>
			<div className="flex shrink-0 items-center gap-1.5">
				<Link
					href="/dashboard/extension"
					className="inline-flex min-h-9 items-center rounded-full bg-[var(--brand)] px-3 text-xs font-medium text-[var(--brand-fg)] transition-colors hover:brightness-95 sm:min-h-0 sm:bg-transparent sm:p-0 sm:text-sm sm:text-[var(--brand)] sm:underline sm:underline-offset-2 sm:hover:bg-transparent sm:hover:text-[var(--brand)]"
				>
					{t("updateCta")}
				</Link>
				<button
					type="button"
					onClick={dismiss}
					aria-label={t("dismissAria")}
					className="inline-flex size-9 flex-shrink-0 items-center justify-center rounded-full text-gray-9 transition-colors hover:bg-gray-4 hover:text-gray-12"
				>
					<X size={16} aria-hidden="true" />
					<span className="sr-only">Close</span>
				</button>
			</div>
		</div>
	);
}
