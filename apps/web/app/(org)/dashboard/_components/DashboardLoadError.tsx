"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { EmptyState } from "@/components/EmptyState";

export default function DashboardLoadError() {
	const t = useTranslations("dashboardLoadError");

	return (
		<div className="flex justify-center items-center w-full h-screen bg-gray-2">
			<EmptyState
				icon={<AlertTriangle className="size-8 text-gray-10" />}
				title={t("title")}
				description={t("body")}
				actionLabel={t("retry")}
				onAction={() => window.location.reload()}
			/>
		</div>
	);
}
