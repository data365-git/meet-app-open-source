"use client";

import { Card, CardDescription, CardTitle } from "@cap/ui";
import clsx from "clsx";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { updateOrganizationSettings } from "@/actions/organization/settings";
import { type AiSpeedMode, resolveAiSpeedMode } from "@/lib/ai-speed-mode";
import {
	canManageOrganizationSettings,
	getEffectiveOrganizationRole,
} from "@/lib/permissions/roles";
import { useDashboardContext } from "../../../Contexts";

export const AiSpeedModeCard = () => {
	const t = useTranslations("settings");
	const { activeOrganization, user, organizationSettings } =
		useDashboardContext();

	const currentMember = activeOrganization?.members.find(
		(member) => member.userId === user.id,
	);
	const currentRole = getEffectiveOrganizationRole({
		userId: user.id,
		ownerId: activeOrganization?.organization.ownerId,
		memberRole: currentMember?.role,
	});
	const isAdmin = canManageOrganizationSettings(currentRole);

	const [mode, setMode] = useState<AiSpeedMode>(
		resolveAiSpeedMode(organizationSettings?.aiSpeedMode),
	);
	const [saving, setSaving] = useState(false);

	if (!isAdmin) return null;

	const handleChange = async (next: AiSpeedMode) => {
		if (next === mode || saving) return;
		const previous = mode;
		setMode(next);
		setSaving(true);
		try {
			await updateOrganizationSettings({ aiSpeedMode: next });
			toast.success(t("aiSpeedSaved"));
		} catch {
			setMode(previous);
			toast.error(t("aiSpeedSaveError"));
		} finally {
			setSaving(false);
		}
	};

	const options: Array<{ value: AiSpeedMode; label: string }> = [
		{ value: "fast", label: t("aiSpeedFast") },
		{ value: "cheap", label: t("aiSpeedCheap") },
	];

	return (
		<Card className="flex flex-col gap-4">
			<div className="space-y-1">
				<CardTitle>{t("aiSpeedTitle")}</CardTitle>
				<CardDescription>{t("aiSpeedDescription")}</CardDescription>
			</div>

			<div
				role="radiogroup"
				aria-label={t("aiSpeedTitle")}
				className="flex flex-col gap-2 p-1 rounded-lg border bg-gray-1 border-gray-3 sm:flex-row"
			>
				{options.map((option) => {
					const selected = mode === option.value;
					return (
						<button
							key={option.value}
							type="button"
							role="radio"
							aria-checked={selected}
							disabled={saving}
							onClick={() => handleChange(option.value)}
							className={clsx(
								"flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors disabled:opacity-60",
								selected
									? "text-white bg-blue-11"
									: "text-gray-11 hover:bg-gray-3",
							)}
						>
							{option.label}
						</button>
					);
				})}
			</div>
		</Card>
	);
};
