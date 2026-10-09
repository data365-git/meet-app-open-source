"use client";

import clsx from "clsx";
import { BarChart3, Settings, UsersRound, Video } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const MobileTab = () => {
	const pathname = usePathname();
	const t = useTranslations("nav");
	const tabs = [
		{
			label: t("instructions"),
			href: "/dashboard/caps",
			icon: Video,
			matchChildren: true,
		},
		{
			label: t("meetingRecordings"),
			href: "/dashboard/meetings",
			icon: UsersRound,
			matchChildren: true,
		},
		{
			label: t("analytics"),
			href: "/dashboard/analytics",
			icon: BarChart3,
			matchChildren: true,
		},
		{
			label: t("profile"),
			href: "/dashboard/settings/account",
			icon: Settings,
			matchChildren: false,
		},
	];

	const isActive = (href: string, matchChildren: boolean) =>
		matchChildren
			? pathname === href || pathname.startsWith(`${href}/`)
			: pathname === href;

	return (
		<nav className="sticky bottom-0 z-50 grid h-[calc(4.25rem+env(safe-area-inset-bottom,0px))] min-h-[68px] w-full grid-cols-4 items-stretch border-t border-gray-5 bg-gray-1 px-2 pb-[env(safe-area-inset-bottom,0px)] lg:hidden">
			{tabs.map((tab) => {
				const Icon = tab.icon;
				const active = isActive(tab.href, tab.matchChildren);

				return (
					<Link
						href={tab.href}
						key={tab.href}
						aria-current={active ? "page" : undefined}
						className={clsx(
							"flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10px] font-medium transition-colors",
							active
								? "text-[var(--brand)]"
								: "text-gray-10 hover:text-gray-12",
						)}
					>
						<Icon className="size-[22px]" aria-hidden="true" />
						<span className="max-w-full truncate">{tab.label}</span>
					</Link>
				);
			})}
		</nav>
	);
};

export default MobileTab;
