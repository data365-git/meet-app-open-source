"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { getStorageUsage } from "@/actions/organization/get-storage-usage";

function isStaleActionError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.message.includes("Failed to find Server Action") ||
		err.message.includes("was not found on the server") ||
		err.message.includes("older or newer deployment")
	);
}

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function StorageIndicator() {
	const t = useTranslations("nav");
	const { data, isLoading, error } = useQuery({
		queryKey: ["storage-usage"],
		queryFn: () => getStorageUsage(),
		staleTime: 60_000,
		retry: false,
	});

	useEffect(() => {
		if (isStaleActionError(error)) {
			const t = setTimeout(() => window.location.reload(), 1500);
			return () => clearTimeout(t);
		}
	}, [error]);

	if (isLoading) {
		return (
			<div className="block p-2.5 rounded-lg border border-gray-5 bg-gray-1">
				<div className="flex justify-between items-baseline mb-1">
					<span className="text-[11px] font-medium text-gray-11">
						{t("storage")}
					</span>
					<span className="h-3 w-16 rounded bg-gray-4 animate-pulse" />
				</div>
				<div className="h-1 w-full rounded-full bg-gray-4 animate-pulse" />
			</div>
		);
	}

	if (error || !data) {
		if (isStaleActionError(error)) {
			return (
				<div className="block p-2.5 rounded-lg border border-gray-5 bg-gray-1">
					<div className="text-[11px] font-medium text-gray-11 mb-1">
						{t("storage")}
					</div>
					<div className="text-xs text-gray-10">{t("storageUpdating")}</div>
				</div>
			);
		}
		return (
			<Link
				href="/dashboard/settings/storage"
				className="block p-2.5 rounded-lg border border-gray-5 bg-gray-1 hover:bg-gray-2"
			>
				<div className="text-[11px] font-medium text-gray-11 mb-1">
					{t("storage")}
				</div>
				<div className="text-xs text-gray-10">{t("storageLoadError")}</div>
			</Link>
		);
	}

	const pct = Math.min(100, data.percentUsed);
	const usedPct = pct < 0.5 ? 0 : pct;

	return (
		<Link
			href="/dashboard/settings/storage"
			className="block p-2.5 rounded-lg border border-gray-5 bg-gray-1 hover:bg-gray-2 transition-colors"
		>
			<div className="flex justify-between items-baseline mb-1">
				<span className="text-[11px] font-medium text-gray-11">
					{t("storage")}
				</span>
				<span className="text-[11px] font-medium tabular-nums text-gray-10">
					{fmtBytes(data.usedBytes)} / {fmtBytes(data.quotaBytes)}
				</span>
			</div>
			<div className="h-1 w-full rounded-full bg-gray-5 overflow-hidden">
				<div
					className="h-full rounded-full bg-[var(--brand)] transition-all"
					style={{ width: `${usedPct}%` }}
				/>
			</div>
			{/* Percent line only when it carries a WARNING — the bar + numbers
			    already say the rest. Saves a sidebar line (option-1 compacting). */}
			{pct >= 99 && (
				<p className="mt-1 text-[11px] text-red-10">{t("quotaFull")}</p>
			)}
		</Link>
	);
}
