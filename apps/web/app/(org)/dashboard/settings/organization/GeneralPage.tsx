"use client";

import { AiBudgetCard } from "./components/AiBudgetCard";
import { AiSpeedModeCard } from "./components/AiSpeedModeCard";
import DeleteOrg from "./components/DeleteOrg";
import { OrganizationDetailsCard } from "./components/OrganizationDetailsCard";

export function GeneralPage() {
	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-6 justify-center items-stretch xl:flex-row">
				<OrganizationDetailsCard />
				<AiBudgetCard />
			</div>
			<AiSpeedModeCard />
			<DeleteOrg />
		</div>
	);
}
