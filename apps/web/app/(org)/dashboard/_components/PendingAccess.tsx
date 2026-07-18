"use client";

import { Button, LogoBadge } from "@cap/ui";
import { signOut } from "next-auth/react";
import { useTranslations } from "next-intl";

export default function PendingAccess() {
	const t = useTranslations("pendingAccess");

	return (
		<div className="flex justify-center items-center w-full h-screen bg-gray-2">
			<div className="w-[calc(100%-5%)] p-[28px] max-w-[432px] bg-gray-3 border border-gray-5 rounded-2xl text-center">
				<LogoBadge className="size-12 mx-auto" />
				<h1 className="text-xl font-semibold text-gray-12 mt-7 mb-2">
					{t("title")}
				</h1>
				<p className="text-gray-10">{t("body")}</p>
				<p className="text-gray-10 mt-3 text-sm">{t("contact")}</p>
				<Button
					variant="gray"
					size="sm"
					className="mt-6"
					onClick={() => signOut()}
				>
					{t("signOut")}
				</Button>
			</div>
		</div>
	);
}
